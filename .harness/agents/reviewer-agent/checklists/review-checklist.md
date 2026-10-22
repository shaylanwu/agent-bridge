# 评审清单（reviewer-agent 逐项执行）

## 1. 流程合规

- [ ] 能力级变更是否有 `openspec/changes/<id>/` 且已通过 `validate-change.sh`？
- [ ] 高风险文件（`protocol.ts` / `auth.ts` / `runner.ts`）是否已标"人工终审"？
- [ ] `tasks.md` 的勾选与 diff 是否一一对应（无跳步、无造假）？

## 2. 门禁

- [ ] `npm run gate` 实跑通过（不是"应该通过"）？
- [ ] `npm run harness:validate` 通过？
- [ ] 协议 / runner / 适配器变更是否附端到端证据（`e2e-smoke.mjs` 输出）？

## 3. 协议契约（本项目最高频缺陷区）

- [ ] wire 类型是否仍只在 `src/protocol.ts` 定义？
- [ ] 新增/修改字段是否同步两份 README 的协议表？
- [ ] 破坏性变更是否评估 `PROTOCOL_VERSION` 并与第三方平台沟通？
- [ ] `run_task` 的 `args` 必填语义是否保持（或提案里明确说明放宽）？
- [ ] 是否新增了"文档说支持、代码没实现"的能力？（对照 `protocol-contract-rules.md` §6 台账）

## 4. 安全

- [ ] 无读取凭据文件内容（只允许 `existsSync`）？
- [ ] 无完整 `device_token` 输出（只允许 `tokenTail`）？
- [ ] 参数仍以数组传递，无新增 shell 字符串拼接、无新增 `shell: true`？
- [ ] 监听仍只限 `127.0.0.1` 授权回调？
- [ ] 平台 `env` 是否被无差别并入子进程（若改动涉及，需说明信任边界）？
- [ ] 测试里无真实 token / key？

## 5. Windows 与跨平台

- [ ] 涉及 `.cmd` 垫片的改动是否仍走 `win-exec.ts`？
- [ ] 路径处理是否用 `node:path`、是否处理含空格路径？
- [ ] 是否引入只在某个平台成立的假设（`process.platform` 分支是否都有兜底）？

## 6. 测试

- [ ] 新增分支有用例？失败路径（非法输入、缺字段、超时）有覆盖？
- [ ] 单测里没有真 spawn 用户 CLI？
- [ ] 测试是否依赖本机已装某个工具（会在他机器上假失败）？

## 7. 文档与发布

- [ ] 两份 README 是否同批更新（不能只改英文）？
- [ ] CHANGELOG `[Unreleased]` 是否记录？
- [ ] `package.json` 改动是否影响 `files` / `bin` / `engines`？
- [ ] 是否声称了尚未发布 / 尚未实现的能力？

## 8. 收尾

- [ ] 审计日志已记录门禁结果？
- [ ] 回滚方案明确（代码回退或 `rollback.sh`）？
- [ ] 若归档：specs 增量已合并、提案已移入 `archive/`、archive 未被修改？
