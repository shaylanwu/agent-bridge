# add-task-execution-control 评审材料（8.1）

> 生成：2026-11-23。供人工评审使用——每条结论都附「证据在哪、怎么复跑」。
> 勾选状态：**78 checked / 25 unchecked**（未勾 = 1.8 人工项 + §8 评审归档 4 项 + §9 完整目标治理项）。

## 评审结论（2026-11-23 21:50，五点选项交互）

| # | 拍板点 | 结论 |
| --- | --- | --- |
| D1 | scope 兼容 | **保留 any-of**（session:read / task:read 任一命中；对外契约钉死） |
| D2 | 产物内容边界 | **元数据 only**（无 adapter artifact 事件不读内容，如实 404） |
| D3 | CodeBuddy ACP 登录墙 | 如实注明，不做绕过（无替代选项） |
| D4 | ACP 帧上限 | **1 MiB**（常量 ACP_MAX_LINE_BYTES，可调） |
| D5 | §9 剩余 19 项 | **另开提案排期**，本提案按 1.0 交付面收口 |

五点全部落定、无额外异议 —— 8.1 评审通过。

## 一、六批改动索引（2026-11-22 ~ 2026-11-23，阶段四）

| 批 | 主题 | 关键改动 | 红灯证据 | 复跑 |
| --- | --- | --- | --- | --- |
| 1 | **调度终态语义**（3.3/3.4/2.9/3.9） | 移除 MAX_TRACKED（settle 落库后即回收，SQLite 唯一权威）；终态后 log/step 五处回调守卫；`[feed]` 配置段 + SessionStore 三层预算 + feed_gaps 表（gaps 带 reason，前缀删除走 prunedThrough） | `test/supervisor-settled-guards.test.ts` 3/3（红灯：迟到输出仍上行）+ `test/feed-budgets.test.ts` 7/7 | `npx vitest run test/supervisor-settled-guards.test.ts test/feed-budgets.test.ts` |
| 2 | **交互内核收尾**（5.7/5.8/5.9/5.11） | Broker.expire 重写（有 reject_once 选原 optionId；否则 cancelled + onExpired → interaction_timeout）；full 残余权限 fail closed（interaction_denied）；每任务一个 pending；交互响应审计（Form content 不落审计）；新错误码 ×2 | `test/interaction-semantics.test.ts` 9/9（红灯 8/9） | `npx vitest run test/interaction-semantics.test.ts test/interaction-broker.test.ts` |
| 3 | **feed 富化**（4.7/4.8） | claude-json 中间 agent 消息（CLI 原生 messageId + appendMessage 幂等）；task_step 富 toolCall（ACP/claude-json/常驻 stream 三路，rawInput 不上行） | `test/feed-enrichment.test.ts` 8/8（红灯 8/8） | `npx vitest run test/feed-enrichment.test.ts test/step-parsers.test.ts` |
| 4 | **artifact 提取与路径安全**（4.9/9.9） | `core/artifact-extract.ts`（realpath 子树/凭据路径/同 fd SHA-256）；changedFiles → 元数据事件（无 adapter 事件不读内容，contentUnavailableReason 如实）；task_artifact 的 sha256 可选化 | `test/artifact-extract.test.ts` 12/12 | `npx vitest run test/artifact-extract.test.ts` |
| 5 | **文档映射**（6.4-6.8） | README 双语 A2A 映射细则（终态无 final 字段/delta 不冒充/权限非 A2A 原生/扩展 URI 表）+ MCP 宿主段（诚实边界）；站点 CLI 页简版矩阵 | 对实现逐键核验（两处初稿偏差被纠正） | `npm run site:check && npm run doc:check && npm run contracts:check` |
| 6 | **验证矩阵 + 发布前置**（7.1-7.12/1.9/2.7/5.2） | stopReason 完整结算 5 例；cancel scope 反向；hello 契约；ACP 帧上限（createBoundedLineReader 1MiB）；1.9 盘点 + scope 裁决 | `test/acp-stopreason.test.ts` 5/5 + `test/acp-line-reader.test.ts` 4/4 | 见下节 |

