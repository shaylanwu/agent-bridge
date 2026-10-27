# 实施清单：fix-stable-device-identity

> 状态：0.2 已获实施授权；任务 1～6.5 已完成，本地测试、正式 smoke 与 gate/harness 全绿。6.6 等平台联调，之后进入评审归档。
>
> 设计依据：本目录 `design.md`；每完成一项立即勾选，不另建平行 plan.md。

## 0. 提案与人工卡点

- [x] 0.1 用户确认技术方案并要求进入下一步；创建 `proposal.md`、`design.md`、`tasks.md` 与两份 spec 增量
- [x] 0.2 人工评审本提案，并明确授权实施阶段修改高风险文件 `src/infra/auth.ts`、`src/protocol.ts`（用户 2026-10-25 确认“可以实施”）

## 1. 身份模型与持久化

**Files：** 新建 `src/core/device-identity.ts`、`src/infra/atomic-file.ts`、`src/infra/device-identity-store.ts`、`test/device-identity.test.ts`。

**Interfaces：** `DEVICE_ID_PATTERN`；`assertDeviceId(value: unknown): string`；`type IdentitySource = 'created' | 'migrated' | 'reused'`；`type DeviceIdentity = { deviceId: string; source: IdentitySource }`；`ensureDeviceIdentity(options): Promise<DeviceIdentity>`。

- [x] 1.1 先写失败测试：固定正则只接受 32/12 位小写 hex；新 ID 由 16 字节随机源生成；旧 12 位 ID 原样迁移；非法、空、损坏和不支持的 schema 均抛错
- [x] 1.2 实现 `src/core/device-identity.ts` 纯校验与冲突判断，不引入 wire 类型或文件系统依赖
- [x] 1.3 写持久化失败测试：授权前创建、三次读取仅一次 `created`、EEXIST 读回既有值、发布前失败保留旧文件、损坏/不可读不进入生成路径
- [x] 1.4 实现 `atomic-file.ts` 与 `device-identity-store.ts`：同目录临时文件、文件 fsync、不覆盖身份发布、原子配置替换、POSIX 0600 与 Windows ACL；迁移来源冲突必须报错
- [x] 1.5 运行 `npx vitest run test/device-identity.test.ts`，预期全部通过；在 Windows 临时目录验证 ACL、原子发布及崩溃后文件可读性

## 2. 配置严格化与 profile 锁

**Files：** 修改 `src/infra/config.ts`；新建 `src/infra/profile-lock.ts`、`test/profile-lock.test.ts`、`test/config.test.ts`。

**Interfaces：** `withProfileLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T>`；配置读取区分“文件不存在 / 有效未绑定 / 有效已绑定 / 损坏”。

- [x] 2.1 先写失败测试：不存在返回空配置，空文件和 TOML 损坏抛错；logout 后的有效无凭证配置不报错；保存凭证合并旧业务设置并写入同值 `deviceId` 镜像
- [x] 2.2 修改 `config.ts`：严格解析、原子保存、保留镜像；提供仅移除 `deviceToken`/`refreshToken`/`boundAt` 的有效 TOML 清除路径，不再吞异常或写空文件
- [x] 2.3 写锁失败测试：同进程 single-flight、跨进程明确拒绝或复用、owner token 才能释放、活 PID 锁不可强拆、死 PID stale lock 可恢复、锁内会重读状态
- [x] 2.4 实现 `profile-lock.ts`，锁记录 owner token/PID/hostname/时间；身份创建、授权、凭证保存和 logout 共用同一锁路径；stale 判定/复核/删除由 recovery guard 互斥，防止并发回收误删新锁
- [x] 2.5 运行 `npx vitest run test/profile-lock.test.ts test/config.test.ts`，预期全部通过；不得通过放宽新测试来兼容旧的宽松读取行为

## 3. 两种授权流程与平台错误

**Files：** 修改 `src/infra/auth.ts`；新建 `test/auth.test.ts`。

