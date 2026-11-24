# task-execution 规格增量：agy 1.5 ACP

## ADDED Requirements

### Requirement: Antigravity CLI 1.5 ACP 真实能力声明

bridge SHALL 仅在 agy 1.5.9+ 的 `agy acp` 通过 initialize、session/new、session/prompt 最小真实回合及续会话验收后，为该适配器声明 acp-stdio。只有帮助文本或 initialize 成功 SHALL NOT 被当成可执行回合的证据。headless 的 prompt 压尾、认证守卫与显式 finalOutcome SHALL 保持有效。

#### Scenario: 新版 ACP 完整回合通过

- **WHEN** 本机 agy 1.5.9+ 依次完成 initialize、session/new、session/prompt=end_turn，并在第二轮续接同一 native session
- **THEN** executionModes 可声明 acp-stdio，交互种类只包含实测出现的维度

#### Scenario: 上游服务阻断真实回合

- **WHEN** initialize 后 session/new 或 session/prompt 因上游 Bad Gateway、超时或认证错误未完成
- **THEN** bridge 不声明 agy ACP 可用，不以 mock 结果替代真实验收，headless 错误按实际原因结算

#### Scenario: 原生续接重放历史

- **WHEN** agy session/load 在续接时重放历史 agent_message_chunk
- **THEN** bridge 只收集本轮 session/prompt 发出后的新 chunk，不把历史回答重复拼进本轮 result

#### Scenario: 旧版 agy

- **WHEN** 已安装 agy 不包含已验证的 ACP 入口
- **THEN** 不为其声明 acp-stdio，也不尝试以 ACP 启动旧版进程

### Requirement: agy 外部代理解析

agy 外部请求 SHALL 优先使用 AGENT_BRIDGE_EXTERNAL_PROXY；未指定时，Windows SHALL 读取当前用户系统代理。bridge SHALL NOT 把开发机端口写死到适配器，也 SHALL NOT 为未声明该行为的其他工具改变代理环境。

#### Scenario: 宿主代理与系统代理不一致

- **WHEN** 继承的宿主代理访问 Google 502，而系统代理可用
- **THEN** agy headless/ACP 使用显式或系统代理，其他适配器环境保持不变
