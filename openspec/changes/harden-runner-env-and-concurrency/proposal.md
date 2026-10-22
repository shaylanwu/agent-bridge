## Why

`runner.ts` 是「平台能在这台机器上做什么」的唯一边界，但目前有两处没设防：

1. **平台下发的 `env` 被无差别并入子进程环境**：`{ ...process.env, ...req.env }`。平台（或被攻破的平台）
   可以用 `NODE_OPTIONS=--require ./evil.js` 在 Node 系 CLI 启动时执行任意代码，或用 `PATH` / `PATHEXT`
   把白名单二进制换成自己的，`LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` 同理。这不是理论问题：
   我们辛苦守住了「只跑白名单 CLI、参数走数组」，却留了这条同等威力的旁路。
2. **没有并发上限**：平台连续下发 N 个任务，bridge 就同时 spawn N 个编码 CLI。每台开发机 4~8 核，
   几个大模型 CLI 同时跑会把机器打死，而用户只看到「电脑很卡」，不知道自己被并发打爆。

两处都在同一个文件、同一类风险（平台输入不可信），合成一次提案一次审批。

## What Changes

- **env 白名单**：新增 `sanitizePlatformEnv()`，剔除影响解释器/加载器行为的键
  （`NODE_OPTIONS`、`PATH`、`PATHEXT`、`COMSPEC`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、
  `DYLD_INSERT_LIBRARIES`、`DYLD_LIBRARY_PATH`、`BASH_ENV`、`ENV`、`PYTHONSTARTUP`、`PYTHONHOME`、
  `GIT_SSH_COMMAND`、`SSH_ASKPASS`）；其余键照旧透传（代理、时区、语言等正常用法不受影响）。
  被剔除的键在本地 stderr 打印一行提示（⛔ 不回传给平台，避免暴露本机环境细节）。
- **并发上限**：默认同时最多 3 个任务（`AGENT_BRIDGE_MAX_TASKS` 可覆盖）。达到上限时**快速拒绝**并回
  `task_status: failed` + `error: 并发任务已达上限（N）…`，不做排队 —— 排队会让平台的超时语义变得不可预测，
  而平台本来就有重试能力。
- 文档：两份 README 的「Security boundaries」表补一行（env 白名单 + 并发上限），配置段补 `AGENT_BRIDGE_MAX_TASKS`。

不改协议字段（`run_task.env` 语义收窄属**行为收紧**，在 README 明确写出；`PROTOCOL_VERSION` 不变）。

## Impact

- 协议：无字段变更；`env` 的部分键会被忽略（行为收紧，需文档写明）
- CLI：无新增命令；新增环境变量 `AGENT_BRIDGE_MAX_TASKS`
- 适配器：无
- 文档：两份 README 安全表 + 配置说明
- 风险级别：**high**（`src/runner.ts` 是 spawn 安全边界）→ 实施完成后需人工确认再归档
