# 实施清单：tune-concurrency-defaults

## 1. 提案与规格

- [x] 1.1 建 `proposal.md` / `tasks.md` / `specs/task-execution/spec.md`（MODIFIED「并发上限与排队」，含启动参数优先级场景）

## 2. 实现

- [x] 2.1 `src/core/task-supervisor.ts`：`DEFAULT_MAX_TASKS = 30`、`DEFAULT_MAX_QUEUED = 60`，注释同步
- [x] 2.2 `src/infra/config.ts`：默认值与夹取上限（`MAX_TASKS_CEILING = 128`）；`resolveMaxTasks` / `resolveMaxQueued` 增加 `override` 第二参（优先级最高）
- [x] 2.3 `src/cli/flags.ts`：新增 `numFlagMin()`（允许自定义下界，`--max-queue=0` 合法）
- [x] 2.4 `src/app/bootstrap.ts`：`--max-tasks` / `--max-queue` 解析并透传（connect/serve 共用入口）
- [x] 2.5 `src/commands/serve.ts`：控制面默认额度同样吃启动参数（两条通道口径一致）
- [x] 2.6 `src/cli/help.ts`：connect/serve 用法行与新参数说明

## 3. 测试

- [x] 3.1 更新默认值断言（30 / 60）与夹取断言（100 → 100、200 → 128）
- [x] 3.2 新增：override 优先于环境变量与配置；`--max-queue=0` 合法；override 越界仍被夹取

## 4. 文档

- [x] 4.1 `README.md` / `README.zh-CN.md`：默认值、优先级链（启动参数 > 环境变量 > 配置）、安全边界表
- [x] 4.2 `llms.txt` + `site/public/llms.txt` 同步
- [x] 4.3 站点：`cli`（中英）、`architecture`（中英）、`integrate/platform`（中英）、`protocol/overview`（中英）

## 5. 门禁

- [x] 5.1 `npm run gate` 全绿
- [x] 5.2 `npm run harness:validate` 全绿
- [x] 5.3 `npm run build && npm run e2e:smoke`（runner/配置链改动，必跑）— 10/10 PASS

## 6. 归档

- [ ] 6.1 人工评审通过后归档，把 MODIFIED Requirement 合并进 `openspec/specs/task-execution/spec.md`
