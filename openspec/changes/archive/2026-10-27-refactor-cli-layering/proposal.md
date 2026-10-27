# 变更提案：入口瘦身与分层落地（cli.ts 548 → 31 行）

## Why

`src/cli.ts` 一个文件里同时承担了五件事：参数解析、终端渲染、授权交互、平台指令编排、任务回传接线。

直接后果：

1. **改一处要读完全文** —— 加一个 `task_step` 字段要在 548 行里找落点，且极易顺手把渲染/鉴权/编排混写在一起；
2. **逻辑不可复用** —— 控制面板想复用「收到 run_task → 鉴权 → 拉起 → 回传」这段编排时，它和 `console.log` 死死绑在一起，
   只能复制一份，于是"唯一上行出口"这条红线会被悄悄绕过；
3. **不可测** —— 编排逻辑写在入口的闭包里，单测无从下手（现有 71 项单测没有一项覆盖这段，全靠 e2e 兜）。

目标不是"为了分层而分层"，而是：入口只做分发；每一层能被单独测试与复用；新增命令/新增指令不改入口文件。

## What Changes

新增两层、拆散入口（**纯内部重构**：协议、报文、配置项、CLI 用法对外零变化）：

```
src/cli.ts           入口：argv → dispatch() + 顶层错误兜底（31 行）
src/cli/             CLI 支撑件：flags / render / help / meta / dispatch（命令注册表）
src/commands/        一个命令一个文件：connect / status / logout / services / daemon
src/app/             用例编排：session（连接与指令路由）/ task-dispatch（run·cancel）/ service-gate（P0-8 鉴权）/ session-log（日志契约）
```

- `src/app/session.ts`：**平台会话**——初值上报、`ping/scan/cancel_task/run_task` 路由、在跑任务表、优雅关闭。
- `src/app/task-dispatch.ts`：`run_task` / `cancel_task` 的编排（鉴权 → `startTask` → 经 Emitter 回传）。
- `src/app/service-gate.ts`：服务身份校验 + 审计（从入口搬出，逻辑一字未改）。
- `src/commands/*`：只做「取参数 → 调 `app/` 或 `infra/` → 打印」。
- **`src/app/` 不得直接 `console.*`**：输出一律走注入的 `SessionLog`，这是控制面板能复用同一段编排的前提。

### 不改什么（红线）

- 不改 `src/protocol.ts`（无提案不动契约）、不改报文字段、不新增 CLI 命令、不改配置键。
- 不把目录嵌套加深到两层以上：护栏的「导入逃逸 src」规则按 `../../` 前缀判定，深目录会误报（已写进 `always-on.md` §4.5）。

### 护栏随动（已授权调整护栏文档）

- `doc-contract-check`：命令清单原来只扫 `src/cli.ts`，现在连 `src/cli/dispatch.ts` 一起扫，
  并同时识别 `cmd === 'x'` 与命令表 `'x': cmdX` 两种写法。
- `protocol-boundary-check`：修掉一处**已失效的规则**——凭据读取检查仍指向分层前的 `src/agent-adapters.ts`，
  搬到 `src/adapters/` 后该规则形同虚设（等于没拦）。
- `always-on.md` §4.5：补写入口瘦身红线、`app/` 层禁用 `console.*`、目录嵌套上限。

## Impact

- 对平台（第三方）：零影响 —— 报文、协议版本、能力清单、HTTP 端点全部不变（未改 `src/protocol.ts`）。
- 对用户：零影响 —— CLI 用法、输出文案、配置键、退出码全部不变（仅帮助文本里 `daemon` 补了「尚未实现」标注）。
- 对后续改动：新增命令 = `src/commands/` 加文件 + `COMMANDS` 加一行，入口不再动；
  控制面板可直接复用 `src/app/session.ts` 与 `task-dispatch.ts`（它们已不依赖终端）。
- 依赖：**不新增任何运行时依赖**，主包仍是 `ws` + `smol-toml`。
- 唯一外部可见差异：`dist/` 多出 `cli/`、`app/`、`commands/` 三个子目录；另需发布前清一次 `dist/`（tsc 不自清理旧产物）。

## 验证

- `npm run gate` 全绿（类型 / 71 项单测 / 构建 / 契约 / 文档一致 / 提案格式）。
- `npm run e2e:smoke` 10 项全 PASS（真实 CLI 跑通 success + timeout，证明重构未改变外部行为）。

## 风险

- 极低：无对外契约变化，入口行为等价；唯一外部可见差异是 `dist/` 多出 `cli/`、`app/`、`commands/` 三个子目录。
- 注意 `dist/` 不会自清理：目录搬迁后旧产物会残留（本次已手动清掉 `dist/` 重建，发布前建议照做）。
