# 任务清单：fix-artifact-after-settle

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。

## 1. 修复

- [x] 1.1 `src/core/emitter.ts`：终态豁免清单加入 `artifact_content`（判定口径不变：仍按 taskId、仍只豁免回答请求的帧）
- [x] 1.2 单测 `test/emitter-settled.test.ts` 4 例：终态后 log 丢弃、相同终态可重放/不同终态拒绝、`artifact_content` 与 `task_snapshot` 必须放行

## 2. WS 直连 e2e（本次的发现载体）

- [x] 2.1 `test/e2e-ws-dispatch.test.ts`：真 `ws` 服务器 + 真 `createSession` + 真 SQLite + 假 ACP 子进程（写死 .cjs）
- [x] 2.2 hello 协商：协议版本 / 能力清单 / 容量水位
- [x] 2.3 approve：`task_interaction_request` 下行 → `task_interaction_response` 上行 → 假 CLI 落盘 `allow_once` → success
- [x] 2.4 cancel：挂住的回合 → `cancel_task` → `cancelled`（不是 failed / 不是干等超时）
- [x] 2.5 artifact：未知 id → `found:false` + `artifact_not_found`；已知 id → 元数据 + base64 内容

## 3. 验证与取证

- [x] 3.1 WS e2e **5 例全绿**（约 1.7s）
- [x] 3.2 先红后绿：回退 Emitter 修复 → 两条 artifact 用例各挂 **15s 超时**变红；恢复后 1.7s 全绿
- [x] 3.3 `test/emitter-settled.test.ts` 4 例全绿（artifact / snapshot 放行两例同样在回退后变红）
- [x] 3.4 `npm run gate` 全绿；`npm run harness:validate` 全绿；低并发全量 vitest 不回归

## 4. 归档

- [x] 4.1 `specs/bridge-protocol/spec.md` 增量已合并进 `openspec/specs/bridge-protocol/spec.md`（新增「终态后取产物 / 取快照」两个 Scenario）
- [ ] 4.2 由人工执行 `mv openspec/changes/fix-artifact-after-settle openspec/changes/archive/<日期>-fix-artifact-after-settle`
