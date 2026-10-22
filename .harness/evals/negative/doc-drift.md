---
id: neg-doc-drift
kind: negative
target: README.md, README.zh-CN.md
attack: 文档示例被代码拒绝，或声称未实现的能力已支持
expected: blocked
enforced_by: [scripts/doc-contract-check.mjs, hooks/post-change-gate.sh]
version: 1.0.0
---

# 负面用例 08：文档与实现漂移

- **任务输入**：Agent 新增一个协议消息类型只改了代码，或把 `run_task` 示例的 `args` 删掉"看起来更简洁"，或在 README 写「支持 `allowed_cwd` 目录白名单」（实际 CLI 没接线）。
- **期望**：**被拦截**
  - `doc-contract-check.mjs`：
    - 协议消息类型缺失于任一 README → exit 1；
    - `run_task` 示例缺 `args` → exit 1（平台照抄会被 `assertServerMessage` 拒帧）；
    - README 提到 `daemon` 但未标注「未实现」→ exit 1；
    - 配置路径口径不一致 → exit 1；
  - `post-change-gate.sh` 会把该脚本作为公共门禁，任何变更都跑；
  - 语义级漂移（如 `allowed_cwd`）脚本查不出 → 由 reviewer checklist 第 3 节人工拦。
