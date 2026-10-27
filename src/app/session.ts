/**
 * 平台会话（应用编排层）
 *
 * 职责：一条出站长连接的生命周期 —— 上报初值、路由平台指令、维护在跑任务表。
 * 它**不知道**自己在 CLI 里还是被控制面板驱动：输出全走注入的 `log`，上行全走 `Emitter`。
 *
 * 指令路由只做分发，具体动作在 `task-dispatch.ts`；扫描/取消这类短逻辑就地处理（不值得再开文件）。
 */

import { Emitter } from '../core/emitter.js';
import { scanAgents } from '../core/scan.js';
import { defaultSupervisor } from '../core/task-supervisor.js';
import type { PermissionPolicyName } from '../core/permission-policy.js';
import type { TaskRegistry } from './task-registry.js';
import {
  assertServerMessage,
  ProtocolError,
  type ClientMessage,
  type InteractionResponseCommand,
  type SnapshotPartialMessage,
} from '../protocol.js';
import type { TaskHandle } from '../runner.js';
import { createBridgeClient } from '../transport/bridge-client.js';
import type { SessionLog } from './session-log.js';
import {
  dispatchCancelTask,
  dispatchCancelTurn,
  dispatchCloseSession,
  dispatchGetArtifact,
  dispatchGetTask,
  dispatchInteractionResponse,
  dispatchRunTask,
  type InteractionOutcome,
} from './task-dispatch.js';
import { dispatchConversationMessage } from './conversation.js';
import type { ClaudeResident } from './claude-resident.js';
import { authorizeService } from './service-gate.js';
import { DEFAULT_TENANT, type SessionStore } from '../core/session-store.js';
import { DEFAULT_APPROVAL_TTL_MS } from '../core/permission-ledger.js';
import { ArtifactTransferManager } from '../core/artifact-transfer.js';
import { InteractionUrlVault } from '../core/interaction-url.js';
import { DEFAULT_INTERACTION_TIMEOUT_MS, DEFAULT_MAX_INTERACTIONS_PER_TASK } from '../infra/config.js';

export interface SessionOptions {
  platformUrl: string;
  deviceToken: string;
  deviceId: string;
  /** 可选：4201/4403 时用于刷新设备凭证 */
  refresh?: () => Promise<{ deviceToken: string; refreshToken?: string }>;
  onTokenRefreshed?: (tokens: { deviceToken: string; refreshToken?: string }) => void;
  cliVersion: string;
  hostname: string;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  /** 平台未指定 captureDiff 时的本地默认（config.toml 的 diff_default） */
  captureDiffByDefault: boolean;
  requireServiceToken: boolean;
  /** 本机权限策略（1.0；缺省 default） */
  permissionPolicy?: PermissionPolicyName;
  /** 本机是否声明 CodeBuddy full 运行在外部沙箱内 */
  externalSandbox?: boolean;
  /** 是否开放交互（1.0，缺省 false） */
  interactionEnabled?: boolean;
  /** 单次交互等待上限（毫秒） */
  interactionTimeoutMs?: number;
  /** 单任务交互次数上限 */
  maxInteractionsPerTask?: number;
  /** 是否启用持久授权账本（1.0，缺省 false） */
  approvalLedgerEnabled?: boolean;
  /** 持久授权有效期（毫秒） */
  approvalTtlMs?: number;
  /** waiting_user 空闲关闭（0 = 关闭） */
  sessionIdleMs: number;
  /** 任务注册表（面板/台账共用视图；由 bootstrap 创建） */
  registry: TaskRegistry;
  /** 持久 Session/Turn/Event 权威源；由 bootstrap 创建并在 close 时关闭 */
  store: SessionStore;
  /** 入站附件 CAS 根目录 */
  artifactRootDir: string;
  log: SessionLog;
}

