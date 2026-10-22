## Why

CI / 无头接入走的是 `agent-bridge connect <url> --token=<device-token>`。这条路径不经过授权流程，`deviceId` 只能来自
已保存的配置 —— 而 CI 机器上通常没有配置文件，于是：

- WS 请求变成 `GET /api/bridge/ws?deviceId=`（空值），`hello.deviceId` 也是 `""`；
- 平台若按 `deviceId` 路由/落库，会拿到空串；真实联调时我是靠「平台按 token 反查设备」绕过的，
  但这属于隐式约定，文档里没写，第三方实现无从得知。

结果：这条被 README 当作正式用法（"CI or scripted setup"）的路径，实际交付了一个空 ID，且失败点很隐蔽。

## What Changes

- `src/cli.ts`：新增 `--device-id=<id>`，并支持 `AGENT_BRIDGE_DEVICE_ID` 环境变量；
  解析顺序：**flag > 环境变量 > 已保存配置（仅当平台地址一致时）**。
- `src/cli.ts`：解析结果为空时打印一条明确警告（平台必须按 token 反查设备），不再静默带空 ID 连接。
- `src/bridge-client.ts`：`deviceId` 为空时**不拼** `?deviceId=` 参数（而不是发一个空值）；导出 `wsUrlOf()` 以便单测。
- `README.md` / `README.zh-CN.md`：CI 用法补 `--device-id`，并写明「`deviceId` 可省略，此时平台必须按
  `Authorization: Bearer` 反查设备」——把隐式约定变成显式契约。
- `test/bridge.test.ts`：`wsUrlOf()` 两条（有/无 deviceId）+ `--device-id` 优先级解析。

不改协议字段：`hello.deviceId` 仍是 string（可为空串），`PROTOCOL_VERSION` 不变。

## Impact

- 协议：无字段变更；**语义澄清**（`deviceId` 可选，平台按 token 反查），需要一份 spec delta 把这条写进正式规格
- CLI：`connect` 新增 `--device-id` 参数（可选，向后兼容）
- 适配器：无
- 文档：两份 README 的 CI 用法段；`openspec/specs/bridge-protocol/spec.md` 的「CI 场景」Scenario 由「已知限制」改为正式行为
- 风险级别：medium（CLI 行为增强，非破坏性；不传新参数时行为与现在一致，只是 WS URL 少一个空参数）