**Interfaces：** `AuthContext { platformUrl; deviceId; hostname; platform; cliVersion }`；两个授权入口统一接收该上下文；`AuthError` 携带 `httpStatus` 与可选 `code`。

- [x] 3.1 先写 PKCE 请求测试：`/api/bridge/token` 含 `code`、`codeVerifier`、`redirectUri`、`clientId`、本地 `deviceId`、hostname、platform、cliVersion；本地 ID 在打开授权页前已确定
- [x] 3.2 写设备码测试：`/api/bridge/device-token` 携带同一 ID 与元信息；`428 authorization_pending` 按服务端 interval 轮询；终态后旧设备码不重放
- [x] 3.3 写响应与错误测试：响应 `device_id` 缺失/非法/不一致时拒绝；400、两类 409、401/403 分别映射；错误正文与 token 不进入日志；授权码不自动重放
- [x] 3.4 实施 `auth.ts`：注入统一 `AuthContext`，校验成功响应后才返回凭证，`AuthResult` 不再充当设备身份来源，按顶层 JSON `code` 建立受控错误映射
- [x] 3.5 运行 `npx vitest run test/auth.test.ts`，预期全部通过

## 4. 启动、协议 v2、WS 与 logout 收口

**Files：** 修改 `src/app/bootstrap.ts`、`src/transport/bridge-client.ts`、`src/protocol.ts`、`src/commands/logout.ts`、`src/cli/help.ts`、`test/bridge.test.ts`；新建 `test/bootstrap-device-id.test.ts`。

**Interfaces：** `startBridge()` 只把 `ensureDeviceIdentity()` 返回的 ID 交给授权和 `createSession()`；`wsUrlOf(platformUrl, deviceId)` 不再接受空 ID。

- [x] 4.1 先写启动失败测试：平台离线前身份已保存、连续重启复用、卸载重装复用、只删 identity 从镜像恢复、多 profile 不互覆、显式 ID 冲突拒绝、旧 token 无身份时拒绝随机生成
- [x] 4.2 写失败恢复测试：响应丢失重试、token 保存失败后重试、两个 connect 并发、进程在 token 保存前退出、logout 后重绑；均断言 ID 不变且旧 code 不重放
- [x] 4.3 修改 `bootstrap.ts`：显式平台参数优先；获取 profile 锁后在锁内重读身份与配置、重新判断模式并执行 `ensureDeviceIdentity()`；交互授权持续持锁至凭证保存完成，预签发 token 迁移也在锁内；释放锁后再创建 WS；日志分别输出 `created/migrated/reused`，保存失败不创建 WS
- [x] 4.4 修改 `logout.ts` 与 `help.ts`：清凭证保身份和设置；说明吊销后 logout→connect、预签发 token 必须提供可迁移身份
- [x] 4.5 在 0.2 高风险授权范围内修改 `src/protocol.ts` 为 `PROTOCOL_VERSION = 2`；修改 `bridge-client.ts` 移除空 ID 降级，保证每次重连的 WS query 与 hello 使用同一 ID，并更新 4401/4403 提示
- [x] 4.6 替换 `test/bridge.test.ts` 中空 ID 与旧解析优先级用例，运行 `npx vitest run test/bootstrap-device-id.test.ts test/bridge.test.ts`，预期全部通过

## 5. 契约与文档同批更新

- [x] 5.1 更新 `contracts/openapi-3.1.yaml`：按真实 camelCase 修正 PKCE 字段，增加 deviceId/元信息、固定正则、成功响应和顶层错误 code；更新 `contracts/asyncapi-3.0.yaml` 为 hello 协议 v2 与非空 ID
- [x] 5.2 更新 `README.md`、`README.zh-CN.md`：协议表标注 hello `protocolVersion = 2`、非空 deviceId 与本次实际 major 发布版本（不得沿用历史“≥0.2.0”）；同时写明身份文件实际路径、`AGENT_BRIDGE_CONFIG` profile 规则、卸载重装/删除恢复、重绑、跨账号冲突及“删除整个身份配置会产生新设备”边界
- [x] 5.3 更新相关 `site/src/content/docs/**` 与 `CHANGELOG.md` 的 `[Unreleased]`，明确 breaking/major，发布提交使用 `feat!` 由 semantic-release 决定实际版本；不得把 refresh 自动续期、跨账号自动转移或平台重复设备自动合并写成已支持
- [x] 5.4 运行 `npm run contracts:check && npm run doc:check`，预期均通过；契约脚本只做机检，不生成 YAML，因此 YAML 必须随实现直接维护

