# 实施清单：add-local-control-plane

> 状态：**已实施（C1~C4 全量）**，等人工评审与归档。
> 用户 2026-10-23 授权："可以作为扩展去实现它，但不要与主系统打架，主次分明"。

## 0. 决策

- [x] 0.1 用户确认实施，且明确"作为扩展、不动主系统"（全量 C1~C4）

## 1. 提案与护栏

- [x] 1.1 建 `proposal.md` / `design.md` / `tasks.md`
- [x] 1.2 护栏放开：监听白名单改为 `src/infra/auth.ts` + `src/transport/control-plane.ts`，
      且强制"绑定回环 + 默认关闭 + 不返回 CORS 头"（三者缺一即 fail，不是简单放行）
- [x] 1.3 `always-on.md` §4「只绑回环 + 默认关闭」已写入（2026-10-23 随分层同步）
- [x] 1.4 README 安全边界表新增"控制面：回环 / 默认关闭 / 不出网"（两份 README 同步）

## 2. C1：骨架与只读端点

- [x] 2.1 `src/transport/control-plane.ts`：`node:http`，只绑回环，`enabled` 默认 false
      （`settings.enabled === false` 直接拒绝启动，一个端口都不监听）
- [x] 2.2 scope 中间件（复用 `src/infra/service-token.ts` 的 `verifyServiceToken`，不引入第二套身份）
- [x] 2.3 `/v1/health` `/v1/capabilities` `/v1/agents` `/v1/agents:scan`
- [x] 2.4 单测：无令牌 401、scope 不足 403、绝不返回 CORS 头、非回环来源 403、enabled=false 拒绝启动

## 3. C2：任务端点

- [x] 3.1 `POST /v1/tasks`（`Idempotency-Key`）、`GET /v1/tasks`（游标）、`GET /v1/tasks/{id}`
- [x] 3.2 `POST /v1/tasks/{id}:cancel`（幂等；已终态返回 `alreadySettled`；平台下发的任务 409 —— 不越权代杀）
- [x] 3.3 统一走 `TaskSupervisor`：控制面下发的任务与 WS 下发的共享并发上限与队列
- [x] 3.4 单测：幂等键重放只跑一次（返回同一 taskId）；取消幂等

## 4. C3：事件与产物

- [x] 4.1 `GET /v1/tasks/{id}/events`（SSE：log / status）—— 订阅 `Emitter`（唯一上行出口），不另开出口
- [x] 4.2 `GET /v1/tasks/{id}/diff`（只取产物，不重跑任务）
- [x] 4.3 单测：晚订阅能从环形缓冲补发（`Emitter.recent()`），收到终态即关闭

## 5. C4：契约

- [x] 5.1 `contracts/openapi.control-plane.yaml`（OpenAPI 3.1，独立文件，不与平台那份混淆）
- [x] 5.2 两份 README 机器可读契约表已登记该文件（控制面端点与 `Emitter` 的对应关系写在文档里）

## 6. 对主系统的改动（**只做加法**，逐条可核对）

- [x] 6.1 `src/core/emitter.ts`：新增 `subscribe()` 观察者与有界环形缓冲 `recent()`（默认 256，可设 0 关闭）
- [x] 6.2 `src/core/errors.ts`：新增 `toProblem()` / `ERROR_HTTP_STATUS`（RFC 9457 映射）
- [x] 6.3 `src/infra/config.ts`：新增 `[control_plane]` 配置节（`enabled` 默认 false、host 只允许回环、port）
- [x] 6.4 `src/app/session.ts`：`BridgeSession` 暴露 `emitter`（纯加字段）
- [x] 6.5 `src/app/bootstrap.ts`（新）：抽出 `connect` 与 `serve` 共用的"取凭证 → 建会话"，避免复制一份授权流程
- [x] 6.6 `src/commands/serve.ts`（新）+ `src/cli/dispatch.ts` 注册 + `help.ts` 说明
- [x] 6.7 `src/cli/hold.ts`（新）：`connect`/`serve` 共用的前台保活与信号注册

## 7. 验证

- [x] 7.1 `npm run typecheck` / `npm test`（71 + 9 项）通过
- [x] 7.2 `npm run arch:check` 通过（控制面三条红线由护栏硬校验）
- [x] 7.3 `npm run e2e:smoke` 通过 —— 证明主流程（`connect` 那条链路）行为未变
- [x] 7.4 不启用控制面时 `serve` 退化成 `connect`，零端口监听

## 8. 归档（等人工）

- [x] 8.1 人工评审（2026-10-27 用户授权 Agent 代行；控制面默认关闭、只绑回环、无 CORS 已由 `protocol-boundary-check` 机检覆盖）
- [x] 8.2 合并 spec 增量 / 移入 `openspec/changes/archive/`（本提案无 specs 增量；实际能力口径已写入 `bridge-protocol` 的「出站长连接」回环例外）
