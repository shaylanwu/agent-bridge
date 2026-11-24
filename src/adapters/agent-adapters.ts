/**
 * 12 个 AI 编码 CLI 的适配器定义 + 本机探测（不读、不上传任何密钥内容）
 *
 * 探测口径与平台侧保持一致：
 *  - 先 which/where，再扫常见安装目录 + `%LOCALAPPDATA%\Programs\<厂商>\<产品>\bin`
 *  - 跑一次 `--version` 拿版本；找到 bin 但执行失败 → installedButBroken
 *  - 凭据只判「环境变量 / 凭据文件是否存在」，读到即停，内容不落内存更不上传
 */

import { execFile, execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type {
  AgentCapability,
  AgentListItem,
  AgentStatus,
  ContinuationKind,
  ExecutionModeCapability,
  FeedKind,
  InteractionKind,
  PermissionMode,
} from '../protocol.js';
import { fullModeAdmitted } from '../core/permission-policy.js';
import { logoDataUri } from './agent-logos.js';
import type { StepFormat } from './step-parsers.js';
import type { AcpAgentSpec } from './acp-codebuddy.js';
import { buildWinCommandLine, isWinShim } from './win-exec.js';

export interface AgentDef {
  kind: string;
  display: string;
  bin: string;
  /** 备用可执行名（社区分叉/别名） */
  altBins?: string[];
  /** 免安装：走 npx 拉起（当前只有 dsh） */
  npxSpec?: string;
  /**
   * 该工具跑 taskArgs 所需的最低版本。
   *
   * 用途是**如实反映**：装了但版本不够时，`agent_list` 报 `installedButBroken`
   * 而不是「就绪」，免得平台派任务下来才在 stderr 里看到 `unknown option`。
   * 只在这一条上生效，不改 taskArgs（否则会为了兼容旧版砍掉新版能力）。
   */
  minVersion?: string;
  capability: AgentCapability;
  /** 非交互任务参数模板，`{{prompt}}` 由 runner 替换 */
  taskArgs: string[];
  /**
   * full 权限模式的**追加**参数（1.0 Phase 2），接在 taskArgs 之后。
   * 未声明 = 该工具没有已验证的 full 入口，请求 full 时在 spawn 前拒绝（不降级）。
   * 只有 bridge 采样这套 argv，平台不能传自定义 args（受管参数模式）。
   */
  fullArgs?: string[];
  /**
   * full 模式的完整 argv 模板；仅在「简单追加 fullArgs」会破坏参数语义时声明。
   * 例如 agy 的 -p 必须紧跟 prompt 且 prompt 压尾，权限旗标只能放在 -p 之前。
   */
  fullTaskArgs?: string[];
  /** 步骤流格式：有值 = 该工具支持 task_step（taskArgs 必须产出对应 JSONL 事件流） */
  steps?: StepFormat;
  /** 原生 resume 参数模板（含 {{sessionId}}）；仅对 help 已确认的工具声明 */
  resumeArgs?: string[];
  /** 原生 ACP 启动方式；未声明表示该 CLI 没有已验证的 ACP 入口 */
  acp?: AcpAgentSpec;
  /** 有此版本才声明 ACP；probeAgent 用真实版本门控，旧版只保留 headless。 */
  acpMinVersion?: string;
  /** 该 CLI 的后台进程需要显式外部代理；不写死端口，由 infra/proxy-env 解析。 */
  preferSystemProxy?: boolean;
  /**
   * 该工具的 ACP 会话到底会不会发交互请求（缺省 `['permission','form']`）。
   *
   * 必须能显式声明空数组：实测 `dsh` 的 ACP 是 automation-only —— 工具调用直接放行、
   * **从不发 `session/request_permission`**。给它照拄声明 permission，平台就会一直等一个永远不会来的确认。
   */
  acpInteractionKinds?: InteractionKind[];
  /**
   * headless 未登录挂死守卫（1.0 起有）：stderr 命中任一模式 = 凭据缺失/失效，
   * supervisor 立即 kill 并按 `tool_no_credentials` 失败结算。
   *
   * 实测依据（agy 1.4.10）：未登录时 stderr 立即打认证提示，60s 后吐 `status:"ERROR"` 结果
   * 但**进程不退出** —— 不守卫就是干等到总超时。逐工具声明，不需要的工具不声明。
   */
  authGuard?: { patterns: RegExp[]; hint: string };
  credential: {
    /** 平台可代管 Key 的注入变量（有值才允许"绑定 Key"） */
    envKey?: string;
    envs: string[];
    files: string[];
    /** Windows 凭据管理器中的固定 target；只探测存在性，不读取秘密。 */
    windowsTargets?: string[];
    /** 官方只读登录状态命令；使用当前适配器 bin，只认退出码，不保留输出。 */
    statusCommand?: { args: string[]; timeoutMs?: number };
    loginCommand?: string;
  };
}

const home = (): string => homedir();const appData = (): string => process.env.APPDATA ?? join(home(), 'AppData', 'Roaming');
const localAppData = (): string => process.env.LOCALAPPDATA ?? join(home(), 'AppData', 'Local');

const DSH_HOME = (): string => process.env.DSH_HOME ?? join(home(), '.dsh');

export const AGENTS: AgentDef[] = [
  {
    kind: 'claude-code',
    display: 'Claude Code',
    bin: 'claude',
    capability: 'non_interactive',
    // 步骤流（B 批次）：stream-json 事件流喂 task_step；task_log 上行内容随之变为 JSONL
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose'],
    // full：跳过工具权限确认（非 OS 提权）
    fullArgs: ['--dangerously-skip-permissions'],
    resumeArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose', '--resume', '{{sessionId}}'],
    steps: 'claude-json',
    credential: {
      envKey: 'ANTHROPIC_API_KEY',
      envs: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      files: [join(home(), '.claude', '.credentials.json'), join(home(), '.claude.json')],
      loginCommand: 'claude',
    },
  },
  {
    // 腾讯 CodeBuddy CLI（@tencent-ai/codebuddy-code），命令名 codebuddy，别名 cbc。
    // 接口与 Claude Code 同构（实测 help 确认支持 stream-json）；登录后凭据落 ~/.codebuddy。
    kind: 'codebuddy-cli',
    display: 'CodeBuddy CLI',
    bin: 'codebuddy',
    altBins: ['cbc'],
    capability: 'non_interactive',
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose'],
    resumeArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--verbose', '--resume', '{{sessionId}}'],
    // full：-y 自动确认；仅当 external_sandbox=true 时才允许（env 注入由 supervisor 负责）
    fullArgs: ['-y'],
    steps: 'claude-json',
    acp: {
      command: 'codebuddy',
      args: ['--serve', '--acp', '--port', '0'],
      authEnv: 'CODEBUDDY_AUTH_TOKEN',
      sanitizeHostEnv: true,
    },
    credential: {
      envs: [],
      files: [join(home(), '.codebuddy')],
      loginCommand: 'codebuddy',
    },
  },
  {
    kind: 'codex',
    display: 'Codex',
    bin: 'codex',
    capability: 'non_interactive',
    // exec --json 已是 JSONL 事件流（item.started/item.completed）；stdin 由 spawn 关闭（stdio ignore）
    taskArgs: ['exec', '--json', '{{prompt}}'],
    // full：同时绕过审批与 Codex 自身沙箱
    fullArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    steps: 'codex-json',
    credential: {
      envKey: 'OPENAI_API_KEY',
      envs: ['OPENAI_API_KEY'],
      files: [join(home(), '.codex', 'auth.json')],
      loginCommand: 'codex login',
    },
  },
  {
    kind: 'ds-harness',
    display: 'DeepSeek Harness',
    bin: 'dsh',
    npxSpec: '@deepseek-ai/dsh',
    // 官方文档：headless 加 --json 出 NDJSON 事件流（tool_call/tool_result 按 callId 配对）；
    // 需 dsh ≥ 0.2.x（0.1.5 实测 --json 是 unknown option，不带 --json 只能出纯文本、没有步骤流）
    minVersion: '0.2.0',
    capability: 'non_interactive',
    // 官方文档：headless 加 --json 出 NDJSON 事件流（tool_call/tool_result 按 callId 配对）；
    // 需 dsh ≥ 0.2.x（0.1.5 实测 --json 是 unknown option）
    taskArgs: ['--profile', 'headless', '--json', '{{prompt}}'],
    // full：两个官方 headless 参数；never 是「仍需审批即拒绝」，不是自动批准
    fullArgs: ['--permission-mode', 'danger-full-access', '--approval-policy', 'never'],
    resumeArgs: ['--profile', 'headless', '--json', '--session-id', '{{sessionId}}', '{{prompt}}'],
    steps: 'dsh-json',
    // 实测（0.2.1-rc.2）：`dsh --profile acp` 在 stdio 上讲 ACP，initialize 回 protocolVersion=1、
    // sessionCapabilities {close,list,resume}；续会话靠自家的 `session/resume`，
    // 标准 `session/load` 回 -32601 Method not found。
    acp: { command: 'dsh', args: ['--profile', 'acp'] },
    // automation-only：跑工具时只发 tool_call/tool_call_update，**从不回问权限**，也没有表单通道。
    // 这是实测结论，不是保守估计 —— 声明了平台就会等。
    acpInteractionKinds: [],
    credential: {
      envKey: 'DEEPSEEK_API_KEY',
      envs: ['DEEPSEEK_API_KEY'],
      files: [join(DSH_HOME(), '.credentials.yaml')],
      loginCommand: 'npx -y @deepseek-ai/dsh web',
    },
  },
  {
    // Google 官方继任者：Gemini CLI 2026-06-18 停服个人/Pro/Ultra 账号，官方指明迁移到 Antigravity。
    // 2026-11-14 本机实测 agy 1.4.10（详见 openspec/changes/archive/2026-11-14-switch-gemini-to-antigravity-cli/design.md）：
    //   - 1.4.10 无 `acp`；1.5.9 ACP 已于 2026-11-16 通过真实首轮/续接验收。
    //     WorkBuddy 进程代理可能与 Windows 系统代理不同 ⇒ 显式 external proxy 优先、系统自动探测兜底。
    //   - `-p` 吞值：prompt 必须紧跟其后且置于 argv 末尾，中间插旗标会被当 prompt 吞掉（实测 exit 2 报错）
    //   - 未登录：stderr 立即打 `Authentication required…` / `Waiting for authentication (timeout 60s)…`，
    //     60s 后吐 `status:"ERROR"` 结果但进程不退出 ⇒ authGuard 必须 kill（实测 timeout 124 实锤挂死）
    //   - 登录令牌存 OS keyring；Windows 以固定 target=gemini:antigravity 探测存在性，不读取秘密。
    //     envs/files 留空；envKey 未复验不开放（GEMINI_API_KEY + --settings 链路留作后续）
    kind: 'agy',
    display: 'Antigravity CLI',
    bin: 'agy',
    capability: 'non_interactive',
    minVersion: '1.5.9',
    acp: { command: 'agy', args: ['acp'], preferSystemProxy: true },
    acpMinVersion: '1.5.9',
    // 已实测无工具回合与原生续接；permission/form 尚未逐项实测，不声明。
    acpInteractionKinds: [],
    preferSystemProxy: true,
    // 官方 headless 文档 + 1.4.10 实测信封一致：{"event":"init"|"step_update"|"result",…同名负载}
    taskArgs: ['--output-format', 'stream-json', '-p', '{{prompt}}'],
    // full：官方 always-proceed 权限模式（auto-approve all tool permission requests）。
    // 不能把旗标追加在 prompt 后：-p 的 prompt 必须始终是最后一个 argv。
    fullArgs: ['--dangerously-skip-permissions'],
    fullTaskArgs: ['--output-format', 'stream-json', '--dangerously-skip-permissions', '-p', '{{prompt}}'],
    // 官方文档：`--conversation <ID>` 续接指定会话（flags 前置，-p prompt 压尾）
    resumeArgs: ['--output-format', 'stream-json', '--conversation', '{{sessionId}}', '-p', '{{prompt}}'],
    steps: 'agy-json',
    authGuard: {
      patterns: [/Authentication required/, /Waiting for authentication/],
      hint: 'Antigravity CLI 未登录或凭据已失效：请先在本机运行 `agy` 完成一次登录',
    },
    credential: {
      envs: [],
      files: [],
      windowsTargets: ['gemini:antigravity'],
      loginCommand: 'agy',
    },
  },
  {
    kind: 'opencode',
    display: 'opencode',
    bin: 'opencode',
    capability: 'interactive_only',
    // 修 bug（B 批次实测发现）：opencode 只认 `--format json`，原先写的 `--json` 是无效参数
    taskArgs: ['run', '--format', 'json', '{{prompt}}'],
    // full：--auto（显式 deny 仍有效）
    fullArgs: ['--auto'],
    steps: 'opencode-json',
    acp: { command: 'opencode', args: ['acp'] },
    credential: {
      envs: ['OPENCODE_API_KEY'],
      files: [
        join(home(), '.local', 'share', 'opencode', 'auth.json'),
        join(localAppData(), 'opencode', 'auth.json'),
      ],
      loginCommand: 'opencode auth login',
    },
  },
  {
    kind: 'mimo-code',
    display: 'Mimo Code',
    bin: 'mimo',
    altBins: ['mimo-code'],
    capability: 'interactive_only',
    // opencode fork（官方 drive-mimo skill 确认事件同构）：run --format json 出 JSONL
    taskArgs: ['run', '--format', 'json', '{{prompt}}'],
    // full：与 claude 同义（显式 deny 仍有效）
    fullArgs: ['--dangerously-skip-permissions'],
    steps: 'opencode-json',
    acp: { command: 'mimo', args: ['acp'] },
    credential: {
      envs: ['MIMO_API_KEY'],
      // 真实凭据位置（实测）：`mimo providers` 显示 Credentials `~\.local\share\mimocode\auth.json`。
      // 之前 files 是空的，于是明明配了 key 也被判「缺凭据」。
      files: [join(home(), '.local', 'share', 'mimocode', 'auth.json')],
      loginCommand: 'mimo',
    },
  },
  {
    kind: 'qoder-cli',
    display: 'Qoder CLI',
    // 修 bug（B 批次实测发现）：真 CLI 是 qodercli；bin 'qoder' 命中的是 Qoder IDE 的
    // Electron 入口（.qoder/entry/qoder.cmd），把 IDE 当 CLI 探测属于误报
    bin: 'qodercli',
    capability: 'interactive_only',
    // 官方文档（docs.qoder.com/cli/run-in-scripts）：-p + --output-format stream-json；实测 claude 同构
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json'],
    resumeArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json', '--resume', '{{sessionId}}'],
    // full：Qoder 官方旁路语义
    fullArgs: ['--dangerously-skip-permissions'],
    steps: 'claude-json',
    credential: {
      envs: ['QODER_PERSONAL_ACCESS_TOKEN'],
      files: [join(home(), '.qoder', '.auth', 'user')],
      loginCommand: 'qodercli',
    },
  },
  {
    // 官方 xAI 命令行（Grok Build）。2026-10-29 实测 1.0.70：
    //   - `grok --version` → "grok 1.0.70 (…)"，`--help` 首行 "Grok Build TUI"
    //   - 非交互仍是 `-p/--single`；`--output-format streaming-messages-json` 出的是
    //     Claude Messages 线格式（system/init → assistant/user → result），与 claude-json 解析器逐字段吻合
    //   - `-s/--session-id` 可指定会话 ID、`-r/--resume` 可续接同一会话（实测 init.session_id 前后一致）
    //   - `--always-approve` 实测使 init.permissionMode = bypassPermissions
    // ⚠️ kind 保持 'grok-cli'：它是平台 run_task.agentType 的精确匹配值，改名属跨团队契约变更，
    //    本次只改展示名（display）与实现细节。
    kind: 'grok-cli',
    display: 'Grok Build',
    bin: 'grok',
    capability: 'interactive_only',
    taskArgs: ['--single', '{{prompt}}', '--output-format', 'streaming-messages-json'],
    // full：--always-approve（沙箱是另一维度）
    fullArgs: ['--always-approve'],
    // 实测 -r 能续上同一 session ⇒ headless 走原生续接，而不是重放 transcript
    resumeArgs: ['--single', '{{prompt}}', '--output-format', 'streaming-messages-json', '--resume', '{{sessionId}}'],
    steps: 'claude-json',
    acp: {
      command: 'grok',
      args: ['agent', 'stdio'],
      // 实测 initialize 声明 authMethods = [xai.api_key(默认), grok.com]；
      // 且 **session/new 不需要先 authenticate 就能建会话** —— 所以这里刻意不写 `authMethod`：
      // 写死 'grok.com' 会让每个任务都尝试一次浏览器登录（无浏览器机器上还会弹窗）。
      // 只在真的有 XAI_API_KEY 时才走 API key 通道。
      authEnvMethods: { XAI_API_KEY: 'xai.api_key' },
    },
    credential: {
      envKey: 'XAI_API_KEY',
      envs: ['XAI_API_KEY', 'GROK_API_KEY'],
      // Grok Build 的真实凭据位置：OAuth 登录态 auth.json；自定义模型（含 api_key）config.toml。
      // ⛔ 不再探测社区版遗留的 user-settings.json —— 官方版从不创建它，探测它等于稳定误报「缺凭据」。
      files: [join(home(), '.grok', 'auth.json'), join(home(), '.grok', 'config.toml')],
      loginCommand: 'grok login',
    },
  },
  {
    kind: 'kimi-code',
    display: 'Kimi Code',
    bin: 'kimi',
    capability: 'interactive_only',
    // 修 bug（B 批次实测发现）：kimi 没有 --headless（unknown option）；
    // 非交互是 -p，stream-json 为 OpenAI tool_calls 风格（已实测）
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json'],
    // full：**不追加** —— -p 已是 auto 权限，再加 --auto 会重复
    fullArgs: [],
    steps: 'kimi-json',
    acp: { command: 'kimi', args: ['acp'] },
    credential: {
      envKey: 'MOONSHOT_API_KEY',
      envs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
      files: [join(home(), '.kimi', 'config.json')],
      loginCommand: 'kimi',
    },
  },
  {
    kind: 'minimax-code',
    display: 'MiniMax Code',
    bin: 'mcode',
    capability: 'interactive_only',
    // 修 bug（B 批次查证发现）：mcode 的非交互子命令是 exec 不是 run；
    // 官方 FAQ 确认 exec --output-format stream-json 出 NDJSON 事件流（0.6.13 实测：
    // item.started/completed + item.type=tool_call，toolCall{name,input}）
    taskArgs: ['exec', '--output-format', 'stream-json', '{{prompt}}'],
    // full：exec 的 full policy
    fullArgs: ['--permission', 'full'],
    steps: 'mcode-json',
    acp: { command: 'mcode', args: ['acp'] },
    credential: { envs: ['MINIMAX_API_KEY'], files: [], loginCommand: 'mcode' },
  },
  {
    kind: 'trae-cli',
    display: 'Trae CLI',
    bin: 'traecli',
    capability: 'interactive_only',
    // 修 bug（B 批次实测发现）：原 `run` 子命令不存在；实测 `exec --print --output-format stream-json`
    // 输出 claude 同构事件流（v0.211.1）
    // 修 bug（2026-10-30 实测 0.211.1）：`--print` 已不存在，`--output-format` 也不再是
    // exec 的旗标 —— 实测 `traecli exec --print` → `unexpected argument '--print'`（exit 2）。
    // 现在的非交互输出开关是 `--json`（"Print events to stdout as JSONL"）。
    taskArgs: ['exec', '--json', '{{prompt}}'],
    // full：--yolo（不夸大不同版本的沙箱语义）
    fullArgs: ['--yolo'],
    steps: 'claude-json',
    // 修 bug（实跑复核）：`traecli acp` 是**子命令组**，不带子命令只打印帮助并 exit 0 ——
    // 于是 bridge 报「进程退出（code 0）」，看起来像正常结束，实际握手从未开始。
    // 真入口是 `traecli acp serve`（实测 initialize 立刻回 protocolVersion=1）。
    acp: { command: 'traecli', args: ['acp', 'serve'] },
    credential: {
      envs: ['TRAECLI_PERSONAL_ACCESS_TOKEN'],
      files: [],
      statusCommand: { args: ['login', 'status'], timeoutMs: 3_000 },
      loginCommand: 'traecli',
    },
  },
];

export function agentDefOf(kind: string): AgentDef | undefined {
  return AGENTS.find((a) => a.kind === kind);
}

/** 生成指定权限模式的默认 argv；fullTaskArgs 是少数位置敏感 CLI 的显式覆盖。 */
export function taskArgsForPermission(def: AgentDef, mode: PermissionMode): string[] {
  if (mode === 'default') return def.taskArgs;
  return def.fullTaskArgs ?? [...def.taskArgs, ...(def.fullArgs ?? [])];
}

/**
 * 按执行模式如实描述能力（1.0 `AgentListItem.executionModes`）。
 *
 * 为什么不能只报一个 `capability`：同一工具在 headless 与 ACP 下能做的事不一样 ——
 * headless 可能支持 full（危险参数），ACP 只走 default + 原生 permission 交互。
 * 混着报会让平台请求出「跑到一半才失败」的组合，所以这里逐模式列，未验证的一律不列。
 */
export function executionModesFor(
  def: AgentDef,
  externalSandbox = false,
  installedVersion?: string,
): ExecutionModeCapability[] {
  // steps 只有声明了步骤解析器才真的产出 task_step；artifacts 是任务级双向通道，两种模式都有
  const headlessFeed: FeedKind[] = ['messages', ...(def.steps !== undefined ? (['steps'] as FeedKind[]) : []), 'artifacts'];
  const admitted = fullModeAdmitted({ kind: def.kind, fullArgs: def.fullArgs, externalSandbox });
  // headless 要么靠 CLI 的续接参数接上原生会话，要么拿完整 transcript 重放 —— 后者是 12/12 的底线
  const headlessContinuation: ContinuationKind = def.resumeArgs ? 'resume-session' : 'replay-session';
  const modes: ExecutionModeCapability[] = [
    {
      mode: 'headless',
      // 未通过 full 准入（尤其 CodeBuddy 没声明 external_sandbox）就不声明 full，避免平台误判
      permissionModes: admitted ? ['default', 'full'] : ['default'],
      // headless 是一次性执行，没有回问通道
      interactionKinds: [],
      feedKinds: headlessFeed,
      continuation: headlessContinuation,
    },
  ];
  const acpVersionOk =
    def.acpMinVersion === undefined ||
    (installedVersion !== undefined && meetsMinVersion(installedVersion, def.acpMinVersion));
  if (def.acp && acpVersionOk) {
    modes.push({
      mode: 'acp-stdio',
      // ACP 走原生 permission 交互，不走「跳过审批」的 full 参数
      permissionModes: ['default'],
      // 逐工具如实声明：dsh 的 ACP 是 automation-only，实测不发权限/表单请求
      interactionKinds: def.acpInteractionKinds ?? ['permission', 'form'],
      // ACP 的 agent_message_chunk → messages、tool_call → steps；artifacts 暂无 ACP 来源
      feedKinds: ['messages', 'steps'],
      // ACP 会话由 agent 持有，bridge 只回传 ID（当前 9 个声明工具走 session/load 或 session/resume）
      continuation: 'native-session',
    });
  }
  return modes;
}

/**
 * 这些执行模式里是否存在能续接回合的一档 = 该工具能不能开 conversation。
 *
 * 判据是「任一模式可续」而不是「headless 可续」：同一工具可能 headless 单轮、ACP 能续，
 * 平台只给了 agentType、并没有指定通道，取任一模式可续才是如实回答。
 */
export function canContinue(modes: ExecutionModeCapability[]): boolean {
  return modes.some((m) => m.continuation !== 'single-turn');
}

/** 该 agentType 是否支持多轮会话；未知工具返回 false 由调用方按「未知工具」单独处理 */
export function agentCanContinue(kind: string): boolean {
  const def = agentDefOf(kind);
  return def ? canContinue(executionModesFor(def)) : false;
}

// ---------- 可执行文件解析 ----------
// `.exe` 必须排在 `.cmd` 前面：`.exe` 可以直接 spawn，`.cmd/.bat` 是 npm 垫片，
// 必须经 shell 转发（见 win-exec.ts）。顺序反了，ACP 通道会拿到 .cmd 然后 EINVAL。
const WIN_EXTS = ['.exe', '.cmd', '.bat', ''];
/** Windows 上真正能 spawn 的可执行扩展名（无扩展名的 shim 是 bash 脚本，Node 起不来） */
const WIN_EXEC_RE = /\.(exe|cmd|bat)$/i;

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    // Windows 的 `where` 会同时返回 `grok.cmd` 和无扩展名的 `grok`（bash 风格 shim），
    // 后者 Node 直接 spawn 会 ENOENT——必须按扩展名过滤，否则「已装」会被误判成「装坏」。
    if (process.platform === 'win32' && !WIN_EXEC_RE.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 `where` / `command -v` 的输出里挑一个真正能执行的路径。
 *
 * 为什么 `.exe` 优先：同目录常同时存在 `foo.cmd`（npm 垫片）与 `foo.exe`，
 * 而 `where` 的输出顺序不保证。挑到 `.cmd` 时调用方必须走 shell 转发 ——
 * ACP 这类要长期持有 stdin/stdout 的通道经一层 cmd.exe 转发既多余又易碎。
 */
export function pickPreferredBin(hits: string[]): string | undefined {
  const usable = hits.map((s) => s.trim()).filter(Boolean).filter((p) => isExecutableFile(p));
  return usable.find((p) => /\.exe$/i.test(p)) ?? usable[0];
}

/**
 * 启动一个 CLI 子进程，统一处理 Windows `.cmd/.bat` 垫片。
 *
 * 为什么这个函数在这里而不是 `win-exec.ts`：`protocol-boundary-check` 只允许
 * 本文件与 `task-supervisor.ts` 出现 `shell: true`（垫片必须经 shell 转发），
 * 而长驻通道（ACP / app-server）也要同一套处理。与其让每个 adapter 各写一份、
 * 各自被门禁拦下，不如收敛成这一个入口 —— 拼命令行仍走 `win-exec.ts`。
 */
export function spawnCliProcess(
  binPath: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
  return (
    isWinShim(binPath)
      ? spawn(buildWinCommandLine(binPath, argv), {
          cwd: opts.cwd,
          env: opts.env,
          shell: true,
          windowsHide: true,
          stdio,
        })
      : spawn(binPath, argv, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio })
  ) as ChildProcessWithoutNullStreams;
}

/** Windows 垫片必须回收整棵树；直接 exe/posix 保留原 kill 语义。taskkill 输出与错误不上行。 */
export function killCliProcess(child: ChildProcess, binPath: string): void {
  if (process.platform === 'win32' && isWinShim(binPath) && child.pid) {
    execFile(
      'taskkill',
      ['/pid', String(child.pid), '/T', '/F'],
      { timeout: 2_000, windowsHide: true },
      () => {
        // taskkill 失败时至少终止外壳；不让清理异常反噬已结算任务。
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      },
    );
    return;
  }
  child.kill();
}

/** 候选目录：PATH → 常见用户目录 → 逐用户 Programs\<厂商>\<产品>\bin */
export function candidateBinDirs(): string[] {
  const dirs: string[] = [];
  const push = (d?: string): void => {
    if (d) dirs.push(d);
  };
  for (const d of (process.env.PATH ?? '').split(delimiter)) push(d);

  if (process.platform === 'win32') {
    push(join(appData(), 'npm'));
    push(join(home(), '.local', 'bin'));
    push(join(home(), '.bun', 'bin'));
    push(join(home(), '.volta', 'bin'));
    push(join(home(), '.cargo', 'bin'));
    push(join(home(), '.codex', 'packages', 'standalone', 'current', 'bin'));
    // 自带安装器的 CLI 常把可执行塞进 `~/.<product>/bin` 且**不写 PATH**：
    // Mimo Code 就是 `~/.mimocode/bin/mimo.exe`（实测 0.1.16 能跑，但 `where mimo` 找不到，
    // 于是 bridge 误判「未安装」）。扫到就能自动就绪，不必要求用户改 PATH。
    push(join(home(), '.mimocode', 'bin'));
    // agy 同例且更隐蔽：装进 `%LOCALAPPDATA%\agy\bin`（跨厂商目录，Programs 扫描盖不住）
    push(join(localAppData(), 'agy', 'bin'));
    const root = join(localAppData(), 'Programs');
    try {
      for (const vendor of readdirSync(root)) {
        const base = join(root, vendor);
        push(join(base, 'bin'));
        try {
          for (const product of readdirSync(base)) push(join(base, product, 'bin'));
        } catch {
          /* 不是目录：忽略 */
        }
      }
    } catch {
      /* 没有 Programs 目录：忽略 */
    }
  } else {
    push(join(home(), '.local', 'bin'));
    push(join(home(), '.bun', 'bin'));
    push(join(home(), '.npm-global', 'bin'));
    push(join(home(), '.volta', 'bin'));
    push(join(home(), '.asdf', 'shims'));
    push(join(home(), '.cargo', 'bin'));
    push('/opt/homebrew/bin');
    push('/usr/local/bin');
    push('/usr/bin');
  }

  const seen = new Set<string>();
  return dirs.filter((d) => {
    const key = process.platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 解析 bin 绝对路径（找不到返回 undefined） */
export function resolveBin(names: string[]): string | undefined {
  for (const name of names) {
    // 1) 系统解析器（能反映当前 shell 的 PATH）
    try {
      const out =
        process.platform === 'win32'
          ? // stderr 必须吞掉：where 找不到时会往 stderr 打本地化提示，污染 CLI 输出
            execFileSync('where', [name], {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['ignore', 'pipe', 'ignore'],
            })
          : execFileSync('/bin/sh', ['-c', `command -v ${name}`], {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
      // where 可能返回多行（grok.cmd / grok.exe / grok），逐个看，取第一个真正能执行的
      const preferred = pickPreferredBin(out.split(/\r?\n/));
      if (preferred) return preferred;
    } catch {
      /* 继续走目录扫描 */
    }
    // 2) 目录扫描（装完没重启终端时 PATH 还是旧的）
    const found = scanBinDirs(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * 把 AgentDef 的 acp 声明变成「能直接 spawn 的 spec」。
 *
 * 两件事必须在**调用方**做，不能让 runner 自己做：
 * 1) 补 `label` —— 9 个工具共用一个 runner，没有 label 就只能写死一个产品名，
 *    于是 opencode / trae 的失败被冠上 CodeBuddy 的名字，排查直接被带偏；
 * 2) 把 `command` 解析成**绝对路径** —— 否则 spawn 依赖 PATH，而扫描用的是 `resolveBin`，
 *    就会出现「status 报就绪、跑起来 ENOENT」这种自相矛盾（qoder 实跑即此）。
 *
 * 解析失败时保留原 command：让 spawn 报出的 ENOENT 至少还带着 label，
 * 比在这里静默返回 undefined（调用方会退回 CodeBuddy spec）更安全。
 */
export function acpSpecFor(def: AgentDef | undefined): AcpAgentSpec | undefined {
  if (!def?.acp) return undefined;
  // 已经是路径就不再 where 一次：每次解析约 300-400ms，run_task 在同步路径上不该白付这个钱。
  const alreadyPath = /[\\/]/.test(def.acp.command);
  const resolved = alreadyPath ? def.acp.command : resolveBin([def.acp.command, ...(def.altBins ?? [])]);
  return {
    ...def.acp,
    label: def.acp.label ?? def.display,
    command: resolved ?? def.acp.command,
    ...(def.credential.loginCommand ? { loginCommand: def.credential.loginCommand } : {}),
  };
}

/**
 * `resolveBin` 的异步版本，供扫描并发使用。
 * 同步版每次 `where` 约 300-400ms，12 个工具串行就是 4s 量级 —— 扫描用这个才能与版本探测并行。
 * runner 仍用同步版（`startTask` 是同步 API，不必为一个任务改整条调用链）。
 */
export async function resolveBinAsync(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn('where', [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
            : spawn('/bin/sh', ['-c', `command -v ${name}`], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
              });
        let buf = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('where 超时'));
        }, 3000);
        child.stdout?.on('data', (b: Buffer) => {
          buf += b.toString('utf8');
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve(buf);
        });
      });
      const usable = pickPreferredBin(out.split(/\r?\n/));
      if (usable) return usable;
    } catch {
      /* 继续走目录扫描 */
    }
    const found = scanBinDirs(name);
    if (found) return found;
  }
  return undefined;
}

/** 目录扫描共用逻辑：候选目录 × 平台扩展名 */
function scanBinDirs(name: string): string | undefined {
  for (const dir of candidateBinDirs()) {
    const exts = process.platform === 'win32' ? WIN_EXTS : [''];
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isExecutableFile(p)) return p;
    }
  }
  return undefined;
}

