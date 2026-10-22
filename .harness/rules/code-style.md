---
name: code-style
description: TypeScript 代码风格与结构约定：strict 边界、模块职责、错误处理、命名、注释口径。
priority: P2
applies_to: ['src/**', 'test/**']
enforced_by:
  - hooks/post-change-gate.sh
version: 1.0.0
---

# code-style.md — 代码风格与结构

## 1. 编译约束（不可降低）

- `strict: true` + `noUncheckedIndexedAccess: true`：⛔ 禁止用 `!` 非空断言绕过数组/索引检查；改用显式判空。
- `module/moduleResolution: NodeNext` → 相对导入**必须带 `.js` 后缀**（`./protocol.js`）。⛔ 这是 ESM 硬要求，漏了直接运行时报 `ERR_MODULE_NOT_FOUND`。
- `types: ["node"]`，target ES2022；⛔ 禁止引入新运行时依赖而不走 OpenSpec 提案（当前运行时依赖只有 `ws` + `smol-toml`，这是刻意的）。

## 2. 模块职责（一个文件一件事）

| 文件 | 只做 |
| --- | --- |
| `cli.ts` | 命令解析、终端输出、事件接线 |
| `auth.ts` | 授权流程（PKCE / 回环回调 / 设备码） |
| `config.ts` | 本地配置读写与脱敏 |
| `bridge-client.ts` | WS 传输（鉴权、心跳、退避、离线队列） |
| `scan.ts` | 探测调度与缓存 |
| `agent-adapters.ts` | 适配器表 + 二进制解析 + 版本/凭据探测 |
| `runner.ts` | 任务生命周期（校验、spawn、日志、取消、超时） |
| `win-exec.ts` | Windows 命令行引号规则 |
| `protocol.ts` | wire 类型 + 运行期校验 + 分片 |

- ⛔ 禁止把传输逻辑写进 `cli.ts`，禁止把 spawn 写进 `bridge-client.ts`。新增能力先判断落在哪个模块，放不下就提提案拆模块。

## 3. 错误处理

- 对外部输入的校验失败 → 抛 `ProtocolError` / `AuthError`（各自模块已定义），⛔ 禁止裸 `throw new Error` 让上层无法分类。
- 探测类函数**不抛错**：任何异常降级为 `not_installed` / `installedButBroken`（`probeAgent` 已如此），⛔ 禁止让一个工具探测失败拖垮整次扫描。
- CLI 顶层统一 `main().catch()` 出口，退出码：参数错误 2、运行失败 1、成功 0。

## 4. 命名与注释

- 类型/接口 PascalCase，函数 camelCase，常量 UPPER_SNAKE；文件名 kebab-case。
- 注释写**为什么**，不写"这行在干什么"。涉及历史坑的地方必须留下现象与原因（示例：`agent-adapters.ts` 里"stderr 必须吞掉：where 找不到时会往 stderr 打本地化提示"）。
- 中英文混排：代码注释用中文，对外文档英文 README + 中文 README 各一份，术语保持一致（`agent_list` 不译）。

## 5. 测试

- Vitest；纯函数优先（分片、校验、引号、凭据探测、适配器注册表）。
- ⛔ 禁止单测里真的 spawn 用户 CLI（慢且不确定）；需要验证 spawn 用 mock 或跳过。
- 新增分支逻辑必须带用例；`npm test` 必须零失败才能进入评审。
