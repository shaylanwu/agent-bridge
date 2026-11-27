# 任务清单：add-interaction-optin

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 控制面 HTTP 入口

- [x] 1.1 `CreateTaskInput` 增 `allowInteractive?: boolean`；`allocate()` 写入 turn.execution，`startTask` 传 `interactive: allowInteractive === true && defaults.interactionEnabled === true`（createTaskCore 已实现）
- [x] 1.2 `POST /v1/tasks` 解析 `allowInteractive`：只接受布尔，其它类型 400（复用 `protocol_incompatible`，不新增错误码）
- [x] 1.3 `defaults.interactionEnabled` 从 `BridgeSession` 暴露并接线（`connect.ts` / `serve.ts`），与 dispatch 同一真源
- [x] 1.4 单测：未申请 / 申请但进程未开 / 申请且已开 三态；非布尔入参 400（control-plane.test.ts 新增 4 例，44 passed）

## 2. ACP 网关

- [x] 2.1 `session/new` 解析 `_meta.allowInteractive`（严格布尔），固化进 `acpSessions`
- [x] 2.2 首轮 `conversation.run` 带 `allowInteractive`；续轮由 turn.execution 继承（conversation 既有语义，`turn.execution.allowInteractive` 已在 1.3 用例中断言）
- [x] 2.3 单测：`_meta.allowInteractive=true` → `conversation.run` 收到 `allowInteractive: true`（gateway-acp.test.ts 新增 3 例，17 passed）

## 3. A2A 边界

- [x] 3.1 `message.metadata.allowInteractive === true` → `-32000` + `data.code='interaction_not_supported'`（不静默降级）
- [x] 3.2 单测：该请求被拒绝且**未创建任务**（gateway-a2a.test.ts 新增 1 例，22 passed）

## 4. 契约与文档

- [x] 4.1 `contracts/openapi.control-plane.yaml`：`POST /v1/tasks` 增 `allowInteractive`（boolean，可选）——`contracts:check` 通过
- [x] 4.2 README（中英）：控制面任务申请交互的写法与前置（`--interaction-enabled`）；ACP `session/new` 的 `_meta.allowInteractive`；**A2A 不支持交互**如实写明——`doc:check` 通过
- [x] 4.3 `openspec/specs/external-gateway/spec.md` 增量已写入本提案 `specs/`（归档时合并）

## 5. 验证

- [x] 5.1 `npm run gate` 全绿；低并发全量 **66 文件 725 passed / 1 skipped**
- [x] 5.2 真实 CLI 端到端：`E2E_INTERACTION=1 E2E_AGENT=kimi-code npm run e2e:gateway` **17/17**——请求帧 1、已应答 1、终态 end_turn、选项 `[{method:session/request_permission, options:3, optionId:approve_once}]`
- [x] 5.3 实测：kimi-code 会发权限请求；opencode / minimax-code 自动放行（回合正常结束、无请求帧）→ 交互段改为 `E2E_INTERACTION=1` 显式启用，收不到请求帧时打印原因且**不记为通过**。另发现 codex 在交互模式下回合挂死（stdin `ignore`→`pipe` 差异，属 supervisor 高风险文件，另立修复）

## 6. 归档

- [x] 6.1 `specs/external-gateway/spec.md` 的增量已合并进 `openspec/specs/external-gateway/spec.md`（2026-11-28：ACP 交互申请 + A2A 边界两条 Requirement，端到端验证段同步注明 permission 有真 CLI 证据、form 无）
- [ ] 6.2 由人工执行 `mv openspec/changes/add-interaction-optin openspec/changes/archive/<日期>-add-interaction-optin`
