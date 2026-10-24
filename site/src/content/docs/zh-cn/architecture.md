---
title: 架构
description: 分层、依赖方向，以及护栏强制的三条规则。
sidebar:
  order: 3
---

## 一个入口，多个模块

`src/cli.ts` 只做一件事：把 `process.argv` 交给 `dispatch()`。命令实现在 `src/commands/`，
展示层在 `src/cli/`，真正的业务在 `src/app/`。

```
cli.ts                    入口：argv → dispatch()
  └─ cli/                 展示层：命令表、参数解析、渲染、帮助
       └─ commands/       一命令一文件
            └─ app/       用例：会话、任务分发、服务校验、控制面
                 ├─ core/       领域：Emitter、任务调度、错误码、脱敏、扫描
                 ├─ transport/  出站：bridge client、outbox
                 ├─ adapters/   边缘：agent 适配器、Windows exec、图标
                 └─ infra/      平台设施：配置、鉴权、git、审计、服务令牌
```

依赖**只能向下**：`core` 不导入 `transport` / `adapters` / `infra` / `app` 任何东西。
护栏（`npm run arch:check`）会在出现回环或向上依赖时失败 —— 分层由代码强制，不靠自觉。

## 三条规则

### 1. 上行只有唯一出口：`Emitter.emit()`

除 `core/emitter.ts` 外，任何地方都不得向平台发消息。四个横切关注点因此只写一次：

- **终态幂等** —— 一个任务只会到达一次终态；
- **脱敏** —— 家目录 → `~`，≥64 位长串折叠；
- **审计** —— 旁路写本地审计；
- **信封** —— 协商 `cloud-events` 时套 CloudEvents 1.0 信封。

这也是控制面与平台看到同一份事件的原因：本地下发的任务，上行走的还是这条唯一出口。

### 2. 入口只做分发

`cli.ts` 只有 31 行。新增命令 = 在 `src/commands/` 加文件 + 在 `COMMANDS` 表加一行，入口零改动。

### 3. 控制面必须留在本机

只绑回环、`enabled` 开关默认关闭、永不返回 CORS 头。它是扩展，不是第二道大门：
它创建的任务同样走共享的 `TaskSupervisor`，因此 `max_tasks` 对两个通道都生效。

## 调度

`core/task-supervisor.ts` 持有状态机：`queued → running → settled`。

- 并发上限：`config.toml` 的 `max_tasks`（默认 3，上限 32）；CI 可用 `AGENT_BRIDGE_MAX_TASKS` 覆盖；
- **排队用可选字段表达，不新增状态值**：排队中的任务上报 `status: "running"` +
  `phase: "queued"` + `queuePosition`。老平台不会收到不认识的状态值，新平台能读到排队信息；
- 取消是 SIGTERM，2 秒后 SIGKILL；
- 长时间无动静的任务由看门狗置为 `lost` —— 这个值属于平台侧账本，不在 wire 上。

## 契约即真源

三份机器可读文件描述了外部能触碰的一切，`npm run contracts:check` 会在代码与契约漂移时失败：

| 契约 | 描述 |
| --- | --- |
| `contracts/asyncapi-3.0.yaml` | WebSocket 通道：11 个消息类型 + 错误码枚举 |
| `contracts/openapi-3.1.yaml` | 平台必须实现的 4 个 HTTP 端点 |
| `contracts/openapi.control-plane.yaml` | 本地回环控制面：9 个路径 / 10 个操作 |

本站只是**渲染**这些契约，而不二次描述 —— 所以你正在读的这些页面是构建期生成的。
