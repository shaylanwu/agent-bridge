## Why

`src/runner.ts` 早就实现了 `allowedCwd` 校验（`cwd` 必须是白名单目录的子目录），但**从来没有人给它传值**：
`src/cli.ts` 不解、`src/config.ts` 也没有这个字段。结果是「平台可以指定用户机器上任意目录作为 `cwd`」——
而 README 的安全表里已经写着 "an optional allow-list confines it further"，文档承诺了代码没做的事。

这是当前最实际的一个安全口子：bridge 以用户身份 spawn CLI，`cwd` 就是 CLI 的工作目录。若平台侧被攻破或
配置错误，任务可以在 `~/.ssh`、`/etc`、含密钥的仓库根目录下运行任意编码 Agent。

## What Changes

- `src/config.ts`：`BridgeConfig` 增加 `allowedCwd?: string[]`；从 `config.toml` 的 `allowed_cwd` 读取（兼容
  camelCase 旧写法），读取时 `resolve()` 规范化并丢弃空项；`saveConfig` 统一写 `allowed_cwd`（snake_case，与文档一致）。
- `src/runner.ts`：`isUnder()` 导出以供测试；Windows 上路径比较改为大小写不敏感（`C:\Work` 与 `c:\work` 视为同一目录）。
- `src/cli.ts`：`connect` 时把 `saved.allowedCwd` 透传给 `startTask`；白名单生效时在终端提示生效条目数。
- `README.md` / `README.zh-CN.md`：安全表补一行配置示例，说明 `allowed_cwd` 为可选、不配则不限目录。
- `test/bridge.test.ts`：`isUnder` 的纯函数用例（含前缀旁路：`/a/b` 不应放行 `/a/bc`）、`loadConfig` 解析
  `allowed_cwd` 的用例、`startTask` 越界时**不 spawn** 直接回 `failed` 的用例。

不改协议：`allowedCwd` 是本机配置，不进 `run_task` 报文，对第三方平台零影响。

## Impact

- 协议：**无**（`src/protocol.ts` 不动，`PROTOCOL_VERSION` 不变）
- CLI：`connect` 输出多一行白名单提示；无新增命令/参数
- 适配器：无
- 文档：两份 README 的安全表 + 配置说明；`.harness/rules/protocol-contract-rules.md` §6 台账与
  `doc-impl-sync-rules.md` 的漂移台账需要**人工**划掉（`.harness/` 仅人工维护）
- 风险级别：medium（安全边界收紧，非破坏性；不配置时行为与现在完全一致）
