# 变更提案：Codex app-server 子进程的环境与代理（修「交互模式回合挂死」）

## Why

2026-11-27 用网关 e2e 的交互段跑 codex，结果被记成「**交互模式回合挂死**」：SSE 只收到
`prompt` → `update` → 9 次 heartbeat，`/v1/interactions?state=pending` 为空，150s 后超时判失败。
当时的猜测是「`interactive` 把 stdin 从 `ignore` 改成 `pipe` 导致子进程不退出」。**这个猜测是错的**，
逐项复核后真实原因是两个叠加的桥接侧缺陷：

### 证据一：挂死与交互开关无关

用与 `runCodexPrompt` 完全相同的握手（`initialize` → `thread/start(approvalPolicy=on-request)` →
`turn/start`）直接驱动 `codex app-server --stdio`（codex-cli 0.171.0），**非交互路径（approval 恒
`decline`）同样挂**：

```
[2.7s]  turn/start 已受理
[19.4s] item/started userMessage
[49.7s] error  Reconnecting... 2/5  responseStreamDisconnected  request timed out
[65.1s] error  Reconnecting... 3/5
[80.8s] error  Reconnecting... 4/5
[97.5s] error  Reconnecting... 5/5
[113.7s] warning Falling back from WebSockets to HTTPS transport. request timed out
[116.2s] item/agentMessage/delta  ← 首个 token 才出现
```

同一条命令加上本机系统代理（`HTTPS_PROXY=http://127.0.0.1:7897`）后：

```
[8.1s]  item/agentMessage/delta  ← 首个 token
```

即 codex 0.171 默认用 responses **WebSocket** 通道，本机直连该通道不可用；它会重试 5 次
（~113s）再回退 HTTPS。

### 证据二：桥接没有把代理交给 codex，且这段时间完全静默

- `runCodexPrompt` 里 `spawnCliProcess(..., { env: process.env })` —— **原样继承**，既没走
  `withoutHostEnv` 清理，也没走 `externalProxyEnv` 注入。用户从桌面/终端启动 bridge 时环境里
  通常**没有** `HTTPS_PROXY`（Windows 用户靠系统代理），于是 codex 每回合先空转 ~113s。
  同仓的 agy 早已按「显式 `AGENT_BRIDGE_EXTERNAL_PROXY` → Windows 系统代理」处理
  （`infra/proxy-env.ts` + `AgentDef.preferSystemProxy`），codex 是漏网的那个。
- 这 113s 里 codex 只发 `error` / `warning` 通知，而 `onCodexUpdate` 只处理
  `item/agentMessage/delta` 与 `item/started|completed`，**其余一律丢弃**：
  平台侧 113s 一个字都收不到，外观与「回合挂死」一模一样。这是本次误判的直接成因。

### 证据三：补上代理后同一套 e2e 恢复正常

`E2E_INTERACTION=1 E2E_AGENT=codex E2E_PROXY=http://127.0.0.1:7897 npm run e2e:gateway`：
主套件 16/16 在 60s 内全部通过（A2A 任务到 `COMPLETED`、ACP 两轮 `BANANA42` 记忆）。
`E2E_PROXY` 是给 e2e 打的补丁，**真实用户不会设** —— 所以修在桥接侧。

## What Changes

1. **codex app-server 子进程环境统一**（`src/adapters/codex-app-server.ts`）
   `CodexPromptOptions` 增可选 `env`；缺省值改为 `externalProxyEnv(withoutHostEnv(process.env))`，
   与 headless / ACP 通道同一套「宿主环境清理 + 代理解析」语义。顺带修掉现在 codex 子进程
   继承 `CODEBUDDY_SESSION_ID` 等宿主上下文的问题。
1b. **stderr 必须被读走**（同文件）
   codex app-server 目前**完全没有读 `child.stderr`**：①配置告警、重连/回退提示、失败栈全部丢失，
   失败只剩一个退出码；②`pipe` 缓冲（64 KiB）写满后子进程会阻塞在 `write` 上，协议流停摆、
   外部只看到 heartbeat —— 这正是 ACP 通道早就踩过并已修好的形态
   （`acp-codebuddy.ts` 的 `createStderrTail` 注释即为此）。改为持续消费 + 4 KiB 尾部，
   并作为 `turn/completed`/退出/超时/JSON-RPC 错误消息的诊断后缀；另加 `onStderr` 旁路供上层记日志。
