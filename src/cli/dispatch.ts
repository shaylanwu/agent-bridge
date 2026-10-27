/**
 * 命令注册表与分发（CLI 支撑件）
 *
 * `src/cli.ts` 只做一件事：把 argv 交给 `dispatch()`。命令表在这里，
 * 新增命令 = 在 `src/commands/` 加一个文件 + 在这里加一行，入口文件零改动。
 */

import { cmdApprovals } from '../commands/approvals.js';
import { cmdConnect } from '../commands/connect.js';
import { cmdDaemon } from '../commands/daemon.js';
import { cmdLogout } from '../commands/logout.js';
import { cmdServe } from '../commands/serve.js';
import { cmdServices } from '../commands/services.js';
import { cmdStatus } from '../commands/status.js';
import { parseFlags, type Flags } from './flags.js';
import { help } from './help.js';
import { version } from './meta.js';
import { C } from './render.js';

export type CommandFn = (flags: Flags) => void | Promise<void>;

/** 命令表：`doc:check` 会核对这里与两份 README 的命令清单是否一致 */
export const COMMANDS: Record<string, CommandFn> = {
  connect: cmdConnect,
  serve: cmdServe,
  status: cmdStatus,
  logout: cmdLogout,
  services: cmdServices,
  approvals: cmdApprovals,
  daemon: cmdDaemon,
};

export async function dispatch(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const flags = parseFlags(argv);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(version());
    return;
  }

  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(C.red(`未知命令：${cmd}`));
    help();
    process.exit(2);
  }
  await fn(flags);
}
