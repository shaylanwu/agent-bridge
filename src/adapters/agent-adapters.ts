/**
 * 12 个 AI 编码 CLI 的适配器定义 + 本机探测（不读、不上传任何密钥内容）
 *
 * 探测口径与平台侧保持一致：
 *  - 先 which/where，再扫常见安装目录 + `%LOCALAPPDATA%\Programs\<厂商>\<产品>\bin`
 *  - 跑一次 `--version` 拿版本；找到 bin 但执行失败 → installedButBroken
 *  - 凭据只判「环境变量 / 凭据文件是否存在」，读到即停，内容不落内存更不上传
 */

import { execFileSync, spawn } from 'node:child_process';
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
  capability: AgentCapability;
  /** 非交互任务参数模板，`{{prompt}}` 由 runner 替换 */
  taskArgs: string[];
  /**
   * full 权限模式的**追加**参数（1.0 Phase 2），接在 taskArgs 之后。
   * 未声明 = 该工具没有已验证的 full 入口，请求 full 时在 spawn 前拒绝（不降级）。
   * 只有 bridge 采样这套 argv，平台不能传自定义 args（受管参数模式）。
   */
  fullArgs?: string[];
  /** 步骤流格式：有值 = 该工具支持 task_step（taskArgs 必须产出对应 JSONL 事件流） */
  steps?: StepFormat;
  /** 原生 resume 参数模板（含 {{sessionId}}）；仅对 help 已确认的工具声明 */
  resumeArgs?: string[];
  /** 原生 ACP 启动方式；未声明表示该 CLI 没有已验证的 ACP 入口 */
  acp?: AcpAgentSpec;
  /**
   * 该工具的 ACP 会话到底会不会发交互请求（缺省 `['permission','form']`）。
   *
   * 必须能显式声明空数组：实测 `dsh` 的 ACP 是 automation-only —— 工具调用直接放行、
   * **从不发 `session/request_permission`**。给它照拄声明 permission，平台就会一直等一个永远不会来的确认。
   */
  acpInteractionKinds?: InteractionKind[];
  credential: {
    /** 平台可代管 Key 的注入变量（有值才允许"绑定 Key"） */
    envKey?: string;
    envs: string[];
    files: string[];
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
    kind: 'gemini',
    display: 'Gemini CLI',
    bin: 'gemini',
    capability: 'interactive_only',
    // 步骤流：官方文档确认 stream-json（init/message/tool_use/tool_result/result）
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'stream-json'],
    // full：--yolo（沙箱是另一维度，不在此声明）
    fullArgs: ['--yolo'],
    steps: 'gemini-json',
    acp: { command: 'gemini', args: ['--acp'] },
    credential: {
      envKey: 'GEMINI_API_KEY',
      envs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      files: [join(home(), '.gemini', 'oauth_creds.json')],
      loginCommand: 'gemini',
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
    credential: { envs: ['MIMO_API_KEY'], files: [], loginCommand: 'mimo' },
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
    credential: { envs: [], files: [join(home(), '.qoder')], loginCommand: 'qodercli' },
  },
  {
    kind: 'grok-cli',
    display: 'Grok CLI',
    bin: 'grok',
    capability: 'interactive_only',
    // 修 bug（B 批次实测发现）：grok 没有 run 子命令（'run' 会被当成 prompt）；
    // 非交互是 --single，streaming-messages-json 输出与 claude 同构（实测 init/result 骨架）
    taskArgs: ['--single', '{{prompt}}', '--output-format', 'streaming-messages-json'],
    // full：--always-approve（沙箱是另一维度）
    fullArgs: ['--always-approve'],
    steps: 'claude-json',
    acp: { command: 'grok', args: ['agent', 'stdio'], authMethod: 'cached_token' },
    credential: {
      envKey: 'XAI_API_KEY',
      envs: ['XAI_API_KEY', 'GROK_API_KEY'],
      files: [join(home(), '.grok', 'user-settings.json')],
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
    taskArgs: ['exec', '--print', '--output-format', 'stream-json', '{{prompt}}'],
    // full：--yolo（不夸大不同版本的沙箱语义）
    fullArgs: ['--yolo'],
    steps: 'claude-json',
    acp: { command: 'traecli', args: ['acp'] },
    credential: { envs: [], files: [join(home(), '.trae')], loginCommand: 'traecli' },
  },
];

export function agentDefOf(kind: string): AgentDef | undefined {
  return AGENTS.find((a) => a.kind === kind);
}

/**
 * 按执行模式如实描述能力（1.0 `AgentListItem.executionModes`）。
 *
 * 为什么不能只报一个 `capability`：同一工具在 headless 与 ACP 下能做的事不一样 ——
 * headless 可能支持 full（危险参数），ACP 只走 default + 原生 permission 交互。
 * 混着报会让平台请求出「跑到一半才失败」的组合，所以这里逐模式列，未验证的一律不列。
 */
export function executionModesFor(def: AgentDef, externalSandbox = false): ExecutionModeCapability[] {
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
  if (def.acp) {
    modes.push({
      mode: 'acp-stdio',
      // ACP 走原生 permission 交互，不走「跳过审批」的 full 参数
      permissionModes: ['default'],
      // 逐工具如实声明：dsh 的 ACP 是 automation-only，实测不发权限/表单请求
      interactionKinds: def.acpInteractionKinds ?? ['permission', 'form'],
      // ACP 的 agent_message_chunk → messages、tool_call → steps；artifacts 暂无 ACP 来源
      feedKinds: ['messages', 'steps'],
      // ACP 会话由 agent 持有，bridge 只回传 ID（实测 9/9 都能续：session/load 或 session/resume）
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
const WIN_EXTS = ['.cmd', '.exe', '.bat', ''];
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
      const hits = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const usable = hits.find((p) => isExecutableFile(p));
      if (usable) return usable;
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
      const usable = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .find((p) => isExecutableFile(p));
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
      const cred = probeCredential(def);
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
  const cred = probeCredential(def);
  const status: AgentStatus = cred.status === 'configured' ? 'ready' : 'installed_no_cred';
  return {
    ...base,
    status,
    version: ver.version,
    path: binPath,
    credentialSource: cred.source,
    installedButBroken: !ver.ok,
  };
}
