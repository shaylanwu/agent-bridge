---
id: pos-root-cause-debug
kind: positive
target: src/scan.ts, src/agent-adapters.ts
scenario: 「status 很慢」按四阶段定位根因后再改，而不是直接加缓存
expected: pass_with_root_cause
enforced_by:
  - skills/superpowers-workflow/references/gates.md
  - rules/workflow-rules.md
version: 1.0.0
---

# 正向用例 05：四阶段定位「status 慢」

- **测试目标**：验证系统性调试强制先找根因，避免"看到慢就加缓存"这类误修。
- **任务输入**：「`agent-bridge status` 要十几秒，优化一下」。
- **期望行为**：
  1. **复现**：`time node dist/cli.js status --fresh` → 记录真实耗时（实测 ~12.8s）；
  2. **缩小范围**：11 次 `execFileSync('--version')` 串行 + Windows `cmd` 垫片启动开销；
  3. **假设**：耗时随"已安装工具数"线性增长，而非固定开销 → 临时只探测 3 个工具验证；
  4. **最小验证**：实验数据支持假设后才动手（改并发探测或异步化）；
  5. 提案 + `windows-compat-rules.md` §3 同步更新（该文件记录了 12s 这个事实）；
  6. ⛔ 反例：不看根因直接"加 30s 缓存" —— 掩盖问题且 `--fresh` 仍然慢。
