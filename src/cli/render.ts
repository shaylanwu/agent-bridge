/**
 * 终端渲染（CLI 支撑件）
 *
 * 只有 `cli/` 与 `commands/` 依赖它；`app/` 层**不许**直接碰终端 ——
 * 否则「本地控制面板」「单元测试」想复用同一段逻辑时会被 stdout 绑死。
 */

import type { AgentListItem } from '../protocol.js';

const tty = (): boolean => process.stdout.isTTY === true;
const paint = (code: string, s: string): string => (tty() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const C = {
  dim: (s: string) => paint('2', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  red: (s: string) => paint('31', s),
  blue: (s: string) => paint('34', s),
  underline: (s: string) => paint('4', s),
  bold: (s: string) => paint('1', s),
};

export const STATUS_LABEL: Record<AgentListItem['status'], string> = {
  ready: '就绪',
  installed_no_cred: '缺凭据',
  not_installed: '未装',
};

export const out = {
  line: (s = '') => console.log(s),
  info: (s: string) => console.log(C.dim(s)),
  ok: (s: string) => console.log(C.green(s)),
  warn: (s: string) => console.log(C.yellow(s)),
  error: (s: string) => console.error(C.red(s)),
  fatal: (s: string): never => {
    console.error(C.red(s));
    process.exit(2);
  },
};

export function printAgents(items: AgentListItem[]): void {
  const rows = items.map((a) => {
    const name = a.display.padEnd(18);
    const ver = (a.version ?? (a.path?.startsWith('npx ') ? 'npx 免安装' : '-')).padEnd(20);
    // 找到二进制但执行失败时，「就绪」是假象，直接标「装坏」
    const label = a.installedButBroken ? '装坏' : STATUS_LABEL[a.status];
    const painted = a.installedButBroken
      ? C.red(label)
      : a.status === 'ready'
        ? C.green(label)
        : a.status === 'installed_no_cred'
          ? C.yellow(label)
          : C.dim(label);
    return `${name} ${ver} ${painted}`;
  });
  console.log(C.bold('\n工具                 版本                 状态'));
  console.log(C.dim('─'.repeat(58)));
  for (const r of rows) console.log(r);
  const ready = items.filter((a) => a.status === 'ready' && !a.installedButBroken).length;
  console.log(C.dim(`\n共 ${items.length} 个工具，可用 ${ready} 个\n`));
}
