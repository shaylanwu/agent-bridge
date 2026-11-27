# 任务清单：add-context-exhausted

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 错误码与分类器（低风险）

- [x] 1.1 `src/core/errors.ts`：`BRIDGE_ERROR_CODES` 加 `context_exhausted`，`ERROR_HTTP_STATUS.context_exhausted = 422`（23 → 24 个码，不递增协议版本）
- [x] 1.2 新文件 `src/core/context-overflow.ts`：`looksLikeContextOverflow(...texts)` 纯函数 + 导出 `CONTEXT_OVERFLOW_PATTERNS`；规则要求「上下文/token 量词」与「超限语义」同时命中
- [x] 1.3 `contracts/asyncapi-3.0.yaml`：`ErrorCode` 枚举加 `context_exhausted`
- [x] 1.4 单测 `test/context-overflow.test.ts`：各家真实文案正例（claude / OpenAI 兼容 / Gemini）+ 反例（401、额度、普通超时、无关句子里出现 context）

## 2. 结算拦截（高风险文件，须审批后实施）

- [x] 2.1 `Entry` 增输出尾部环形缓冲（stdout+stderr 合计 2 KiB），仅供失败分类使用，不参与上行
- [x] 2.2 `settle()` 增一道改判：`failed && errorCode === 'agent_error'` 且命中分类器 → `context_exhausted`；`error` 原文保留；success/cancelled/其它码不动
- [x] 2.3 单测 `test/supervisor-context-exhausted.test.ts`：真实 supervisor 接线，退出码 1 + stderr 超限文案 → `failed` + `context_exhausted`；不可识别文本仍 `agent_error`

## 3. 契约与文档

- [x] 3.1 README 中英错误码表各加一行（422、含义、与 `agent_error` 的区别）
- [x] 3.2 站点 `protocol/overview.md` 两语错误码表各加一行（`contracts:check` 强制存在性）
- [x] 3.3 `openspec/specs/session-gateway/spec.md`：去掉「⚠️ 尚未实现」块，改为规范行为；修掉重复的 `replay 会话` Scenario（含 Requirement 外的孤块）
- [x] 3.4 `openspec/project.md`：未实现能力台账去掉 `context_exhausted`

## 4. 验证与取证

- [x] 4.1 `npm run gate` 全绿（协议边界 / 文档一致性 / tsc / vitest / 构建 / 契约 / 提案格式 + 归档目录未动）；低并发全量 **69 文件 751 passed / 1 skipped**
- [x] 4.2 `npm run contracts:check` 全绿：受控错误码 31 个（含 `context_exhausted`），asyncapi 与站点两语均覆盖
- [x] 4.3 反向证据：`test/context-overflow.test.ts` 13 例负/正例（含 gRPC `context deadline exceeded`、`credit limit exceeded`、`401`、`--max-tokens 4096`）+ `test/supervisor-context-exhausted.test.ts` 三条「必须维持 agent_error」用例
- [x] 4.4 `grep -rn context_exhausted src/`：errors.ts 码表+状态码、context-overflow.ts 分类器、task-supervisor.ts settle 改判（3 处实质引用）

## 5. 归档

- [x] 5.1 `specs/session-gateway/spec.md` 增量已合并进正式 spec（含新增「上下文超限的反应式识别」Requirement，并修掉重复的 `replay 会话` Scenario）
- [ ] 5.2 由人工执行 `mv openspec/changes/add-context-exhausted openspec/changes/archive/<日期>-add-context-exhausted`
