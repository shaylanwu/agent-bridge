## 1. 实现

- [x] 1.1 新增 `src/outbox.ts`：控制消息队列（≤200 条）+ 日志字节缓冲（≤256KB，丢最旧并计数）
- [x] 1.2 `Outbox.drain()`：先控制后日志；有丢弃时在最前面插一条说明性 `task_log`
- [x] 1.3 `src/bridge-client.ts`：`queue` 换成 `Outbox`；`flush()` 用 `drain()`；删除「日志直接丢弃」

## 2. 测试

- [x] 2.1 顺序：控制消息与日志分别保持先进先出；`drain()` 后缓冲清空
- [x] 2.2 控制类上限：超过 200 条时丢最旧
- [x] 2.3 日志上限：超过字节上限时丢最旧、`droppedBytes` 累加，`drain()` 首条为截断提示
- [x] 2.4 未超限时不插提示（正常补发不产生噪声）
- [x] 2.5 `npm test` 全绿

## 3. 文档

- [x] 3.1 `README.md`：行为说明补「断线期间日志缓冲 + 超限截断提示」
- [x] 3.2 `README.zh-CN.md`：同上

## 4. 验证

- [x] 4.1 `npm run gate` 全绿
- [x] 4.2 `npm run e2e:smoke` 通过
- [x] 4.3 端到端：任务运行中切断连接 → 任务继续跑 → 重连后补发的日志包含断线期间的输出（mock 端累计）

## 5. 归档

- [x] 5.1 合并 spec delta（bridge-protocol：日志流的断线补发语义）
- [x] 5.2 提案移入 `openspec/changes/archive/YYYY-MM-DD-buffer-task-log-while-offline/`
