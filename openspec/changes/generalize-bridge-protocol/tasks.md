# 实施清单：generalize-bridge-protocol

## 1. 第一期：收口与可协商

- [x] 1.1 建提案（proposal / tasks / design）
- [x] 1.2 `src/core/errors.ts`：受控错误码枚举（15 个）+ `BridgeError`，与 e2e-pilot design §7 对齐
- [x] 1.3 `protocol.ts` 增 `task_status.errorCode?`（可选，v1 兼容）
- [x] 1.4 `src/core/emitter.ts`：唯一上行出口（幂等 / 脱敏 / 审计 / CloudEvents 信封）
- [x] 1.5 幂等单测：settled 之后该 task 的 task_log / task_status 一律丢弃（P1-1）
- [x] 1.6 脱敏单测：家目录 → `~`，≥64 位 base64/hex 折叠（P1-2）
- [x] 1.7 `hello.capabilities` 增 `cloud-events`，并在两份 README 记载

## 2. 第二期：领域对象可实例化

- [x] 2.1 `src/core/task-supervisor.ts`：`class TaskSupervisor`，并发/队列/超时/取消内聚，可注入
- [x] 2.2 `src/runner.ts` 降级为 v1 兼容薄包装（现有调用方零改动）
- [x] 2.3 状态机显式化：`queued → running → settled`，settled 是吸收态；补状态迁移单测
- [x] 2.4 排队语义：`phase: 'queued'` + `queuePosition`（保持 status=running，v1 兼容）
- [x] 2.5 多实例隔离单测（旧实现的模块级单例会互相污染）
- [x] 2.6 目录分层：`core` / `transport` / `adapters` / `infra`；根目录只留 cli / protocol / runner

## 3. 第三期：标准信封与机器可读契约

- [x] 3.1 `contracts/asyncapi-3.0.yaml`：WS 通道的机器可读契约（双向全部消息 + 错误码）
- [x] 3.2 `contracts/openapi-3.1.yaml`：**平台需实现**的 4 个 HTTP 端点契约
- [x] 3.3 `scripts/gen-contracts.mjs`：从 `src/protocol.ts` / `src/core/errors.ts` 抽真源，支持 `--check`
- [x] 3.4 CloudEvents 1.0 信封（`toCloudEvent` + Emitter 开关），有单测
- [x] 3.5 `llms.txt`
- [x] 3.6 `contracts:check` 接入 `npm run gate`

## 4. 第四期：A2A 兼容层（按需，未启动）

- [ ] 4.1 任务状态映射表：A2A `TaskState` ↔ 本协议 `TaskStatus`
- [ ] 4.2 AgentCard 描述与发现端点（需真实需求再启动）

## 5. 护栏同步

- [x] 5.1 `protocol-boundary-check`：shell / 监听白名单按新路径更新；为回环控制面预留**有条件**口子
      （只绑回环 + 默认关闭 + 不返回 CORS 头）
- [x] 5.2 `doc-contract-check`：配置路径改 `src/infra/config.ts`；命令清单加 `services`；新增能力清单记载校验
- [x] 5.3 `always-on.md` 新增「分层与唯一出口」红线
- [x] 5.4 两份 README 补错误码 / 排队语义 / 机器可读契约 / 分层模块表

## 6. 归档

- [ ] 6.1 人工评审通过后合并 spec 增量进 `openspec/specs/`
- [ ] 6.2 提案目录移入 `openspec/changes/archive/YYYY-MM-DD-generalize-bridge-protocol/`
