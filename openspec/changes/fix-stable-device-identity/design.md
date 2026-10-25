# agent-bridge 稳定设备身份修复技术方案

> 状态：技术方案已评审并纳入 OpenSpec 提案；本提案待人工评审，获批前不修改产品代码。
>
> 外部需求：agent-bridge 稳定设备身份需求文档；配套平台变更：E2ePilot `fix-bridge-device-rebinding`。

## 1. 目标与结论

同一运行账号、同一 profile 下，设备身份在重连、重新授权、授权方式切换、失败重试和版本升级中保持不变。

核心设计只有三条：

1. **身份与凭证分离**：新增 `identity.toml` 作为 `deviceId` 唯一真源；`config.toml` 继续保存凭证和业务配置，并保留 `deviceId` 镜像用于旧版本兼容。
2. **身份先于授权落盘**：需要交互授权时，先完成迁移或生成并持久化身份，再发起 PKCE / 设备码流程；平台是否可达不影响本地身份。
3. **所有出口只使用本地身份**：授权请求、WS URL、`hello.deviceId` 都来自同一个已持久化值；平台响应只准确认，不准改写。

不新增运行时依赖，继续使用 Node.js ≥20、TypeScript、Vitest、`smol-toml` 和 `ws`。

## 2. 现状与根因

当前实现存在以下直接缺口：

- `src/infra/auth.ts` 从平台响应取得 `device_id`；PKCE 与设备码请求均未发送本地 `deviceId`。
- `src/app/bootstrap.ts` 只在授权成功后调用 `saveConfig()`，因此授权前没有本地身份。
- `src/infra/config.ts` 将读取、TOML 解析等异常统一吞掉并返回 `null`，会把“损坏/不可读”误判为“未绑定”。
- `saveConfig()` 直接覆盖目标文件，没有临时文件、fsync、原子替换或跨进程锁。
- 两个授权响应只检查 `device_id` 是否存在，不检查格式及与请求 ID 的一致性。
- 平台错误响应只保留 HTTP 状态与文本片段，不解析顶层 `code`。
- `resolveDeviceId()` 和现有正式规格允许空 ID 建立 WS，这与新需求冲突。
- 当前没有授权 single-flight；`refresh_token` 仍只保存、不使用，本方案不把自动续期扩大进本次范围。

根因是：**当前把平台签发的设备记录 ID 与本地安装身份混成了一个在授权成功后才出现的值，且身份与可轮换凭证共用一次覆盖写。**

## 3. 关键设计决策

### 3.1 存储布局与 profile 规则

默认路径沿用当前代码实际规则：

| 系统 | 身份文件 | 凭证/配置文件 |
| --- | --- | --- |
| POSIX | `~/.agent-bridge/identity.toml` | `~/.agent-bridge/config.toml` |
| Windows | `%APPDATA%\.agent-bridge\identity.toml` | `%APPDATA%\.agent-bridge\config.toml` |

`AGENT_BRIDGE_CONFIG` 仍是显式指定 profile 的现有机制：它指向该 profile 的 `config.toml`，`identity.toml`、锁文件和其他状态均放在其父目录。不同 profile 必须使用不同父目录；不新增另一套 profile 参数，避免两套路径规则互相覆盖。

身份文件采用最小结构：

```toml
schema_version = 1
device_id = "bd_<32-or-12-lowercase-hex>"
```

- 新安装：`bd_` + `randomBytes(16).toString('hex')`，即 128 bit 随机、32 位小写 hex。
- 迁移：兼容已有 `bd_` + 12 位小写 hex，不把旧 ID 升级为“更长的新 ID”。
- 共用校验正则：`^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`。
- 不采集 MAC、CPU、硬盘序列号或其他硬件指纹。

`config.toml` 中继续写入相同的 `deviceId`，但它只是**兼容镜像**：身份文件存在时，镜像不能覆盖真源；二者不一致则停止并报告本地身份冲突，避免把 A 身份的 token 用于 B 身份。

### 3.2 身份获取的三种结果

新增身份存储接口，返回：

```ts
type IdentitySource = 'created' | 'migrated' | 'reused';
type DeviceIdentity = { deviceId: string; source: IdentitySource };
```

日志只由应用编排层根据结果输出一条明确信息：

- `created`：本地首次生成；
- `migrated`：从旧配置或用户显式提供的既有 ID 迁入；
- `reused`：读取并复用已存在身份。

