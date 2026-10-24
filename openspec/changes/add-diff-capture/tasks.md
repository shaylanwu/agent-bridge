# 实施清单：add-diff-capture

## 1. 设计与提案

- [x] 1.1 建 `proposal.md` / `tasks.md` / `specs/task-execution/spec.md`（本文件所属提案）
- [x] 1.2 明确"非 git 目录不报错""超限时按行截断""intent-to-add 用完即还原"三条边界

## 2. 实现

- [x] 2.1 新增 `src/git.ts`：`isGitWorkTree()` / `captureWorktreeDiff()`，统一返回 `DiffCapture`
- [x] 2.2 `src/protocol.ts`：`RunTaskCommand.captureDiff?`；`task_status` 增 `diff?/changedFiles?/diffTruncated?`
- [x] 2.3 `assertServerMessage` 校验新字段（只接受 boolean；其它一律忽略，前向兼容）
- [x] 2.4 `src/config.ts`：`diff_max_bytes` + `diff_default`，环境变量覆盖，值域夹紧
- [x] 2.5 `src/runner.ts`：`finish()` 内按开关捕获，写入终态回传；捕获异常降级为空 diff
- [x] 2.6 `src/cli.ts`：把 `captureDiff` 与配置透传给 runner，并在终端打印 changedFiles 摘要

## 3. 测试

- [x] 3.1 单测：非 git 目录返回空；新文件（untracked）能进 diff 且索引被还原
- [x] 3.2 单测：超长 diff 被截断且 `diffTruncated = true`，截断后仍是合法 unified diff 头
- [x] 3.3 单测：`changedFiles` 为仓库相对路径、去重、有上限
- [x] 3.4 单测：`assertServerMessage` 接受/拒绝 `captureDiff` 的形状

## 4. 文档与门禁

- [x] 4.1 两份 README：协议表、run_task 示例、安全边界表、配置项同步
- [x] 4.2 CHANGELOG `Unreleased` 记录
- [x] 4.3 `npm run gate` 全绿；`npm run e2e:smoke` 增加 diff 字段断言

## 5. 归档

- [ ] 5.1 人工评审通过后，spec 增量合并进 `openspec/specs/task-execution/spec.md`
- [ ] 5.2 提案目录移入 `openspec/changes/archive/YYYY-MM-DD-add-diff-capture/`
