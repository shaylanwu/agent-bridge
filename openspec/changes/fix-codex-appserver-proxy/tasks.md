# 任务清单：fix-codex-appserver-proxy

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 代理与子进程环境

- [x] 1.1 `src/infra/proxy-env.ts`：`AGENT_BRIDGE_EXTERNAL_PROXY=off|none|false|0` → 不注入代理（其它值语义不变；用户自带的 HTTPS_PROXY 不动）
- [x] 1.2 `src/adapters/agent-adapters.ts`：codex 定义加 `preferSystemProxy: true`
- [x] 1.3 `src/adapters/codex-app-server.ts`：`CodexPromptOptions.env?`，缺省 `externalProxyEnv(withoutHostEnv(process.env))`（导出 `codexChildEnv` 便于测）
- [x] 1.4 stderr 持续消费 + 4 KiB 诊断尾部，挂到 turn 失败/退出/超时/JSON-RPC 错误消息；`onStderr` 旁路
- [x] 1.5 `turnDone` 创建即挂空 catch：握手期失败不再产生未处理拒绝（Node 默认会终止进程）
- [x] 1.6 单测：`test/proxy-env.test.ts` 4 例 / `test/codex-app-server.test.ts` 5 例 全绿（含 stderr 旁路与无订阅方不崩）

## 2. 可观测性（高风险文件，需人工审批；本轮未实施）

- [ ] 2.1 ~~`launchAppServer` 传 env~~ 不需要：适配器缺省 `codexChildEnv()` 已覆盖 app-server 通道，supervisor 无需改动
- [ ] 2.2 `src/core/task-supervisor.ts` `onCodexUpdate`：`error`（含 `willRetry`）/`warning` → `hooks.onLog('stderr', …)`，同 `code` 去重（**待审批**）
- [ ] 2.3 单测：mock `runCodexPrompt` 注入 error 通知，断言产生了 stderr 日志且只出现一次

## 3. 验证与取证

- [x] 3.1 `npm run gate` 七项全绿（协议边界 / 文档一致性 / tsc / vitest / 构建 / 提案格式 / 归档目录）；`npm run harness:validate` 全绿
- [x] 3.2 **不设** `E2E_PROXY`，`E2E_AGENT=codex npm run e2e:gateway` → 全部通过（14 项断言 + A2A/ACP 全绿，约 70s 跑完）；修复前同一路径首个 token 要等 113s
- [x] 3.3 `E2E_INTERACTION=1 E2E_AGENT=kimi-code npm run e2e:gateway` 交互闭环 **17/17**（请求帧 1、已应答 1、终态 end_turn、选项 `approve_once`）
- [ ] 3.4 规范合并：`openspec/specs/task-execution/spec.md` 代理章节从 agy 扩到「声明 `preferSystemProxy` 的工具」（评审后执行）

## 4. 归档

- [ ] 4.1 评审通过后把 `specs/task-execution/spec.md` 的增量合并进 `openspec/specs/task-execution/spec.md`
- [ ] 4.2 由人工执行 `mv openspec/changes/fix-codex-appserver-proxy openspec/changes/archive/<日期>-fix-codex-appserver-proxy`