身份文件的读取结果必须区分“不存在”和“存在但无效”：

- 不存在：进入严格迁移/生成流程；
- 空文件、半文件、TOML 损坏、schema 不支持、ID 非法、无权限或其他 I/O 错误：立即停止，不生成替代身份。

### 3.3 迁移优先级与冲突处理

仅当 `identity.toml` 确实不存在时，按以下顺序寻找可迁移值（交互授权与预签发 token 模式均适用）：

1. 旧 `config.toml` 的 `deviceId`，并兼容读取早期可能的 `device_id`；
2. 显式 `--device-id`；
3. `AGENT_BRIDGE_DEVICE_ID`。

多个来源同时存在且值不同，报本地身份冲突并停止，不静默“选一个”。因此用户在交互授权前显式提供旧 ID 时也会迁移该值，而不是生成新 ID。迁移写入后再次启动只返回 `reused`，不重复迁移。

只有**即将进行交互授权、没有任何可复用凭证、身份文件不存在且没有可迁移 ID**时才生成新 ID。两个重要防误用约束：

- 已存在可复用 token、但既无身份文件也无可迁移 ID：停止并要求恢复身份，不随机生成后拿去配旧 token。
- `--token` 模式没有可迁移/显式 ID：停止并提示提供 `--device-id`，不随机生成。

身份文件已存在时，显式 `--device-id` / 环境变量只能等于真源；不同则报错。平台地址、hostname、OS、CLI 版本或授权方式变化均不参与 ID 计算。

### 3.4 原子写入与权限

新增内部原子文件写入器，供身份和配置共同使用：

1. 在目标文件同目录创建唯一临时文件，POSIX 以 `0600` 打开；
2. 写入完整内容，执行文件 `fsync`，关闭文件；
3. POSIX 校验 `0600`；Windows 在临时文件发布前设置仅当前用户及必要服务账号可读的 ACL；
4. 用原子方式发布到目标路径，并在支持的文件系统上执行目录 `fsync`；
5. **发布前**任一步失败均保留旧文件并停止后续授权或连接；若发布已完成、仅目录持久化确认失败，则本次仍停止授权并报告不确定状态，但不得删除或重建已发布文件，下次启动必须先读回并复用该身份。所有错误都包含路径与可操作建议。

身份新建还需要**不覆盖发布语义**：使用同目录临时文件加原子 hard-link 发布；若目标已存在（`EEXIST`），丢弃本次候选值并读回既有身份。不支持该语义的文件系统应明确失败，不能退化为可能覆盖身份的写入。已有身份不做例行重写。

配置更新可在 profile 锁内使用原子 rename 替换。Windows ACL 通过固定可执行文件和参数数组调用系统工具完成，不引入 `shell: true`；无法确认权限时按失败处理，而不是把 `chmod` 的 Windows 语义当成 ACL 保证。

### 3.5 并发与崩溃恢复

新增 profile 级 `withProfileLock()`，保护：

- 身份首次创建/迁移；
- PKCE / 设备码授权及随后的凭证保存；
- `logout` 等凭证清除操作；
- 未来设备 token 轮换写（本次不实现自动 refresh）。

锁实现要求：

- 使用原子排他创建，记录随机 owner token、PID、hostname、创建时间；
- 同进程重入复用同一个 Promise，跨进程重复 `connect` 明确提示“该 profile 已有绑定进行中”；
- 获取锁后必须重新读取身份和配置，避免另一进程刚完成授权后仍重复授权；
- `finally` 只释放持有相同 owner token 的锁；
- 进程崩溃后，仅在同 hostname 且 PID 已确认不存在时回收 stale lock；不能仅凭超时强拆，因为浏览器授权可能持续 180 秒；
- stale 判定、复核与删除由独立 recovery guard 做跨进程互斥，防止两个回收者误删随后创建的新锁；recovery guard 自身不自动强拆，无法安全取得时拒绝；
- 无法确认锁是否过期时安全失败，并给出锁路径和人工处理前提。

即使锁层发生异常，身份存储仍通过“生成前后重读 + 不覆盖发布”保证已保存 ID 不被替换。

## 4. 授权与连接改造

### 4.1 统一授权上下文

两个授权入口改为接收同一份上下文，而不是各自决定设备身份：

