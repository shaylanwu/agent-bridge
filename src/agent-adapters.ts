/**
 * 11 个 AI 编码 CLI 的适配器定义 + 本机探测（不读、不上传任何密钥内容）
 *
 * 探测口径与平台侧保持一致：
 *  - 先 which/where，再扫常见安装目录 + `%LOCALAPPDATA%\Programs\<厂商>\<产品>\bin`
 *  - 跑一次 `--version` 拿版本；找到 bin 但执行失败 → installedButBroken
 *  - 凭据只判「环境变量 / 凭据文件是否存在」，读到即停，内容不落内存更不上传
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AgentCapability, AgentListItem, AgentStatus } from './protocol.js';
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
  credential: {
    /** 平台可代管 Key 的注入变量（有值才允许"绑定 Key"） */
    envKey?: string;
    envs: string[];
    files: string[];
    loginCommand?: string;
  };
}

const home = (): string => homedir();
const appData = (): string => process.env.APPDATA ?? join(home(), 'AppData', 'Roaming');
const localAppData = (): string => process.env.LOCALAPPDATA ?? join(home(), 'AppData', 'Local');

const DSH_HOME = (): string => process.env.DSH_HOME ?? join(home(), '.dsh');

export const AGENTS: AgentDef[] = [
  {
    kind: 'claude-code',
    display: 'Claude Code',
    bin: 'claude',
    capability: 'non_interactive',
    taskArgs: ['-p', '{{prompt}}', '--output-format', 'text'],
    credential: {
      envKey: 'ANTHROPIC_API_KEY',
      envs: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      files: [join(home(), '.claude', '.credentials.json'), join(home(), '.claude.json')],
      loginCommand: 'claude',
    },
  },
  {
    kind: 'codex',
    display: 'Codex',
    bin: 'codex',
    capability: 'non_interactive',
    taskArgs: ['exec', '--json', '{{prompt}}'],
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
    taskArgs: ['--profile', 'headless', '{{prompt}}'],
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
    taskArgs: ['-p', '{{prompt}}'],
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
    taskArgs: ['run', '--json', '{{prompt}}'],
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
    taskArgs: ['run', '{{prompt}}'],
    credential: { envs: ['MIMO_API_KEY'], files: [], loginCommand: 'mimo' },
  },
  {
    kind: 'qoder-cli',
    display: 'Qoder CLI',
    bin: 'qoder',
    capability: 'interactive_only',
    taskArgs: ['exec', '{{prompt}}'],
    credential: { envs: [], files: [join(home(), '.qoder')], loginCommand: 'qoder' },
  },
  {
    kind: 'grok-cli',
    display: 'Grok CLI',
    bin: 'grok',
    capability: 'interactive_only',
    taskArgs: ['run', '{{prompt}}'],
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
    taskArgs: ['--headless', '{{prompt}}'],
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
    taskArgs: ['run', '{{prompt}}'],
    credential: { envs: ['MINIMAX_API_KEY'], files: [], loginCommand: 'mcode' },
  },
  {
    kind: 'trae-cli',
    display: 'Trae CLI',
    bin: 'traecli',
    capability: 'interactive_only',
    taskArgs: ['run', '{{prompt}}'],
    credential: { envs: [], files: [join(home(), '.trae')], loginCommand: 'traecli' },
  },
];

export function agentDefOf(kind: string): AgentDef | undefined {
  return AGENTS.find((a) => a.kind === kind);
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
    for (const dir of candidateBinDirs()) {
      const exts = process.platform === 'win32' ? WIN_EXTS : [''];
      for (const ext of exts) {
        const p = join(dir, name + ext);
        if (isExecutableFile(p)) return p;
      }
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
): VersionProbe {
  try {
    // 只认 stdout 里的版本号：失败时 stderr 常混着 Node/系统的噪声（如 "Node.js v24.11.1"），
    // 拿它当工具版本会显示成「装坏 24.11.1」，非常误导。
    // Windows 的 .cmd 垫片经 cmd.exe 执行（路径带空格也不会断，见 win-exec.ts）
    const out = isWinShim(binPath)
      ? execFileSync(buildWinCommandLine(binPath, args), {
          encoding: 'utf8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      : execFileSync(binPath, args, {
          encoding: 'utf8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    return { ok: true, version: VERSION_RE.exec(out)?.[1] };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // 失败时不猜版本：只有 stdout 里明确出现过版本号才回填
    const version = VERSION_RE.exec(err.stdout ?? '')?.[1];
    const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return { ok: false, version, error: line?.slice(0, 200) };
  }
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
export function probeAgent(def: AgentDef): AgentListItem {
  const binPath = resolveBin([def.bin, ...(def.altBins ?? [])]);
  const base: AgentListItem = {
    kind: def.kind,
    display: def.display,
    status: 'not_installed',
    capability: def.capability,
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
  const ver = probeVersion(binPath);
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