**总体复跑**（每批终态都跑过，当前 HEAD 状态）：

```bash
export PATH="$HOME/.nvmd/versions/24.11.1:$PATH"   # Node 24（better-sqlite3 ABI）
npm run gate                                        # 聚合门禁（vitest 高并行偶发既有抖动，见下）
npx vitest run --maxWorkers=2 --testTimeout=60000   # 低并发全量（最近：714 passed / 1 skipped）
npm run e2e:smoke                                   # 真 CLI 冒烟 13/13
node scripts/gateway-e2e.mjs                        # 网关 e2e 15/15（需 E2E_PROXY 视环境）
```

> 已知抖动（非本提案引入）：vitest 高并行时真 spawn 用例（claude-resident/interaction-broker/身份）随机超时，单独复跑即绿（2026-11-17/18/22 三次记录）；聚合 gate 挂死时以低并发全量 + 各分项门禁为准。

## 二、需要你拍板的点

| # | 决策点 | 我的裁决与理由 | 若不同意 |
| --- | --- | --- | --- |
| D1 | **1.9 scope 兼容保留** | `session:read`/`task:read` any-of **保留**：README 端点表 ×6 与 openapi 契约都钉了「1.0 之前签发的 task:read 仍被接受」，移除=对平台已签发令牌的对外破坏性变更 | 走提案：契约同批变更 + 通知平台废弃粗粒度令牌 |
| D2 | **4.9 产物内容边界** | 无 adapter artifact 事件时 changedFiles 只出**元数据**（spec 原文「不读取内容」）；sha256 省略 + contentUnavailableReason，get_artifact 如实 404。12 个 CLI 均无 artifact 事件源，内容读取通道不空口声明 | 若要内容闭环：定义 TaskHooks.onArtifact + 接一个真实事件源（另立切片） |
| D3 | **7.9 CodeBuddy ACP** | session/prompt 在本机被平台登录墙拦截，如实注明不做绕过；DSH ACP 探针五点实测 + e2e:smoke/gateway 真跑覆盖 | 无（如需 CodeBuddy 真跑，需先解决其登录态） |
| D4 | **5.2「分片 JSONL」语义** | 理解为接收侧跨 chunk 半行重组（readline/有界读取器均做）；帧上限取 1 MiB（交互 wire 64 KiB 的同量级放宽，容纳 transcript 重放帧） | 上限可调（`ACP_MAX_LINE_BYTES` 常量） |
| D5 | **§9 剩余 19 项的去向** | 建议另开提案排期（OTel/JWT/多租户/故障注入/A2A 附件多轮等完整目标治理项），**不塞进本提案归档**——本提案按 1.0 交付面收口 | 也可以选择把若干 9.x 纳入本提案继续做（工作量另估） |

## 三、8.1 之外的既有人工项

- **1.8**：`.harness` 里登记 CodeBuddy 唯一固定 env 例外与交互适配器受控 stdin pipe（Agent 不改护栏）
- **8.4 归档移动**（8.1 评审通过后）：
  1. 你执行 `mv openspec/changes/add-task-execution-control openspec/changes/archive/2026-11-XX-add-task-execution-control`
  2. 我把 `specs/` 增量合并进 `openspec/specs/`（task-execution / bridge-protocol 两个能力的正式 spec）并核验
  3. 跑 `npm run gate` 确认归档目录未被修改

## 四、质量红线自查（本提案全程执行）

- 红灯先行：六批的每个新测试都先复现失败（见各批「红灯 N/M」记录）
- 不宣称未实现能力：MCP 段虚报两处被自查纠正（11-23 日志）；doc:check 未实现标注机检
- 文档-实现同步：contracts:check 拦截过站点错误码漂移（11-22）；README/契约/站点每批同批更新
- SQLite 红线：feed_gaps 建表 DDL 每次打开都执行（migrate() 无条件段，session-store-migrate 回归在）
- 对外契约真源：平台只读两份 README + 契约 + specs——1.9 的 scope 裁决即以此为准
