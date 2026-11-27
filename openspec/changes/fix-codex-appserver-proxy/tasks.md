# 任务清单：fix-codex-appserver-proxy

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 代理与子进程环境

- [x] 1.1 `src/infra/proxy-env.ts`：`AGENT_BRIDGE_EXTERNAL_PROXY=off|none|false|0` → 不注入代理（其它值语义不变；用户自带的 HTTPS_PROXY 不动）
- [x] 1.2 `src/adapters/agent-adapters.ts`：codex 定义加 `preferSystemProxy: true`
- [x] 1.3 `src/adapters/codex-app-server.ts`：`CodexPromptOptions.env?`，缺省 `externalProxyEnv(withoutHostEnv(process.env))`（导出 `codexChildEnv` 便于测）
- [x] 1.4 stderr 持续消费 + 4 KiB 诊断尾部，挂到 turn 失败/退出/超时/JSON-RPC 错误消息；`onStderr` 旁路
- [x] 1.5 `turnDone` 创建即挂空 catch：握手期失败不再产生未处理拒绝（Node 默认会终止进程）
- [x] 1.6 单测：`test/proxy-env.test.ts` 4 例 / `test/codex-app-server.test.ts` 5 例 全绿（含 stderr 旁路与无订阅方不崩）

## 2. 可观测性（高风险文件，已获人工批准后实施）

- [x] 2.1 ~~`launchAppServer` 传 env~~ 不需要：适配器缺省 `codexChildEnv()` 已覆盖 app-server 通道，supervisor 无需改动
- [x] 2.2 `onCodexUpdate`：`codexNoticeText`（适配器侧纯函数）识别的 `error`(含 `willRetry`)/`warning`/`configWarning` → `hooks.onLog('stderr', '[codex] …')`；按前 160 字符去重，每任务上限 40 条
- [x] 2.3 单测：`test/supervisor-codex-notices.test.ts` 2 例——同一重连通知只上行一次、warning 原文上行、delta 不受影响（走真实 supervisor 接线，只 mock `runCodexPrompt`）

## 3. 验证与取证

- [x] 3.1 `npm run gate` 七项全绿（协议边界 / 文档一致性 / tsc / vitest / 构建 / 提案格式 / 归档目录）；`npm run harness:validate` 全绿
- [x] 3.2 **不设** `E2E_PROXY`，`E2E_AGENT=codex npm run e2e:gateway` → 全部通过（14 项断言 + A2A/ACP 全绿，约 70s 跑完）；修复前同一路径首个 token 要等 113s
- [x] 3.3 `E2E_INTERACTION=1 E2E_AGENT=kimi-code npm run e2e:gateway` 交互闭环 **17/17**（请求帧 1、已应答 1、终态 end_turn、选项 `approve_once`）
- [x] 3.4 规范合并：`openspec/specs/task-execution/spec.md` 的「agy 外部代理解析」已扩为「声明式外部代理解析（agy / codex）」，并新增「stderr 必须被消费」「回合 Promise 不得产生未处理拒绝」两条 Requirement

## 4. 归档

- [x] 4.1 `specs/task-execution/spec.md` 的增量已合并进 `openspec/specs/task-execution/spec.md`（2026-11-28）
- [ ] 4.2 由人工执行 `mv openspec/changes/fix-codex-appserver-proxy openspec/changes/archive/<日期>-fix-codex-appserver-proxy`
