# bridge-protocol 规格增量：断线补发是有界缓冲（原规格写着「task_log 不补发」）

## MODIFIED Requirements

### Requirement: 出站长连接

bridge SHALL 主动向平台发起 WebSocket 连接（`/api/bridge/ws?deviceId=<id>`），握手携带
`Authorization: Bearer <device_token>`，且 SHALL NOT 监听任何**对外**入站端口。

仅有两类本机回环监听例外，且都必须只绑 `127.0.0.1` / `::1`：授权期的临时回调服务（拿到授权码后立即关闭），
以及本地控制面（`[control_plane] enabled` / `agent-bridge serve`，**默认关闭**，不回 `Access-Control-Allow-Origin`）。
回环监听不构成对外网络暴露。

连接断开 SHALL NOT 影响本机任务：正在执行的回合继续跑，断线期间产生的状态与日志进入**有界缓冲**，
在下一次连接建立后按序补发（控制类按条数、日志按字节，各自独立上限）。
日志超限 SHALL 丢弃最旧并 SHALL 插入一条说明性 `task_log`（`stream:"stderr"`，含量级），SHALL NOT 静默丢弃。
补发 SHALL 是**原事件的重放**（沿用同一 `eventSeq`），SHALL NOT 新造事件。

#### Scenario: 握手成功

- **WHEN** 设备已绑定且网络可达
- **THEN** 连接建立后 bridge 立即发送 `hello`（含 `protocolVersion` / `deviceId` / `cliVersion` / `platform` / `hostname`）

#### Scenario: 凭证被吊销

- **WHEN** 平台以 close code `4401` 或 `4403` 关闭连接
- **THEN** bridge 记录提示并停止重连（不进入退避循环），用户需重新 `connect`

#### Scenario: 网络中断

- **WHEN** 连接异常断开（如 1006）
- **THEN** bridge 以 1s→2s→4s…→30s 指数退避重连（连接成功后重置），重连后补发断线期间缓冲的状态与日志

#### Scenario: 断线期间任务结束

- **WHEN** 任务在断线窗口内到达终态
- **THEN** 终态（含最终回答）在重连后补发，且同一 `eventSeq` 的重放与持久化记录一致（不产生两条终态）

#### Scenario: 断线期间日志超出缓冲

- **WHEN** 断线期间累计日志超过日志缓冲上限
- **THEN** bridge 丢弃最旧部分并补发一条 `[agent-bridge] 断线期间日志超出缓冲上限（N KB）` 的 stderr 日志，
  平台据此识别「日志跳段」是桥接裁剪而不是 CLI 没输出

#### Scenario: 断线期间收到交互请求

- **WHEN** 交互请求在断线前已下行、平台在重连后才作答
- **THEN** 响应 SHALL 按 SQLite 中的 pending 记录路由并交付 adapter（不依赖连接状态）
