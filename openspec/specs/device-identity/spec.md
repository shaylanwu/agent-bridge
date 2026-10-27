# device-identity 规格

## Purpose

定义 bridge 在本机持久化的设备身份。平台用它做设备列表、工作区绑定与历史归属，因此身份必须在重装、
重启、重新授权之间保持稳定 —— **一旦换 ID，平台侧的设备绑定就断了**。本规格约束身份的唯一真源、
生成规则、迁移路径、异常处理与并发安全。

## Requirements

### Requirement: 本地稳定设备身份

bridge SHALL 在每个 profile 的状态目录维护 `identity.toml`，作为该 profile 的 `deviceId` 唯一真源。默认位置为 POSIX `~/.agent-bridge/identity.toml` 与 Windows `%APPDATA%\.agent-bridge\identity.toml`；`AGENT_BRIDGE_CONFIG` 指向自定义配置时，身份文件位于该配置文件父目录。

首次交互授权且没有任何可迁移身份时，bridge SHALL 使用密码学安全随机源生成 `bd_` + 32 位小写 hex，并在发起授权前完成本地持久化。bridge SHALL 接受已有 `bd_` + 12 位小写 hex；所有 ID 均须匹配 `^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$`。bridge SHALL NOT 使用硬件标识或额外硬件指纹生成身份。

`config.toml` 可保留同值 `deviceId` 兼容镜像，但不得覆盖身份真源。身份创建、迁移、复用 SHALL 分别记录 `created`、`migrated`、`reused` 日志；token 轮换不得改写身份。

#### Scenario: 首次启动且平台不可达

- **WHEN** 本地没有任何身份或凭证，用户发起交互授权而平台不可达
- **THEN** 网络请求前已持久化一个合法 ID；恢复网络后的重试仍使用该 ID

#### Scenario: 连续重启

- **WHEN** 同一 profile 连续启动三次
- **THEN** 三次使用同一 ID，仅首次记录 `created`，后续记录 `reused`，身份文件不被例行重写

#### Scenario: 元信息或平台地址变化

- **WHEN** hostname、platform、CLI 版本、授权方式或平台地址变化
- **THEN** 仅更新相应元信息或凭证，不改变本地身份

#### Scenario: 预签发 token 缺少身份

- **WHEN** `--token` 模式没有已保存身份、配置镜像或显式 ID
- **THEN** bridge 明确失败，不随机生成 ID 与既有 token 组合

### Requirement: 升级迁移与删除恢复

身份文件不存在时，bridge SHALL 依次检查旧配置 `deviceId`/`device_id`、显式 `--device-id`、`AGENT_BRIDGE_DEVICE_ID` 作为迁移来源。多个有效来源不一致时 SHALL 报本地身份冲突并停止。迁移 SHALL 幂等，多 profile SHALL 各自保留原 ID。

身份真源存在时，显式 ID 与配置镜像只能与其一致；存在冲突时 SHALL 停止，不得静默选择或修复后连接。已有可复用 token 但没有任何身份来源时，bridge SHALL 要求恢复身份，不得生成新 ID。

#### Scenario: 旧版本升级

- **WHEN** 旧 `config.toml` 含平台签发的 12 位 ID 而身份文件不存在
- **THEN** bridge 原样迁移该 ID；第二次启动仅复用，不重复迁移或覆盖

#### Scenario: 卸载重装

- **WHEN** 用户卸载并重装 npm 包，但原 OS 用户与 profile 状态目录仍保留
- **THEN** 重装后的 bridge 读取同一身份，授权和 WS 均继续使用原 ID

#### Scenario: 只删除身份文件

- **WHEN** 用户只删除 `identity.toml`，但配置镜像仍含原 ID
- **THEN** bridge 从镜像迁移恢复原 ID，不生成新设备

#### Scenario: 删除整个身份配置

- **WHEN** 用户删除整个 profile 状态目录，或同时清除身份文件及所有可迁移 ID，且没有可复用凭证
- **THEN** 下一次交互授权按新安装语义生成并记录新 ID，日志说明发生了身份创建

#### Scenario: 多 profile 迁移

- **WHEN** 不同配置父目录已保存不同 ID
- **THEN** 各 profile 分别迁移并保留自身 ID，不互相覆盖

### Requirement: 身份与配置持久化安全

bridge SHALL 区分文件不存在与文件存在但损坏、不可读或格式非法。后述异常 SHALL 停止授权或连接并给出可操作错误，不得进入首次生成路径。

身份与配置写入 SHALL 使用同目录临时文件、文件 fsync 与原子发布；身份新建 SHALL 具有不覆盖语义，目标竞争存在时读回既有身份。发布前失败 SHALL 保留旧文件；发布后持久化确认失败 SHALL 停止当前流程且保留下次启动可读回的现场。

身份和凭证文件 SHALL 在 POSIX 使用 `0600`，在 Windows 仅允许当前用户及必要服务账号访问。权限无法确认或写入失败时不得继续依赖该文件授权。

#### Scenario: 配置损坏

- **WHEN** 身份或配置文件为空、半文件、TOML 损坏、schema 不支持或 ID 非法
- **THEN** bridge 明确失败，不生成替代身份、不覆盖现场、不发起网络授权

#### Scenario: 写入失败

- **WHEN** 身份在授权前无法持久化，或 token 在授权后无法保存
- **THEN** 本次不建立连接；已保存身份保持不变，后续重试继续复用

#### Scenario: 身份创建竞争

- **WHEN** 两个进程在身份不存在时竞争创建
- **THEN** 不覆盖发布只允许一个候选值成为真源，另一进程读回同一 ID

#### Scenario: 有效身份只读复用

- **WHEN** 身份可正常读取而当前流程不需要写文件，仅文件模式位为只读
- **THEN** bridge 可复用身份；实际写入需求仍须通过写入成功与否判定，不仅凭模式位猜测

### Requirement: 授权并发与凭证生命周期

同一 profile 的身份创建/迁移、交互授权、凭证保存与清除 SHALL 使用同一跨进程锁。重复 `connect` SHALL 复用另一进程已完成的结果或明确提示已有绑定进行中，不得独立生成身份或互相覆盖凭证。获取锁后 SHALL 重新读取身份与配置。

锁 SHALL 记录所有者并仅由相同所有者释放。崩溃锁只能在本机 PID 已确认不存在等可判定条件下回收，不得仅因授权耗时较长而强拆。即使锁层异常，身份存储仍须通过重读与不覆盖发布保护既有 ID。

`logout` SHALL 仅移除设备 token、refresh token 和绑定时间，保留身份、配置镜像、平台地址与业务设置，并留下有效 TOML。

#### Scenario: 同 profile 并发 connect

- **WHEN** 两个进程同时对同一 profile 执行 `connect`
- **THEN** 一个进入授权，另一个复用完成结果或收到明确锁错误；最终只有一个身份且凭证不互相覆盖

#### Scenario: 进程在 token 保存前退出

- **WHEN** 授权进程已保存身份但在 token 保存前退出，用户随后重试
- **THEN** 崩溃锁被安全处理后，重试继续使用原身份，不重放旧授权码或设备码

#### Scenario: logout 后重新授权

- **WHEN** 用户执行 `logout` 后再次 `connect`
- **THEN** 旧凭证被清除，身份与业务设置保留，新授权及新 token 仍使用原 ID
