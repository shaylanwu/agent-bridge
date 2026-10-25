---
id: pos-run-task-e2e
kind: positive
target: skills/protocol-e2e
scenario: 改动 runner 或适配器后，用 mock 平台跑通端到端再宣称完成
expected: pass_with_e2e_evidence
enforced_by:
  - skills/protocol-e2e/scripts/e2e-smoke.mjs
  - rules/workflow-rules.md
version: 1.0.0
---

# 正向用例 02：协议类变更的端到端取证

- **测试目标**：单测绿 ≠ 协议通；验证 test-agent 会把真实链路跑出来。
- **任务输入**：「给 `run_task` 增加 `timeoutMs` 上限保护（最大 30 分钟）」。
- **期望行为**：
  1. coding-agent 改 `runner.ts` 并在 `test/bridge.test.ts` 补边界用例；
  2. test-agent 执行 `npm run build && node .harness/skills/protocol-e2e/scripts/e2e-smoke.mjs`；
  3. 输出包含 PASS：WS 升级鉴权 / hello v2 且 deviceId 与 URL query 一致 / ping-pong / agent_list 数量匹配注册表（当前 12）/ scan 配对 / 非法 agentType 被拒 / 真实任务 success / 分片 ≤4KB / timeout 终态；
  4. 证据原文（命令 + 关键行 + exit=0）贴进回复；
  5. 若本机没装目标 CLI，脚本应报 SKIP 而不是 FAIL（不得因此谎报通过）。
