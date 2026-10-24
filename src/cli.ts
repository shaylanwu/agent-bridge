#!/usr/bin/env node
/**
 * agent-bridge 入口
 *
 * 这个文件**只做分发**：argv → `cli/dispatch.ts` → `commands/<name>` → `app/`。
 * 任何业务逻辑都不许写在这里 —— 之前它同时承担了参数解析、终端渲染、授权交互、
 * 平台指令编排和任务回传，548 行里塞了五个职责，改一处要读完全文。
 *
 * 现在的分层（依赖单向，无环）：
 *
 *   cli.ts ─▶ cli/(参数·渲染·帮助·分发) ─▶ commands/(命令实现) ─▶ app/(用例编排)
 *                                                                    ─▶ core / transport / adapters / infra
 *
 *   agent-bridge connect <platformUrl> [--token=xxx] [--label=name] [--no-browser]
 *   agent-bridge status [--json] [--fresh]
 *   agent-bridge logout
 *   agent-bridge services issue|list|revoke|rotate
 *   agent-bridge daemon start|stop|install|uninstall
 *   agent-bridge --version
 */

import { dispatch } from './cli/dispatch.js';
import { C } from './cli/render.js';

void dispatch(process.argv.slice(2)).catch((e: unknown) => {
  console.error(C.red(`❌ ${(e as Error).message}`));
  process.exit(1);
});
