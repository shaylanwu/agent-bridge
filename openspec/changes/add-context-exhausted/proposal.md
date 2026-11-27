# 变更提案：`context_exhausted` 落地为「反应式识别」，不做上下文预算表

## Why

`openspec/specs/session-gateway/spec.md` 的「适配器会话策略」从 1.0 起就写着
「模型上下文不足回 `context_exhausted`，不静默截断」，但 2026-11-28 全仓核对的结果是：

- `src/` 里 **零引用**；`BRIDGE_ERROR_CODES`、`contracts/asyncapi-3.0.yaml` 的 `ErrorCode` 枚举、
  README 错误码表、站点总览页，**都没有这个 code**。
- 归档提案 `add-task-execution-control` 的 tasks 里留着一句如实说明：
  「`context_exhausted` 未实现 —— 没有模型上下文预算表就无法判定『超限』，宁可不报也不虚报。」

于是现状是**规范描述了一个不存在的错误码**：客户端若按 spec 写 `if (code === 'context_exhausted')`
分支，永远走不到。这是文档失真，不是能力缺失 —— 但两者都必须在 1.x 内收口。

### 为什么不做预算表

原判断的前提是「要先知道模型上下文窗口才能判定超限」。这个前提**只在预测式判定下成立**，
而预测式判定本身不可靠：

- 12 个适配器背后是各家 CLI，模型可被用户随时切换（`--model`、配置文件、服务端路由），
  桥接拿不到稳定的「本次实际模型 → 窗口大小」映射；
- 就算拿到，token 计数还要与各家的分词器一致，误差累积到阈值附近必然误报；
- 误报的代价是**把能成功的任务提前判死**，比不报更坏。

### 采用反应式识别

真实世界里「超上下文」不是桥接算出来的，而是 **CLI 自己报出来的**：claude 的
`prompt is too long: 213456 tokens > 200000 maximum`、OpenAI 兼容端的 `context_length_exceeded`、
Gemini 的 `The input token count exceeds the maximum number of tokens allowed`。
这些文本已经随着失败回合流到桥接里（`child.stderr`、stream-json 的 `result` 错误、ACP 的 error 帧、
app-server 的 JSON-RPC error），只是现在统一被压成 `agent_error`，平台无法区分
**「重试没用，去开新会话」**和**「CLI 崩了，重试可能有用」**。

所以做法是：**只在失败结算处做文本分类，识别不出来就维持 `agent_error`**（不猜、不虚报）。

## What Changes

1. **新增受控错误码** `context_exhausted`（`src/core/errors.ts`）
   `ERROR_HTTP_STATUS.context_exhausted = 422`（沿用 `add-task-execution-control/design-full.md`
   的设计：请求语义上无法处理 —— 历史太长，不是服务端故障，也不是 4xx 参数错）。
   受控错误码 23 → 24，协议版本仍为 1（新增错误码不递增版本，与既有约定一致）。
2. **分类器**（新文件 `src/core/context-overflow.ts`）
   纯函数 `looksLikeContextOverflow(...texts)`：一组精确正则，必须**同时**满足「上下文/token 量词」+
   「超限动词」，避免把普通 401/额度错误误判。导出 `CONTEXT_OVERFLOW_PATTERNS` 便于测试与后续扩词。
3. **唯一拦截点：`settle()`**（`src/core/task-supervisor.ts`，**高风险文件，须审批**）
   `settle()` 是所有通道（headless spawn / claude stream / codex app-server / ACP）的**唯一终态漏斗**。
   在其中加一道：`status === 'failed' && info.errorCode === 'agent_error'` 且
   `looksLikeContextOverflow(info.error, entry.tail)` 时，把 `errorCode` 改判为 `context_exhausted`。
   `error` 原文保留（人类可读文案不覆盖），`status` 仍是 `failed`（**不新增状态**，wire 不变）。
   - 需要在 `Entry` 上保留一个**输出尾部环形缓冲**（stdout+stderr 合计上限 2 KiB，仅用于失败分类）：
     很多 CLI 把超限报在 stderr，而 `info.error` 只有一句「CLI 退出码 1」。
4. **契约与文档同步**
   - `contracts/asyncapi-3.0.yaml` 的 `ErrorCode` 枚举加 `context_exhausted`；
   - README 中英错误码表加一行；
   - 站点 `protocol/overview.md` 两语错误码表加一行（`contracts:check` 会强制）；
   - `openspec/specs/session-gateway/spec.md`：删掉「⚠️ 尚未实现」说明，改为规范行为；
     顺带修掉同一处**重复的 `replay 会话` Scenario**（一个在 Requirement 内、一个是孤块）；
   - `openspec/project.md` 的「未实现能力」台账去掉这一条。
5. **测试**
   - `test/context-overflow.test.ts`：分类器正负例（各家真实报错文案 + 反例：401、额度、普通超时、
     「context」出现在无关句子里）；
   - `test/supervisor-context-exhausted.test.ts`：真实 supervisor 接线，CLI 退出码 1 + stderr 含
     超限文案 → `failed` + `context_exhausted` + `error` 保留原文；无法识别的失败仍是 `agent_error`。

**不做**：不做预测式预算表；不自动裁剪/截断历史（「不静默截断」仍是硬约束）；不新增 wire 状态；
不改 `PROTOCOL_VERSION`；不为单个 CLI 写死专属分支（分类器是通用文本规则）。

## Impact

- 高风险文件：`src/core/task-supervisor.ts`（`settle()` + `Entry.tail`），须审批后实施。
- 行为（正面）：平台可程序化区分「开新会话」与「重试」；replay 超长的失败不再伪装成 `agent_error`。
- 行为（风险）：分类器误判会把本该 `agent_error` 的失败标成 `context_exhausted`。缓解：规则要求
  「上下文量词 + 超限动词」同时命中，且**只在 `agent_error` 分支上生效**，不改变任何成功路径。
- 协议：仅新增一个受控错误码，无 wire 结构变化，`PROTOCOL_VERSION` 保持 1。

## 验收标尺

1. `npm run gate` + `npm run harness:validate` + `npm run contracts:check` 全绿
   （新增 code 必须被 asyncapi 与站点两语覆盖，否则 gate 红）。
2. 新增两个测试文件先红后绿；全量 vitest 不回归。
3. `grep -rn context_exhausted src/` 有真实实现引用（不再是零引用文档）。
4. 反向证据：构造 `401` / `credit limit exceeded` 等文本，分类器返回 false，
   结算仍是 `agent_error`。