```ts
interface AuthContext {
  platformUrl: string;
  deviceId: string;
  hostname: string;
  platform: NodeJS.Platform;
  cliVersion: string;
}
```

`authorizeWithBrowser()` 和 `authorizeWithDeviceCode()` 都使用该上下文。授权成功后 `AuthResult` 不再作为设备 ID 的来源；调用方继续持有授权前的 `deviceId`。

### 4.2 请求字段

`POST /api/bridge/token` 在现有字段上增加并固定发送：

```json
{
  "code": "...",
  "codeVerifier": "...",
  "redirectUri": "http://127.0.0.1:<port>/callback",
  "clientId": "agent-bridge",
  "deviceId": "bd_<stable-id>",
  "hostname": "wxt",
  "platform": "win32",
  "cliVersion": "<bridge-version>"
}
```

`POST /api/bridge/device-token` 发送：

```json
{
  "device_code": "...",
  "clientId": "agent-bridge",
  "deviceId": "bd_<stable-id>",
  "hostname": "wxt",
  "platform": "win32",
  "cliVersion": "<bridge-version>"
}
```

本次以需求文档和当前实现的 camelCase 字段为准，同时修正现有 OpenAPI 中 `code_verifier` / `redirect_uri` / `client_id` 与真实请求不一致的漂移。

### 4.3 响应校验

两个 token 成功响应必须先完成以下校验，再允许保存凭证：

- `device_token` 为非空字符串；`refresh_token` 若存在也必须为字符串；
- `device_id` 是符合固定正则的字符串；
- `device_id === AuthContext.deviceId`。

任一失败均视为协议错误：不保存 token、不建立 WS、不改写身份。错误文案可包含预期 ID 与实际 ID，但不输出响应原文，避免响应中夹带 token 或 Authorization 内容。

### 4.4 启动、重连与重绑编排

`startBridge()` 调整为目标平台明确、身份唯一的一段编排：

1. 规范化本次命令行给出的平台地址，显式参数优先于旧配置；
2. 获取 profile 锁，在锁内严格读取身份与配置，区分不存在与损坏；
3. 在锁内按交互授权、保存凭证复用、预签发 token 三种模式重新判断路径，并执行 `ensureDeviceIdentity()`；任何迁移都在锁内完成；
4. 若需交互授权，持续持锁直到授权与凭证保存完成；保存时合并既有业务设置并写入相同 `deviceId` 镜像，保存失败则本次不连接，身份仍保留；
5. 若另一进程已完成授权，则复用锁内重读到的凭证，不重复发起授权；
6. 释放 profile 锁后，再用同一个本地 `deviceId` 创建 WS URL 和 hello；锁不得持续到 WS 会话生命周期。

普通断线重连继续使用创建会话时的同一身份。`logout` 只移除 `deviceToken`、`refreshToken` 和绑定时间，不删除身份，并保留 `deviceId` 镜像、平台地址及业务设置；它通过同一原子写入器留下**有效 TOML**，而不是写空文件。配置类型需区分“未绑定但有效的设置”与“凭证齐全的已绑定配置”，使严格解析不会把正常 logout 误判为损坏。吊销后的重新授权通过“logout 后 connect”完成，并更新 4401/4403 提示，避免再次复用已吊销 token。

预签发 token 模式不再允许空 ID。`wsUrlOf()` 始终生成 `?deviceId=<id>`，`hello.deviceId` 使用同值；删除“空 ID 由 Bearer 反查”的正式行为和测试。

授权码一旦用于交换，无论成功、冲突还是平台失败，都不自动重放。设备码在 `428 authorization_pending` 期间按协议重复轮询不属于重放；一旦收到成功或终态错误，或本次交换结果因超时/网络错误而不可知，该设备码就不再用于新的交换。用户重试会创建新的 PKCE verifier/state 或新设备码，但继续使用原身份。

## 5. 平台错误处理

扩展 `AuthError`，保留 `httpStatus` 与机器可读 `code`，只解析公开 JSON 错误响应顶层的字段，不把响应正文直接写日志。

