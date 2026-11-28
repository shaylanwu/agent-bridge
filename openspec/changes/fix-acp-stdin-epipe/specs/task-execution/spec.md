# task-execution 规格增量：子进程写失败不得升级为进程级异常

## ADDED Requirements

### Requirement: 子进程写失败不得升级为进程级异常

向子进程 stdin 写入失败 SHALL NOT 成为未捕获异常。`write()` 的 `EPIPE` 以**异步 `error` 事件**
形式到达，`try/catch` 抓不到，因此适配器 SHALL 在 spawn 之后立即为 `stdin` 挂 `error` 监听，
命中时标记通道已关闭并唤醒等待中的响应；真正的失败结论 SHALL 仍由进程退出分支按原有语义结算
（stderr 尾部照常拼进原因）。理由与「回合 Promise 不得产生未处理拒绝」一致：子进程崩一次
不得把整个 bridge 带走，否则同机正在跑的所有任务会一起丢。

#### Scenario: 子进程在桥接写通知时已退出

- **WHEN** ACP 子进程已退出（崩溃 / 被 kill），桥接随后向它的 stdin 写 `initialize` 或交互响应
- **THEN** 写入失败被记录为「通道关闭」，调用方以正常错误（进程退出码 + stderr 尾部）结算，
  bridge 进程继续运行、其它任务不受影响