export interface BridgeSession {
  close: () => void;
  isConnected: () => boolean;
  /** 唯一上行出口（本地控制面订阅它看全部任务事件，不另开出口） */
  readonly emitter: Emitter;
  /** 任务注册表（终端面板 / 控制面台账的共享视图） */
  readonly registry: TaskRegistry;
  /** 持久 Session/Turn/Event 权威源（控制面只读查询用） */
  readonly store: SessionStore;
  /** 附件传输与 TTL 管理（控制面管理接口用） */
  readonly artifacts: ArtifactTransferManager;
  /** 按租户取附件管理器（控制面 JWT 隔离；缺省租户复用 artifacts） */
  artifactsForTenant: (tenantId: string) => ArtifactTransferManager;
  /** 交互短期 URL（仅进程内，不落盘） */
  readonly urls: InteractionUrlVault;
  /** 在跑/排队的任务数（状态展示与控制面用） */
  activeTasks: () => number;
  /** 取消指定任务（无此任务返回 false） */
  cancelTask: (taskId: string) => boolean;
  /**
   * 响应一次交互（1.0 HTTP 通道入口）。
   *
   * 与 WS 的 `task_interaction_response` 走**同一个** `dispatchInteractionResponse`：
   * 同样的 scope 判定、同样的 Form 校验、同样的账本写入与审计。返回客观结果，
   * 让 HTTP 层能把 `insufficient_scope` / `interaction_not_found` 映射成状态码，
   * 而不是回读 SQLite 猜（鉴权失败不落库，回读会误判成 pending）。
   */
  respondInteraction: (msg: InteractionResponseCommand) => InteractionOutcome;
  /**
   * 半截消息读取（1.0）：`task_snapshot.partialMessages` 与 HTTP 快照共用的同一个源，
   * 避免「本地面板能看到正在写的半句、远程平台看不到」。
   */
  partialMessages: (taskId: string) => SnapshotPartialMessage[];
}