| HTTP / code | bridge 行为 |
| --- | --- |
| `400 invalid_device_id` | 报本地身份格式错误，保留身份与配置现场，不重建 |
| `409 device_bound_to_other_account` | 提示已绑定其他账号并停止；不换 ID，提示需平台管理员处理所有权 |
| `409 device_identity_ambiguous` | 提示平台历史重复并停止；不自动合并，提示需平台管理员处理 |
| `401/403` | 按凭证/授权失败处理，保留身份，不重放 code |
| `428 authorization_pending` | 仅设备码轮询继续，使用服务端 interval，不生成新 ID |
| 其他 JSON/网络/超时错误 | 保留身份并报告可操作错误；是否重试由现有流程决定，绝不以换 ID 规避 |

成功响应缺字段、类型不符或 ID 不一致与平台错误分开记录为协议错误，避免误诊为账号冲突。

## 6. 文件级改造清单

### 新增

- `src/core/device-identity.ts`：固定正则、格式校验和纯冲突判断，不碰文件系统。
- `src/infra/device-identity-store.ts`：身份路径、读取、迁移、生成、来源结果和持久化。
- `src/infra/atomic-file.ts`：临时文件、fsync、权限、不覆盖发布/原子替换。
- `src/infra/profile-lock.ts`：授权与凭证写的 single-flight、stale lock 处理。
- `test/device-identity.test.ts`：格式、迁移、幂等、损坏、权限和并发身份测试。
- `test/auth.test.ts`：两种授权请求、响应一致性、错误码和不重放测试。
- `test/bootstrap-device-id.test.ts`：启动模式、并发、保存失败、WS 全链路同 ID 测试。

### 修改

- `src/infra/config.ts`：严格读取、原子保存、保留兼容镜像、合并旧设置；不再吞掉损坏错误。
- `src/infra/auth.ts`：接收 `AuthContext`，发送 ID/元信息，校验响应并解析平台错误。
- `src/app/bootstrap.ts`：身份先行、锁内重读、统一目标平台与 WS 身份。
- `src/protocol.ts`：`PROTOCOL_VERSION` 从 1 升至 2；空 ID 兼容语义移除属于破坏性收紧，hello 字段结构不变。
- `src/transport/bridge-client.ts`：移除空 ID 兼容路径，URL 与 hello 强制同 ID，并发送协议 v2。
- `src/commands/logout.ts`：清凭证但保留身份，并纳入同一 profile 锁。
- `src/cli/help.ts`：更新预签发 token 和重绑说明。
- `test/bridge.test.ts`：替换空 ID、旧优先级等与新语义冲突的用例。
- `README.md`、`README.zh-CN.md`：路径、profile、迁移、冲突、重绑和删除边界。
- `contracts/openapi-3.1.yaml`、`contracts/asyncapi-3.0.yaml`：请求字段、错误 code、ID 正则和非空语义。
- `openspec/specs/bridge-protocol/spec.md`：通过新提案修订空 ID 与授权行为；新增本地身份能力规格。
- 相关站点文档与 `CHANGELOG.md`：随实现同批更新，避免不同入口口径漂移。

`src/protocol.ts` 的 hello 字段结构无需改变，也不新增 wire 类型或运行时依赖；但旧规格允许空 ID，新语义收紧为合法非空 ID，按 `.harness/rules/protocol-contract-rules.md` §3 必须将 `PROTOCOL_VERSION` 升至 2。平台需配套接受 v2，并保留旧 bridge 的 v1 兼容窗口。

## 7. 实施顺序与验证证据

实施计划已写入本提案 `tasks.md`；提案获批后按以下顺序小步落地：

1. **身份纯函数与持久化**：先写失败测试，再实现格式、迁移、原子写和日志来源。
2. **配置严格化与 profile 锁**：覆盖损坏/不可读/写入失败、并发、崩溃锁和设置保留。
3. **两种授权流程**：覆盖请求正文、响应 ID、平台错误、code 不重放。
4. **启动与 WS 收口**：覆盖复用、重绑、预签发 token、URL/hello 一致和 logout 保身份。
5. **契约与文档**：OpenSpec 增量、两份 README、OpenAPI/AsyncAPI、站点说明同批更新。
6. **端到端取证**：mock 平台自动化后，再与部署了 `fix-bridge-device-rebinding` 的平台联调。

每个实施任务均运行相关 Vitest；整批收尾必须取得以下新鲜证据：

```bash
npm run gate
npm run harness:validate
npm run build
npm run e2e:smoke
```

若机器繁忙导致 e2e 超预算，先按项目已知探针串行问题复查，不把超时直接当身份回归。

## 8. 验收测试映射

