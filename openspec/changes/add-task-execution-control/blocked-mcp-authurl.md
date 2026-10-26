# 阻塞清单：MCP elicitation / auth-url 真实链路

> 状态：**阻塞中**，不勾选 7.8 / 9.8 / 9.21 的端到端项。
> 阻塞原因：生产端不在本仓库；bridge 强行实现只能造假链路。

## A. Form elicitation → 平台交互

> 2026-10-26 决策：**走 ACP 扩展**，不代理 agent 的 MCP 流量。MCP 宿主仅服务 bridge 自己启动的 server。

### 已完成（ACP 通道）

- [x] ACP 扩展 `session/request_form`：message、requestedSchema、requestId、expiresAt
- [x] `session/request_form` → `task_interaction_request kind=form`
- [x] `task_interaction_response` → ACP JSON-RPC result `{action, content?}`
- [x] accept/decline/cancel 映射
- [x] 真实 stdio 假 ACP server 测试

### 仍待平台/agent 侧

- [ ] agent 真实产生 `session/request_form`（当前只有桥接与假 server 验证）
- [ ] 明确 secret 字段禁止走 Form 的 schema 约束

### bridge 侧仍需补

- [x] schema 校验 accept content（required / type）
- [x] secret 字段拒绝（递归 key 检查）
- [x] result 不回显 content（只落 action + fieldNames）
- [ ] 断线重连后按 requestId + resultSeq 重放
- [ ] 时间线测试：pending → submitted → resolved / expired / cancelled
- [ ] 与 `InteractionBroker` / scope / tenant 对齐

## B. auth-url 真实生产者

### 前置条件（e2e-pilot / 部署侧）

- [ ] 明确谁发起登录 URL
- [ ] 明确 TTL、一次性、撤销语义
- [ ] 明确平台取 URL 的方式（`get_interaction_url` 或推送）
- [ ] 提供真实 OAuth/设备码流程，不在 bridge 内保存 secret

### bridge 侧（前置完成后）

- [ ] adapter 发 `session/request_auth_url` 或等价事件
- [ ] URL 只进 `InteractionUrlVault`，事件只写 `urlHost/hash/TTL`
- [ ] `get_interaction_url` 联调真实流程
- [ ] 日志/DB/snapshot 全链路扫描：不得出现完整 URL/token
- [ ] 过期 → `interaction_url_expired`，撤销 → not_found
- [ ] 断线重连 / 多客户端取 URL 的一致性

## 当前已完成、可复用

- `src/adapters/mcp-elicitation.ts`：MCP stdio 客户端、`elicitation/create`、accept/decline/cancel
- `InteractionUrlVault`：TTL、过期/缺失区分、注册时机会式清理
- `SessionStore.requestInteraction`：`kind=auth-url` 拒绝带 `url` 的 payload
- 合成测试：snapshot 不含真实 URL

## 验收口径

只有拿到外部真实样例并跑通后，才勾 7.8 / 9.8 / 9.21 的端到端项；
transport-only 测试不得当作全链路完成。