export function createSession(opts: SessionOptions): BridgeSession {
  const tasks = new Map<string, TaskHandle>();
  /**
   * 常驻会话与空闲计时器必须挂在**会话级**，不能写在每条报文的 dispatchOpts 字面量里：
   * 那样每个回合都会拿到一张新 Map，`residentSessions.get()` 永远 miss ——
   * Claude/Qoder 的常驻进程复用形同虚设，每回合都重新拉起一个进程。
   */
  const residentSessions = new Map<string, ClaudeResident>();
  const idleTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 任务调度的公共依赖。抽成函数是为了**两条通道共用同一份规则**：
   * WS 的 `task_interaction_response` 与 HTTP 的 `POST /v1/interactions/{id}:respond`
   * 如果各拼一份选项，鉴权/账本/审计迟早会漂。
   */
  const dispatchOptions = (em: Emitter) => ({
    emitter: em,
    tasks,
    registry: opts.registry,
    allowedCwd: opts.allowedCwd,
    maxConcurrent: opts.maxConcurrent,
    maxQueued: opts.maxQueued,
    diffMaxBytes: opts.diffMaxBytes,
    captureDiffByDefault: opts.captureDiffByDefault,
    requireServiceToken: opts.requireServiceToken,
    permissionPolicy: opts.permissionPolicy,
    externalSandbox: opts.externalSandbox,
    interactionEnabled: opts.interactionEnabled === true,
    interactionTimeoutMs: opts.interactionTimeoutMs,
    maxInteractionsPerTask: opts.maxInteractionsPerTask,
    // 持久授权账本（1.0）：默认关闭时 enabled=false，dispatch 侧既不查也不写
    approvalLedger: {
      enabled: opts.approvalLedgerEnabled === true,
      tenantId: DEFAULT_TENANT,
      ttlMs: opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
    },
    artifactRootDir: opts.artifactRootDir,
    store: opts.store,
    log: opts.log,
    residentSessions,
    idleTimeoutMs: opts.sessionIdleMs,
    idleTimers,
    // 半截消息的唯一真源是 supervisor 实例（三条流式通道都汇到那儿），这里只做读取转发
    partialMessages: (taskId: string) => defaultSupervisor.listPartialMessages(taskId),
  });
  // client 的 onOpen/onMessage 里要用到 emitter，而 emitter 又要用到 client.send ——
  // 互相依赖只能在"连接建立后才会回调"这个前提下用后赋值解决（与实现顺序无关，回调天然晚于同步构造）
  let emitter: Emitter | undefined;
  const artifacts = new ArtifactTransferManager({
    store: opts.store,
    emit: (msg) => emitter?.emit(msg),
    rootDir: opts.artifactRootDir,
  });
  const artifactsByTenant = new Map<string, ArtifactTransferManager>();
  const artifactsForTenant = (tenantId: string): ArtifactTransferManager => {
    if (tenantId === 'default') return artifacts;
    const cached = artifactsByTenant.get(tenantId);
    if (cached) return cached;
    const manager = new ArtifactTransferManager({
      store: opts.store,
      emit: (msg) => emitter?.emit(msg),
      rootDir: opts.artifactRootDir,
      tenantId,
    });
    artifactsByTenant.set(tenantId, manager);
    return manager;
  };
  const urls = new InteractionUrlVault();
  try {
    const stale = artifacts.cleanupStaleTransfers();
    if (stale > 0) opts.log('info', `[agent-bridge] 已回收 ${stale} 个超时未完成的附件上传`);
  } catch (error) {
    opts.log('error', `[agent-bridge] 附件上传 GC 失败：${(error as Error).message}`);
  }

  const now = (): string => new Date().toISOString();

  const client = createBridgeClient({
    platformUrl: opts.platformUrl,
    deviceToken: opts.deviceToken,
    deviceId: opts.deviceId,
    refresh: opts.refresh,
    onTokenRefreshed: opts.onTokenRefreshed,
    cliVersion: opts.cliVersion,
    hostname: opts.hostname,
    capacity: { maxTasks: opts.maxConcurrent, maxQueued: opts.maxQueued },
    // 执行侧策略如实上报：平台据此决定能不能请求 full、要不要等交互
    execution: {
      permissionPolicy: opts.permissionPolicy ?? 'default',
      externalSandbox: opts.externalSandbox === true,
      interactionEnabled: opts.interactionEnabled === true,
      interactionTimeoutMs: opts.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
      maxInteractionsPerTask: opts.maxInteractionsPerTask ?? DEFAULT_MAX_INTERACTIONS_PER_TASK,
      approvalLedgerEnabled: opts.approvalLedgerEnabled === true,
    },
    log: (line) => opts.log('info', line),
    onOpen: async () => {
      // 流式上报：每完成一个工具就推一条 scan_progress，平台可以边收边亮卡片
      const items = await scanAgents({
        fresh: true,
        // sandbox 影响 CodeBuddy 的 executionModes：不传会让平台以为它也不能 full
        externalSandbox: opts.externalSandbox === true,
        onItem: (item) =>
          emitter?.emit({ type: 'scan_progress', items: [item], scannedAt: now(), done: false }),
      });
      emitter?.emit({ type: 'scan_progress', items: [], scannedAt: now(), done: true });
      emitter?.emit({ type: 'agent_list', agents: items, scannedAt: now() });
      opts.log('info', `[agent-bridge] 已上报 ${items.length} 个工具状态，等待平台任务…`);
    },
    onMessage: (raw) => {
      let msg;
      try {
        msg = assertServerMessage(raw);
      } catch (e) {
        if (e instanceof ProtocolError) {
          opts.log('error', `[agent-bridge] 指令非法：${e.message}`);
          return;
        }
        throw e;
      }
      if (!emitter) return;

      const dispatchOpts = dispatchOptions(emitter);

      if (msg.type === 'ping') {
        emitter.emit({ type: 'pong', at: Date.now() });
        return;
      }
      if (msg.type === 'get_task') {
        dispatchGetTask(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'get_artifact') {
        dispatchGetArtifact(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'close_session') {
        dispatchCloseSession(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'cancel_turn') {
        dispatchCancelTurn(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'send_message') {
        void dispatchConversationMessage(msg, dispatchOpts).catch((error) => {
          opts.log('error', `[agent-bridge] send_message 处理失败：${(error as Error).message}`);
        });
        return;
      }
      if (msg.type === 'get_interaction_url') {
        const gate = authorizeService(
          msg,
          'get_interaction_url',
          msg.taskId,
          'task:respond',
          opts.requireServiceToken,
        );
        if (!gate.ok) {
          emitter.emit({
            type: 'interaction_url',
            taskId: msg.taskId,
            requestId: msg.requestId,
            ok: false,
            errorCode: gate.code,
          });
          return;
        }
        const lookup = urls.lookup(msg.taskId, msg.requestId);
        const entry = lookup.entry;
        emitter.emit({
          type: 'interaction_url',
          taskId: msg.taskId,
          requestId: msg.requestId,
          ok: Boolean(entry),
          url: entry?.url,
          expiresAt: entry?.expiresAt,
          errorCode: entry
            ? undefined
            : lookup.expired
              ? 'interaction_url_expired'
              : 'interaction_url_not_found',
        });
        return;
      }
      if (msg.type === 'task_interaction_response') {
        dispatchInteractionResponse(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'artifact_upload_start') {
        const gate = authorizeService(
          msg,
          'run_task',
          msg.taskId,
          'task:create',
          opts.requireServiceToken,
        );
        if (!gate.ok) {
          opts.log('error', `[agent-bridge] 拒绝附件上传 ${msg.taskId}：${gate.message}`);
          return;
        }
        try {
          const ready = artifacts.startUpload({
            sessionId: msg.taskId,
            operationId: msg.operationId,
            name: msg.name,
            mimeType: msg.mimeType,
            size: msg.size,
            sha256: msg.sha256,
            chunkSize: msg.chunkSize,
          });
          emitter.emit({ type: 'artifact_upload_ready', ...ready });
        } catch (error) {
          opts.log('error', `[agent-bridge] 附件上传启动失败：${(error as Error).message}`);
        }
        return;
      }
      if (msg.type === 'artifact_upload_chunk') {
        try {
          const ack = artifacts.writeChunk(msg);
          emitter.emit({ type: 'artifact_upload_chunk_ack', transferId: msg.transferId, ...ack });
        } catch (error) {
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_upload_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_download_start') {
        const gate = authorizeService(
          msg,
          'get_task',
          msg.taskId,
          'task:read',
          opts.requireServiceToken,
        );
        if (!gate.ok) {
          opts.log('error', `[agent-bridge] 拒绝附件下载 ${msg.taskId}：${gate.message}`);
          return;
        }
        try {
          artifacts.startDownload({
            sessionId: msg.taskId,
            artifactId: msg.artifactId,
            operationId: msg.operationId,
          });
        } catch (error) {
          emitter.emit({
            type: 'artifact_download_result',
            transferId: msg.operationId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_download_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_download_chunk_ack') {
        try {
          artifacts.ackDownload(msg);
        } catch (error) {
          emitter.emit({
            type: 'artifact_download_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_download_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_upload_complete') {
        try {
          const result = artifacts.completeUpload(msg);
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'committed',
            artifactId: result.artifactId,
            sha256: msg.sha256,
            eventSeq: result.eventSeq,
          });
        } catch (error) {
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_upload_failed',
          });
        }
        return;
      }
      if (msg.type === 'scan') {
        const requestId = msg.requestId;
        void scanAgents({
          fresh: true,
          externalSandbox: opts.externalSandbox === true,
          onItem: (item) =>
            emitter?.emit({
              type: 'scan_progress',
              requestId,
              items: [item],
              scannedAt: new Date().toISOString(),
              done: false,
            }),
        }).then((agents) => {
          const scannedAt = new Date().toISOString();
          emitter?.emit({ type: 'scan_progress', requestId, items: [], scannedAt, done: true });
          emitter?.emit({ type: 'scan_result', requestId, agents, scannedAt });
        });
        return;
      }
      if (msg.type === 'cancel_task') return dispatchCancelTask(msg, dispatchOpts);
      dispatchRunTask(msg, dispatchOpts);
    },
  });

  emitter = new Emitter({
    // 信封暂不由本地单方开启：平台在 hello 协商到 cloud-events 后再启用，默认保持 v1 扁平报文
    sink: (msg) => client.send(msg as ClientMessage),
  });

  // 容量水位（A2）：每次调度状态变化广播一条 capacity_update。
  // 平台与控制面任务共用 defaultSupervisor（都经 runner.startTask），一处订阅覆盖双通道。
  defaultSupervisor.subscribeCapacity((s) => {
    emitter?.emit({ type: 'capacity_update', ...s });
  });

  return {
    // 循环依赖的解法：client 的回调只在连接建立后触发，此时 emitter 必然已赋值
    emitter,
    registry: opts.registry,
    store: opts.store,
    artifacts,
    artifactsForTenant,
    urls,
    close: () => {
      // 常驻进程（Claude/Qoder）不属于 supervisor，关闭会话时必须自己收干净，
      // 否则每开一次会话就在后台留一批子进程。
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      for (const resident of residentSessions.values()) resident.close();
      residentSessions.clear();
      client.close();
      opts.store.close();
    },
    isConnected: () => client.isOpen(),
    activeTasks: () => tasks.size,
    cancelTask: (taskId: string) => {
      const h = tasks.get(taskId);
      if (!h) return false;
      h.cancel();
      return true;
    },
    respondInteraction: (msg) => dispatchInteractionResponse(msg, dispatchOptions(emitter)),
    partialMessages: (taskId) => defaultSupervisor.listPartialMessages(taskId),
  };
}