| 需求场景 | 自动化断言 |
| --- | --- |
| 首次启动、平台不可达 | 发起网络前身份已落盘；恢复后请求仍带该 ID |
| 连续重启 3 次 | 三次 ID 相同；`created` 只出现一次，之后为 `reused` |
| PKCE / 设备码重绑 | 两种请求均带原 ID 和元信息；响应校验通过 |
| 平台成功但响应丢失 | 新授权流程仍使用原 ID，旧 code 不重放 |
| token 保存失败后重试 | 身份文件内容不变；重试仍用原 ID |
| 旧配置升级迁移 | 12 位旧 ID 原样保留；第二次启动无写入、无重复迁移 |
| 同 profile 两个 connect | 一个进入授权，另一个复用结果或收到明确锁错误；只有一个 ID，凭证不互相覆盖 |
| 进程在 token 保存前退出 | stale lock 可安全恢复；重试读取同一身份 |
| 配置/身份损坏或不可读 | 明确失败；无新文件、无替代 ID、无网络授权 |
| 需要写入但实际不可写 | 授权/保存明确失败；旧身份不变。有效身份在只需读取时仍允许复用，不因文件模式位是只读就一概拒绝；测试注入真实写入失败，不假设 POSIX `0444` 一定能阻止目录内原子替换 |
| 平台返回不同 device_id | 不保存凭证、不创建 WS、身份不变 |
| 跨账号冲突/历史歧义 | 展示指定管理处理文案；不换 ID、不自动合并 |
| 多 profile | 不同配置父目录各自保留原 ID，互不覆盖 |
| WS 重连 | 每次 URL query 与 hello 都等于身份真源 |
| logout 后重绑 | 凭证清除但身份保留；新 token 仍绑定原 ID |

## 9. 平台联调与发布顺序

1. 平台先部署 `fix-bridge-device-rebinding`，接受 hello `protocolVersion = 2`，同时保持对旧 bridge v1 与缺省 `deviceId` 请求的兼容窗口；确认公开 orchestrator JSON 错误顶层包含 `code`。
2. 将 bridge 身份迁移候选版本部署到测试或预发布环境，首次绑定记录平台与本地 ID；此时尚不正式发布。
3. 联调 PKCE 重绑、设备码重绑、响应丢失重试、进程重启和并发 connect。
4. 每次核对平台设备列表不新增同机记录，工作区配置、项目设备绑定和历史任务仍引用原 ID；建立同 ID 新 WS 后关闭旧进程，确认旧连接关闭不会误删新连接且平台仍在线。
5. 全部联调与业务引用核验通过后，再以 breaking/major 语义正式发布 bridge；发布提交使用 `feat!`，实际版本由 semantic-release 确定。

回滚时，配置中的 `deviceId` 镜像可帮助旧版本读取最近绑定；但旧版本不具备本次稳定性保证，回滚只作为故障止损，不作为长期兼容方案。

## 10. 非目标与边界

- 不实现硬件指纹、克隆系统识别、平台重复设备自动合并或跨账号所有权自动转移。
- 不在本次实现设备 refresh token 自动续期；后续实现必须复用本方案的 profile 锁与身份真源。
- 不因 hostname 相同复用 ID，也不因平台地址改变生成新 ID。
- 用户删除整个 profile 状态目录，或同时删除身份文件与所有可迁移镜像后，再启动属于新安装语义；日志明确说明会创建新设备。
- 仅删除 `identity.toml` 但旧配置镜像仍在时，会迁移恢复原 ID，而不是制造新设备。

## 11. 评审重点

- **预签发 token 无 ID**：必须失败，不能为通过连接而随机生成身份；由 `bootstrap-device-id` 测试固定。
- **损坏与不存在**：任何解析/I/O 异常都不能走“首次生成”；由身份与配置故障注入测试固定。
- **锁与身份双保险**：锁竞争之外，身份发布自身必须不覆盖；由多进程竞争与 `EEXIST` 测试固定。
- **兼容镜像冲突**：身份与配置镜像不同必须停止，不能静默修复后错配 token；由启动测试固定。
- **Windows 权限与原子发布**：必须在真实 Windows 上验证 ACL、原子替换及崩溃后的文件可读性，不能只靠 POSIX 单测推断。
- **敏感日志**：平台错误正文、token 保存异常和授权失败均不得泄露 token/Authorization；由日志捕获测试固定。
