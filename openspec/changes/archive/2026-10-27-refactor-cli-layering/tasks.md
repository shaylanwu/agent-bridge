# 实施清单：refactor-cli-layering

## 1. 拆分 CLI 支撑件（`src/cli/`）

- [x] 1.1 `flags.ts`：`parseFlags` + `strFlag/boolFlag/numFlag/posFlag` 取值辅助
- [x] 1.2 `render.ts`：颜色 `C`、工具表格 `printAgents`、统一输出 `out.{line,info,ok,warn,error,fatal}`
- [x] 1.3 `meta.ts`：`version()` 从 package.json 读（失败回落 0.0.0）
- [x] 1.4 `help.ts`：帮助文本（未实现能力当场标注）
- [x] 1.5 `dispatch.ts`：命令注册表 `COMMANDS` + `dispatch(argv)`（未知命令 → help + exit 2）

## 2. 抽出应用编排层（`src/app/`）

- [x] 2.1 `session-log.ts`：`SessionLog` 契约（`app/` 层禁 `console.*` 的前提）
- [x] 2.2 `service-gate.ts`：`authorizeService` 原样搬出（含审计与受控错误码映射）
- [x] 2.3 `task-dispatch.ts`：`run_task` / `cancel_task` 编排，上行只走 `Emitter.emit()`
- [x] 2.4 `session.ts`：连接生命周期、初值上报、指令路由、任务表、`close/isConnected/activeTasks/cancelTask`

## 3. 命令实现下沉（`src/commands/`）

- [x] 3.1 `status.ts` / `logout.ts` / `daemon.ts`（stub 明确标注未实现）
- [x] 3.2 `services.ts`：issue / list / revoke / rotate
- [x] 3.3 `connect.ts`：授权交互 → `createSession()` → 注册 SIGINT/SIGTERM → 保活

## 4. 入口瘦身

- [x] 4.1 `src/cli.ts` 只留 `dispatch(process.argv.slice(2))` 与顶层错误兜底（548 → 31 行）

## 5. 护栏与文档随动

- [x] 5.1 `doc-contract-check`：命令清单扫描范围扩到 `src/cli/dispatch.ts`，兼容命令表写法
- [x] 5.2 `protocol-boundary-check`：修正失效的 `agent-adapters` 路径（`src/adapters/agent-adapters.ts`）
- [x] 5.3 `always-on.md` §4.5：写入口红线 / `app/` 禁 console / 目录嵌套上限一层
- [x] 5.4 两份 README：模块表与目录结构补 `cli/`、`commands/`、`app/`；顺带修掉分层后残留的旧路径引用
- [x] 5.5 `AGENTS.md` / `openspec/project.md` 模块地图同步新路径与新层

## 6. 验证

- [x] 6.1 `npm run typecheck` 通过
- [x] 6.2 `npm test` 71 项通过
- [x] 6.3 `npm run gate` 全绿
- [x] 6.4 `npm run e2e:smoke` 10 项全 PASS（行为等价取证）
- [x] 6.5 清掉旧 `dist/` 产物后重建，确认 `dist/cli.js` 仍是 bin 入口

## 7. 评审与归档（等人工）

- [x] 7.1 人工评审（2026-10-27 用户授权 Agent 代行；`arch:check` 的导入边界与 `tsc --noEmit` 均通过）
- [x] 7.2 归档（本次无 specs 增量：纯内部重构，对外契约零变化）（2026-10-27 移入 `archive/2026-10-27-refactor-cli-layering/`）
