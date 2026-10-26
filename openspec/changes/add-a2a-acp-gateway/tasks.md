# 实施清单：add-a2a-acp-gateway

> 状态：2026-10-26 立项，未开始编码。先做映射与只读，再做写入与交互。

## 1. 契约与映射

- [ ] 1.1 写 A2A `TaskState` ↔ `TaskStatus` 映射表与纯函数测试
- [ ] 1.2 写 `task_message` / `task_artifact` ↔ A2A `Message` / `Artifact` 映射
- [ ] 1.3 写 ACP `session/prompt` / permission / form / cancel 映射
- [ ] 1.4 明确 `task_log` 只作为调试扩展，不冒充标准消息

## 2. A2A 网关

- [ ] 2.1 `GET /.well-known/agent-card.json`，声明真实能力
- [ ] 2.2 `tasks/get` 只读，按 tenant 隔离
- [ ] 2.3 `message/send` 创建任务，复用 TaskSupervisor
- [ ] 2.4 `tasks/cancel` 幂等取消
- [ ] 2.5 `tasks/resubscribe` 用 `eventSeq` 补洞

## 3. ACP server

- [ ] 3.1 `initialize` / `session/new`
- [ ] 3.2 `session/prompt` 映射到 `run_task`
- [ ] 3.3 `session/cancel` 映射到 `cancel_task` / `cancel_turn`
- [ ] 3.4 permission / form / auth-url 交互映射
- [ ] 3.5 超时、断线、取消、畸形帧测试

## 4. 安全与运维

- [ ] 4.1 默认关闭、回环绑定、token/JWT 鉴权
- [ ] 4.2 跨租户 404 与 scope 测试
- [ ] 4.3 不返回 CORS、不日志泄漏 secret
- [ ] 4.4 契约文档与 site 页面

## 5. 收尾

- [ ] 5.1 端到端：A2A send/get/cancel、ACP prompt/permission
- [ ] 5.2 人工评审
- [ ] 5.3 归档并合并 spec
