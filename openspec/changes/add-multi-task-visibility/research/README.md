# 步骤流事件格式调研（2026-10-24 实测 + 官方文档，全量 12 工具）

> 实测样例是真实 CLI 的最小任务输出（JSONL）。单测 fixture 在 `test/fixtures/`。

## 结论一览（终版：12/12 全部支持步骤流）

| 工具 | 启动参数 | 事件格式 | 解析器 | 取证 |
| --- | --- | --- | --- | --- |
| claude-code | `-p … --output-format stream-json --verbose` | claude 风格（assistant.content[].tool_use / user.tool_result，`tool_use_id` 配对） | `claude-json` | ✅ 实测 |
| codebuddy-cli | 同上（help 实测同构） | 同 claude | `claude-json` | ✅ help 实测 |
| grok-cli | `--single … --output-format streaming-messages-json` | claude 同构 | `claude-json` | ⚠️ 骨架实测（未登录，tool_use 样例未取得） |
| qoder-cli | `qodercli -p … --output-format stream-json` | claude 同构 | `claude-json` | ✅ 实测 |
| trae-cli | `traecli exec --print --output-format stream-json` | claude 同构 | `claude-json` | ⚠️ 骨架实测（未配模型，init 确认） |
| codex | `exec --json …`（stdin 须关闭，spawn stdio ignore 天然满足） | `item.started`/`item.completed`（`item.id` 配对，只收动作类） | `codex-json` | ✅ 实测 |
| opencode | `run --format json …` | `tool_use` 一次带齐 `part.state.status` | `opencode-json` | ✅ 实测 |
| mimo-code | `run --format json …`（opencode fork，官方 drive-mimo skill 确认同构） | 同 opencode | `opencode-json` | ⚠️ 401 骨架实测 + 官方 skill 文档 |
| gemini | `-p … --output-format stream-json` | init/message/tool_use/tool_result/result（字段双写法兼容） | `gemini-json` | ⚠️ 官方文档（本机缺凭据） |
| kimi-code | `-p … --output-format stream-json` | OpenAI 风格 `assistant.tool_calls[]` / `role:tool` | `kimi-json` | ✅ 实测 |
| ds-harness | `--profile headless --json …`（**需 ≥0.2.x**，0.1.5 实测 `--json` 无效） | session/status/tool_call/tool_result/final（`callId` 配对） | `dsh-json` | ⚠️ 骨架实测 + 官方文档 |
| minimax-code | `mcode exec --output-format stream-json …` | `item.started/completed` + `item.type=tool_call`（`toolCall{name,input}`；`item.updated` 增量跳过；started 时 input 未齐，label 在 completed 补齐） | `mcode-json` | ✅ 实测（0.6.13） |

## 顺带修掉的适配器 bug（本批次全量实测发现，共 6 个）

1. opencode：`--json` → `--format json`（原参数无效）
2. kimi-code：`--headless '{{prompt}}'` → `-p '{{prompt}}'`（`--headless` 实测 `unknown option`，任务必败）
3. grok-cli：`run '{{prompt}}'` → `--single '{{prompt}}'`（无 run 子命令，'run' 会被当成 prompt）
4. qoder-cli：bin `qoder` → `qodercli`（原 bin 命中 Qoder IDE 的 Electron 入口 `.qoder/entry/qoder.cmd`，
   探测到 IDE 会误报 ready；taskArgs `exec` → `-p`，qoder 无 exec 子命令）
5. minimax-code：`run '{{prompt}}'` → `exec --output-format stream-json '{{prompt}}'`（无 run 子命令）
6. trae-cli：`run '{{prompt}}'` → `exec --print --output-format stream-json '{{prompt}}'`（无 run 子命令；
   本机原已装 0.121.3 于 AppData 但不在 PATH，另装 0.211.1 于 `~/.trae/bin` 并硬链到 `.nvmd/bin`）

## 行为变化（须周知平台）

claude-code / codebuddy-cli / kimi-code / qoder-cli / trae-cli / ds-harness / minimax-code 的任务输出
（`task_log`）从纯文本变为 **JSONL 事件流**（信息更全；`task_step` 提供结构化视图）。
codex / opencode / mimo-code / grok-cli / gemini 本来就是（或转为）JSONL。

## 样例文件

claude-stream-json-sample / claude-tooluse-sample / codex-json-sample / opencode-json-sample /
kimi-stream-sample / qoder-stream-sample（含 tool_use）/ grok-stream-sample / trae-stream-sample /
dsh-json-sample（骨架）/ mimo-json-sample（401 骨架）