1c. **握手期失败不再抛未处理拒绝**（同文件）
   测试暴露：`turnDone` 在 `initialize` 阶段就 rejected 时尚未被 `await`，rejection 变成
   unhandled（Node 默认终止进程）—— 即「codex 一开始就崩」会把 bridge 一起带走。改为创建后立即
   挂一个空 `catch` 标记已处理，后续 `await turnDone` 仍正常抛错。
2. **codex 适配器声明代理偏好**（`src/adapters/agent-adapters.ts`）
   `preferSystemProxy: true`：headless（含 `full`）通道同步生效，`AGENT_BRIDGE_EXTERNAL_PROXY` 优先。
3. **`error` / `warning` 通知不再被吞**（`src/core/task-supervisor.ts`，**高风险文件，已获人工批准**）
   `onCodexUpdate` 增一条分支：`error`（含 `willRetry`）、`warning`、`configWarning` 转
   `hooks.onLog('stderr', '[codex] …')`，内容带 `message` 与 `additionalDetails`；
   格式压成一行由适配器侧的纯函数 `codexNoticeText` 负责（便于单测），supervisor 只做去重
   （前 160 字符为键，单任务上限 40 条），避免重连风暴刷屏。
4. **代理关闭逃生口**（`src/infra/proxy-env.ts`）
   `AGENT_BRIDGE_EXTERNAL_PROXY` 显式设为 `off` / `none` 时**不注入任何代理**。没有这个开关，
   系统代理配错或代理不可用的用户就只能改注册表才能让 codex 直连。
5. **测试**
   - `test/codex-app-server.test.ts`：env 默认值（显式代理 / 系统代理 / `off`）与 error→log 映射；
   - `test/proxy-env.test.ts`：`off`/`none` 关闭语义；
   - 回归：`test/supervisor-*` 现有用例保持全绿（`error` 通知不影响 delta 与 step 语义）。

**不做**：不改 wire 协议、不改 `PROTOCOL_VERSION`、不新增错误码、不替换 codex 的 WebSocket 传输
（那是 CLI 内部行为，我们没有开关可用：`codex features list` 里 `responses_websockets*` 均为
`removed`）。

## Impact

- 高风险文件：`src/core/task-supervisor.ts`（须审批后实施）。
- 行为（正面）：本机 codex 首个 token 从 ~113s 降到 ~8s；失败/重连不再静默。
- 行为（风险）：`preferSystemProxy: true` 后，系统代理存在但不可用的机器上 codex 会比以前更早
  失败（以前是空转 113s 后回退直连）。逃生口是 `AGENT_BRIDGE_EXTERNAL_PROXY=off`。
- 契约与文档：无 wire 变化；`openspec/specs/task-execution/spec.md` 的代理章节从 agy 扩到
  「声明了 `preferSystemProxy` 的工具（agy、codex）」。

## 验收标尺

1. `npm run gate` 全绿；`npm run harness:validate` 全绿。
2. `test/codex-app-server.test.ts` / `test/proxy-env.test.ts` 新增用例先红后绿。
3. 端到端：**不设** `E2E_PROXY`，`E2E_AGENT=codex npm run e2e:gateway` 主套件在 150s 内跑完，
   任务日志里出现 codex 的重连/回退提示（而不是静默）。
4. 交互闭环证据仍由 kimi-code 提供（`E2E_INTERACTION=1 E2E_AGENT=kimi-code`，17/17）：
   本机 codex 0.171 在 app-server 与 `exec` 两条通道都不发起工具调用（实测 `codex exec` 对
   「跑 echo」的请求 100s 内只出 reasoning、无 `commandExecution` 项），**属该 CLI 本机模型/工具
   配置问题，不是桥接缺陷**，故 codex 的 permission 闭环本轮取不到证据，规范里如实写明。