## 6. 端到端与整体验证

- [x] 6.1 新建 `test/e2e-device-identity.test.ts`，使用临时 profile、真实 CLI 进程和本地 mock 平台，覆盖两种授权、响应丢失、并发 connect，以及同 ID 两条 WS 的 URL/hello 一致性；不得修改 `.harness/` 下脚本
- [x] 6.2 运行 `npm run build && npx vitest run test/e2e-device-identity.test.ts`，保存每个场景的 ID 不变、请求字段、无重复生成和无凭证互覆证据（5 个真实 CLI 场景，含 token 保存前 SIGKILL 后 stale lock 回收重试）
- [x] 6.3 运行 `npm test`、`npm run gate`、`npm run harness:validate`，预期全部通过并保留真实输出；若 e2e 超时先复查项目已知串行探针预算问题（2026-10-25：223 通过 + 1 跳过；gate/harness 全绿）
- [x] 6.4 人工维护卡点：由人工更新 `.harness/skills/protocol-e2e/scripts/e2e-smoke.mjs` 及对应说明，为真实 CLI 传入合法 `--device-id`、将 hello 断言改为协议 v2 并校验 URL/hello 身份一致；同时核对 `.harness` 中历史“≥0.2.0”版本表述。Agent 不得修改这些文件，人工完成前不得执行下一步或归档（补丁已由人工应用；`git apply` 重试报重复应用，正式 smoke 与 harness 自检已通过）
- [x] 6.5 在人工更新 smoke 后运行 `npm run build && npm run e2e:smoke`，预期原协议/runner 主链路冒烟通过；若仍失败，保留证据并修复 bridge 侧回归，不绕过护栏（2026-10-25 正式 smoke 全部通过：v2、deviceId query/hello 一致、12 工具、scan、真实任务、timeout）
- [x] 6.6 ~~与已部署 E2ePilot `fix-bridge-device-rebinding` 的环境联调：平台接受 v2~~ ——
      **2026-10-27 范围变更：该项的前提已消失**。`add-task-execution-control` 采用 1.0 破坏性升级，
      `PROTOCOL_VERSION` 统一为 **1**，不再存在 v2，平台与 bridge 同批升级、不保留 0.2.x 双栈。
      本地身份语义（强制合法 ID、响应 `device_id` 必须一致、不生成替代身份）已全部并入 spec 并保留；
      真实平台的 v1 联调转为 `add-task-execution-control` 的平台验收项跟踪，本提案不再单独执行。

## 7. 评审与归档

- [x] 7.1 对照外部需求 P0、设计 §8 验收表和本清单逐项核验；部分完成必须如实记录，不以单元测试代替缺失的平台联调（本地 P0 与自动化证据已核对；6.4/6.5 人工 smoke、6.6 平台联调明确未完成，不归档）
- [x] 7.2 人工评审代码、契约和测试证据（2026-10-27 用户授权 Agent 代行：单测 + 5 个真实 CLI E2E、gate/harness 均绿）
- [x] 7.3 将两份 spec 增量合并到 `openspec/specs/bridge-protocol/spec.md` 与新建的 `openspec/specs/device-identity/spec.md`（2026-10-27 已合并；合并时把 `PROTOCOL_VERSION = 2` 按 1.0 现实改为 1）
- [x] 7.4 确认 tasks 全勾、门禁全绿后，将本提案整体移入 `openspec/changes/archive/YYYY-MM-DD-fix-stable-device-identity/`（2026-10-27 移入 `archive/2026-10-27-fix-stable-device-identity/`）