// ---------- 版本与凭据 ----------

const VERSION_RE = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/;

export interface VersionProbe {
  ok: boolean;
  version?: string;
  error?: string;
}

export function probeVersion(
  binPath: string,
  args = ['--version'],
  timeoutMs = 8000,
): Promise<VersionProbe> {
  // 异步 spawn：12 个工具并发探测时不阻塞事件循环（WS 心跳、ping/pong 都要靠它）
  return new Promise<VersionProbe>((resolve) => {
    const shim = isWinShim(binPath);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = shim
      ? spawn(buildWinCommandLine(binPath, args), {
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(binPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (r: VersionProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // 超时不猜版本：只有 stdout 里明确出现过版本号才回填
      finish({ ok: false, version: VERSION_RE.exec(stdout)?.[1], error: `版本探测超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (e) => finish({ ok: false, error: `进程启动失败：${e.message}` }));
    child.on('close', (code) => {
      // 只认 stdout 里的版本号：失败时 stderr 常混着 Node/系统的噪声（如 "Node.js v24.11.1"），
      // 拿它当工具版本会显示成「装坏 24.11.1」，非常误导。
      if (code === 0) {
        finish({ ok: true, version: VERSION_RE.exec(stdout)?.[1] });
        return;
      }
      const line = `${stdout}\n${stderr}`
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
      finish({
        ok: false,
        version: VERSION_RE.exec(stdout)?.[1],
        error: line?.slice(0, 200) ?? `退出码 ${code ?? 'unknown'}`,
      });
    });
  });
}

export interface CredentialProbe {
  status: 'configured' | 'missing' | 'unknown';
  source?: string;
}

export function probeCredential(def: AgentDef): CredentialProbe {
  for (const name of def.credential.envs) {
    if ((process.env[name] ?? '').trim()) return { status: 'configured', source: `env:${name}` };
  }
  for (const file of def.credential.files) {
    if (existsSync(file)) {
      return { status: 'configured', source: `file:${file.replace(home(), '~')}` };
    }
  }
  const hasEvidence = def.credential.envs.length > 0 || def.credential.files.length > 0;
  return hasEvidence ? { status: 'missing' } : { status: 'unknown' };
}

/** cmdkey 的本地化文案不参与判断；只认每行末尾稳定的 ASCII target 标记。 */
export function windowsCredentialTargetPresent(output: string, target: string): boolean {
  const marker = `LegacyGeneric:target=${target}`;
  return output.split(/\r?\n/).some((line) => line.trim().endsWith(marker));
}

function listWindowsCredentialTargets(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'cmdkey',
      ['/list'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * 在 env/file 的直接证据之后补 OS keyring 存在性探测。
 * 完整 cmdkey 输出只在函数内消费，不写日志/事件/数据库；失败时保留原保守结果。
 */
export async function probeCredentialWithKeyring(
  def: AgentDef,
  opts: { platform?: NodeJS.Platform; listWindowsTargets?: () => Promise<string> } = {},
): Promise<CredentialProbe> {
  const direct = probeCredential(def);
  const targets = def.credential.windowsTargets ?? [];
  if (direct.status === 'configured' || targets.length === 0 || (opts.platform ?? process.platform) !== 'win32') {
    return direct;
  }
  try {
    const output = await (opts.listWindowsTargets ?? listWindowsCredentialTargets)();
    const target = targets.find((item) => windowsCredentialTargetPresent(output, item));
    return target ? { status: 'configured', source: `keyring:${target}` } : direct;
  } catch {
    return direct;
  }
}

function runCredentialStatusCommand(binPath: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (configured: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(configured);
    };
    try {
      const child = spawnCliProcess(binPath, args, { cwd: home(), env: process.env });
      // 状态命令的输出可能含账号信息：只排空管道，绝不写日志或上行。
      child.stdout.resume();
      child.stderr.resume();
      timer = setTimeout(() => {
        killCliProcess(child, binPath);
        finish(false);
      }, timeoutMs);
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

/** env/file → keyring → 官方只读状态命令；任一明确证据存在即 configured。 */
export async function probeCredentialRuntime(
  def: AgentDef,
  binPath: string,
  opts: {
    platform?: NodeJS.Platform;
    listWindowsTargets?: () => Promise<string>;
    runStatusCommand?: () => Promise<boolean>;
  } = {},
): Promise<CredentialProbe> {
  const probed = await probeCredentialWithKeyring(def, opts);
  const command = def.credential.statusCommand;
  if (probed.status === 'configured' || !command) return probed;
  try {
    const configured = await (opts.runStatusCommand ??
      (() => runCredentialStatusCommand(binPath, command.args, command.timeoutMs ?? 3_000)))();
    return configured
      ? { status: 'configured', source: `command:${command.args.join(' ')}` }
      : probed;
  } catch {
    return probed;
  }
}

/** 解析 `MAJOR.MINOR.PATCH[-pre]`；解析不出来返回 undefined */
function parseVersion(v: string | undefined): { nums: [number, number, number]; pre: boolean } | undefined {
  if (!v) return undefined;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return undefined;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)],
    pre: Boolean(m[4]),
  };
}

/**
 * 版本是否满足最低要求。
 *
 * 只做「够不够跑 taskArgs」这一件事，不实现完整 semver 范围语法。
 * prerelease 视为低于同号正式版（`0.1.5-rc.3` < `0.1.5`），与 semver 一致。
 * 任一侧解析不出来就返回 true —— 宁可放行让人真跑一次，也不要因为版本字符串怪就判死。
 */
export function meetsMinVersion(actual: string | undefined, min: string): boolean {
  const a = parseVersion(actual);
  const b = parseVersion(min);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i]! !== b.nums[i]!) return a.nums[i]! > b.nums[i]!;
  }
  if (a.pre && !b.pre) return false;
  return true;
}

/** 探测单个工具（不抛错：任何异常都降级成 not_installed / installedButBroken） */
export async function probeAgent(def: AgentDef, externalSandbox = false): Promise<AgentListItem> {
  const binPath = await resolveBinAsync([def.bin, ...(def.altBins ?? [])]);
  // 图标按 kind 直接映射 assets/agent-icons/<kind>.svg，不额外维护一张表
  const logo = logoDataUri(def.kind);
  const base: AgentListItem = {
    kind: def.kind,
    display: def.display,
    status: 'not_installed',
    capability: def.capability,
    // 步骤流能力如实标注：纯文本工具 false，平台的步骤面板对它降级为空状态
    steps: def.steps !== undefined,
    executionModes: executionModesFor(def, externalSandbox),
    ...(logo ? { logo } : {}),
  };
  if (!binPath) {
    // 免安装工具：不落本地可执行文件，直接算「未装凭据」（装了 npx 就能跑）
    if (def.npxSpec) {
      const cred = await probeCredentialWithKeyring(def);
      return {
        ...base,
        status: cred.status === 'configured' ? 'ready' : 'installed_no_cred',
        path: `npx -y ${def.npxSpec}`,
        credentialSource: cred.source,
      };
    }
    return base;
  }
  const ver = await probeVersion(binPath);
  const cred = await probeCredentialRuntime(def, binPath);
  const status: AgentStatus = cred.status === 'configured' ? 'ready' : 'installed_no_cred';
  // 版本不够跑 taskArgs 也算「装坏」：否则平台会派任务下来，用户只看到一个 unknown option。
  const tooOld = def.minVersion !== undefined && !meetsMinVersion(ver.version, def.minVersion);
  return {
    ...base,
    executionModes: executionModesFor(def, externalSandbox, ver.version),
    status,
    version: ver.version,
    path: binPath,
    credentialSource: cred.source,
    installedButBroken: !ver.ok || tooOld,
  };
}
