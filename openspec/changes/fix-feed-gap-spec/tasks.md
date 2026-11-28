# 任务清单：fix-feed-gap-spec

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 取证

- [x] 1.1 字段名漂移：规格 `eventWindow { oldestRetainedEventSeq, lastEventSeq }` vs 实现/asyncapi/站点 `oldestEventSeq, latestEventSeq`
- [x] 1.2 缺口结构漂移：规格 `(fromEventSeq/toEventSeq/reason)` vs 实现/asyncapi `{ from, to, reason? }`
- [x] 1.3 e2e 取证 `test/e2e-ws-feed-gaps.test.ts` 3 例：count 淘汰带 reason / 跨重连 gaps 不变 / 前缀删除走 prunedThrough
- [x] 1.4 先红后绿：把 `maxSteps` 预算改成 0（关闭）后第 1 例变红（`task_step` 不再是 2 条）

## 2. 规格

- [x] 2.1 `specs/bridge-protocol/spec.md`：MODIFIED「会话快照、附件补取与历史分页」改字段名
- [x] 2.2 `specs/bridge-protocol/spec.md`：MODIFIED「Web Agent 会话呈现 Feed」写缺口结构 + 分层 + 保护行
- [x] 2.3 `specs/task-execution/spec.md`：MODIFIED「会话快照、预算与终态收尾」同步 task_log 占 eventSeq 与缺口集合一致
- [x] 2.4 合并进 `openspec/specs/bridge-protocol/spec.md` 与 `openspec/specs/task-execution/spec.md`

## 3. 验证

- [x] 3.1 `npm run openspec:validate` 通过
- [x] 3.2 `npm run gate` + `npm run harness:validate` 全绿

## 4. 归档

- [ ] 4.1 由人工执行 `mv openspec/changes/fix-feed-gap-spec openspec/changes/archive/<日期>-fix-feed-gap-spec`
