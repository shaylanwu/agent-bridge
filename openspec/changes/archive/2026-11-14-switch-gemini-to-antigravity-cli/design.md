# 设计取证：switch-gemini-to-antigravity-cli

> 全部结论以 **2026-11-14 本机实测（agy 1.4.10，未登录路径）** + **官方文档** + **二进制内字符串** 三方交叉，
> 未实测的成功路径（已登录事件流）以官方 headless 文档与第三方契约库（github.com/maruel/genai `providers/antigravity`，建模 agy 1.2.x 流）佐证，
> 解析器按「认不出就跳过、不虚构」的既有原则容错。

## 1. 实测记录（本机 agy 1.4.10，未登录）

| 探测 | 结果 |
| --- | --- |
| `agy --version` | `1.4.10`（Go 单文件，`%LOCALAPPDATA%\agy\bin\agy.exe`，**不在 PATH**） |
| 子命令面（`--help`） | agent(s) / changelog / install / mcp / mic-serve / models / plugin(s) / remote-control / update —— **无 `acp`** |
| `-p` 语义 | `-p` 吞下一 token 当 prompt：`-p --output-format` 报错并提示「Attach the prompt to the flag… move --output-format elsewhere」⇒ **prompt 必须紧跟 -p 且置于 argv 末尾** |
| `--output-format json`（未登录） | stderr：`Waiting for authentication (timeout 60s)...` → 60s 后 stdout 吐 `{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out",…}`，**进程不退出**（`timeout 75` 以 124 kill 实锤挂死） |
| `--output-format stream-json`（未登录） | stderr 立即打 `Authentication required. Please visit the URL to log in:`（Google OAuth URL）→ 同上 60s 等待 → stdout 单行 `{"event":"result","result":{…同上信封…}}` → 挂死 |
| 续会话 | `--conversation <ID>`（help 明示 "Resume a previous conversation by ID"）；`--continue/-c` 续最近 |
| full 旁路 | `--dangerously-skip-permissions`（官方文档："auto-approve all tool permission requests"） |
| 退出码 | 官方文档：0=成功**或 `--print-timeout` 到期的优雅部分完成**、1=配置/旗标错、2=print 模式用法错 ⇒ **退出码 0 ≠ 完成**，必须核 `status` |

## 2. 流契约（官方 headless 文档 + maruel/genai 建模，与本机信封实测一致）

```
信封（每行一个）：{"event": "init"|"step_update"|"result", "conversation_id": …, "init": {…}, "step_update": {…}, "result": {…}}
init:        conversation_id、cwd、tools[]、permission_mode（request-review | always-proceed）
step_update: conversation_id、step_index（0 起）、state（ACTIVE|DONE）、step_type
             （user_input|agent_response|tool|checkpoint|finish|system_message）、
             tool_name、text_delta、duration_seconds、usage、tool_info{name,parameters,output,error{type,message}}、
             subagent_info{subagents[]{type_name,role,conversation_id,log_uri,workspace_uris}}
result:      conversation_id、status（SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING）、response、error、
             duration_seconds、num_turns、usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}
```

官方文档实样（tool 步骤，与本机未登录信封逐字段吻合）：

```json
{"event":"step_update","step_update":{"conversation_id":"edb1c8c1-…","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.07,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_headless_demo"},"output":"hello_headless_demo\r\n"}}}
```

解析器要点：
- `tool` 步骤 ref 用 `step_index`（ACTIVE/DONE 两态配对，同一步不占两个 seq）；
- `label` 优先 `tool_info.parameters` 的 `CommandLine` 键（agy 特有大小写，通用 labelOfInput 不含）；
- 最终回答 `result.response`；`text_delta` 累积作兜底（agent_response 的 ACTIVE 增量）；
- `conversation_id` 在信封顶层，命中 supervisor 既有 onSession 正则（`session_id|thread_id|conversation_id`），无需新机制。

## 3. 认证挂死守卫（实测驱动）

- 触发文本取实测值：`Authentication required` 与 `Waiting for authentication`（两条 stderr 前缀，**立即**出现，先于任何 stdout 事件）；
- 未命中守卫的后果实测为「60s 静默 → 打印 ERROR 结果 → 进程不退出」——不 kill 就是干等总超时；
- 结算：`tool_no_credentials`（既有受控错误码，HTTP 400），错误文案带 `loginCommand` 指引；
- 字段放 `AgentDef.authGuard`（逐工具声明，dsh/grok 等不需要的工具不声明 ⇒ 零行为变化）；
- supervisor 侧对 stderr 做有界缓冲再匹配（防模式跨 chunk 断裂）。

## 4. 凭据探测口径（如实声明）

- 二进制字符串：`Keyring SaveToken/LoadToken/SaveUserTier … timed out after %v, falling back to file storage` ⇒ **令牌主存 OS keyring**（Windows 凭据管理器），文件只是 keyring 失败时的回退；
- 本机 `~/.gemini/antigravity-cli/`（配置目录，binary 自述）无任何凭据文件；`settings.json` 仅 agentMode/沙箱/信任目录；`auth.json` 字样在 binary 中属 **MCP server auth** 语境（"auth.json declares no providers"）；
- ⇒ `envs: []` / `files: []` → 探测恒为 `unknown` → 保守报 `installed_no_cred`（本机当前未登录，恰好如实）；
- `envKey` 不开放（GEMINI_API_KEY + `--settings '{"modelProvider":"gemini"}'` 注入链路未对 1.4.10 复验，按「未验证不声明」留作后续）。

## 5. 平台契约影响面

- `agent_list`：`gemini` 条目消失、`agy` 条目出现（`kind` = agentType 精确匹配值）——平台侧需同步 agentType 映射；
- ACP 声明数 9 → 8（gemini 退役；agy 无 ACP 是官方 CLI 事实：无 `acp` 子命令）；
- headless 原生续接（resumeArgs）4 → 5：claude / codebuddy / dsh / qoder / **agy**；
- wire 消息数（40）、capabilities（20）、受控错误码（23）、`PROTOCOL_VERSION=1` 均不变（1.0 口径：工具增换不递增版本）。

## 6. kind 命名决策

`kind: 'agy'`：与 `codex`/`opencode` 同例取可执行名（短、无歧义）。`antigravity-cli`（安装目录名）作为
display 的补充信息放在 README，不进 kind —— agentType 是高频匹配值，取最短唯一名。
