/**
 * Wire protocol between the bridge and the orchestration platform.
 *
 * The bridge is an external client: it does not import platform code, it only relies on this JSON
 * contract plus runtime validation (`assertServerMessage`) so the two sides cannot drift silently.
 *
 * Direction: bridge → platform uses `ClientMessage`; platform → bridge uses `ServerMessage`.
 */

export const PROTOCOL_VERSION = 1;

/** 单个 AI 编码 CLI 的安装/凭据状态（对应平台工具卡片的三个标签） */
export type AgentStatus = 'not_installed' | 'installed_no_cred' | 'ready';

export type AgentCapability = 'non_interactive' | 'interactive_only';

export interface AgentListItem {
  kind: string;
  display: string;
  version?: string;
  status: AgentStatus;
  /** 命中的可执行文件路径（便于排查，不含任何密钥） */
  path?: string;
  /** 凭据来源：`env:NAME` / `file:~/.codex/auth.json` / `platform`（后者由平台侧合并） */
  credentialSource?: string;
  capability: AgentCapability;
  /** 找到二进制但执行失败（exit≠0 / 超时），典型是 Node 版本不兼容 */
  installedButBroken?: boolean;
  /** 品牌图标：`data:image/svg+xml;base64,…`（24×24 单色）；资产缺失时省略。平台应按 kind 缓存 */
  logo?: string;
}

export type ClientMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      deviceId: string;
      cliVersion: string;
      platform: string;
      hostname: string;
    }
  | { type: 'agent_list'; agents: AgentListItem[]; scannedAt: string }
  | {
      /** 扫描过程中的增量回传：每完成一个适配器发一条，`done: true` 表示探测阶段结束 */
      type: 'scan_progress';
      requestId?: string;
      items: AgentListItem[];
      scannedAt: string;
      done: boolean;
    }
  | { type: 'task_status'; taskId: string; status: TaskStatus; exitCode?: number; error?: string }
  | { type: 'task_log'; taskId: string; stream: 'stdout' | 'stderr'; data: string; isAnsi: boolean }
  | { type: 'pong'; at: number }
  | { type: 'scan_result'; requestId?: string; agents: AgentListItem[]; scannedAt: string };

export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';

export interface RunTaskCommand {
  type: 'run_task';
  taskId: string;
  agentType: string;
  cwd: string;
  /** 传给 CLI 的参数（不含二进制本身）；平台可用 {{prompt}} 占位 */
  args: string[];
  prompt?: string;
  timeoutMs?: number;
  allowInteractive?: boolean;
}

export interface CancelTaskCommand {
  type: 'cancel_task';
  taskId: string;
}

export interface ScanCommand {
  type: 'scan';
  requestId?: string;
}

export interface PingCommand {
  type: 'ping';
  at?: number;
}

export type ServerMessage = RunTaskCommand | CancelTaskCommand | ScanCommand | PingCommand;

export class ProtocolError extends Error {}

/**
 * 运行时校验平台指令（不信任平台下发的任意结构）。
 * 只做形状校验；**指令白名单**（agentType / cwd）在 runner 里另行校验。
 */
export function assertServerMessage(raw: unknown): ServerMessage {
  if (!raw || typeof raw !== 'object') throw new ProtocolError('报文不是对象');
  const msg = raw as Record<string, unknown>;
  const type = msg['type'];
  if (type === 'run_task') {
    for (const key of ['taskId', 'agentType', 'cwd'] as const) {
      if (typeof msg[key] !== 'string' || !(msg[key] as string).length) {
        throw new ProtocolError(`run_task 缺少 ${key}`);
      }
    }
    if (!Array.isArray(msg['args']) || msg['args'].some((a) => typeof a !== 'string')) {
      throw new ProtocolError('run_task.args 必须是字符串数组');
    }
    return {
      type: 'run_task',
      taskId: String(msg['taskId']),
      agentType: String(msg['agentType']),
      cwd: String(msg['cwd']),
      args: msg['args'] as string[],
      prompt: typeof msg['prompt'] === 'string' ? msg['prompt'] : undefined,
      // 注意：平台**不得**下发 env（2026-10-22 移除）。这里刻意不透传，
      // 未知字段一律忽略 —— 子进程只用 bridge 自身进程的环境。
      timeoutMs: typeof msg['timeoutMs'] === 'number' ? msg['timeoutMs'] : undefined,
      allowInteractive: msg['allowInteractive'] === true,
    };
  }
  if (type === 'cancel_task') {
    if (typeof msg['taskId'] !== 'string') throw new ProtocolError('cancel_task 缺少 taskId');
    return { type: 'cancel_task', taskId: String(msg['taskId']) };
  }
  if (type === 'scan') {
    return {
      type: 'scan',
      requestId: typeof msg['requestId'] === 'string' ? msg['requestId'] : undefined,
    };
  }
  if (type === 'ping') {
    return { type: 'ping', at: typeof msg['at'] === 'number' ? msg['at'] : undefined };
  }
  throw new ProtocolError(`未知指令类型: ${String(type)}`);
}

/** 日志分片上限：平台侧按 4KB 收，避免单帧过大 */
export const LOG_CHUNK_BYTES = 4096;

/** 把一段输出切成 ≤4KB 的分片（按 UTF-8 字节切，且不切断多字节字符） */
export function chunkLog(data: string, maxBytes = LOG_CHUNK_BYTES): string[] {
  if (!data) return [];
  const out: string[] = [];
  let buf = '';
  for (const ch of data) {
    const next = buf + ch;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) {
      out.push(buf);
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}
