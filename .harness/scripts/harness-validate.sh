#!/usr/bin/env bash
# harness-validate.sh — 校验 .harness 自身完整性（CI 与 npm run harness:validate 调用）
# 任一检查失败 → 退出码非 0
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAILED=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; FAILED=1; }
need() { [ -e "$1" ] && ok "存在 $1" || bad "缺失 $1"; }
has_frontmatter() {
  [ "$(head -n 1 "$1" 2>/dev/null)" = "---" ] && grep -qE "^(name|id):" "$1"
}

echo "== 1. 技能（一技能一目录 + SKILL.md frontmatter） =="
for s in openspec-workflow superpowers-workflow protocol-e2e release-publish; do
  f=".harness/skills/$s/SKILL.md"
  need "$f"
  if [ -f "$f" ]; then
    if has_frontmatter "$f"; then
      ok "SKILL.md frontmatter：$s"
      grep -q "^name: $s$" "$f" && ok "frontmatter name 与目录名一致：$s" || bad "frontmatter name 必须为 '$s'：$f"
    else
      bad "SKILL.md 缺 frontmatter（name/description）：$f"
    fi
  fi
done
need .harness/skills/openspec-workflow/scripts/validate-change.sh
need .harness/skills/openspec-workflow/references/change-lifecycle.md
need .harness/skills/openspec-workflow/references/spec-format.md
need .harness/skills/superpowers-workflow/references/gates.md
need .harness/skills/README.md

echo "== 2. Agent 角色（一角色一目录 + AGENT.md frontmatter） =="
for a in owner-agent coding-agent test-agent reviewer-agent; do
  f=".harness/agents/$a/AGENT.md"
  need "$f"
  [ -f "$f" ] && { has_frontmatter "$f" && ok "AGENT.md frontmatter：$a" || bad "AGENT.md 缺 frontmatter：$f"; }
done
need .harness/agents/reviewer-agent/checklists/review-checklist.md

echo "== 3. 规则（frontmatter + 第一红线） =="
for r in always-on protocol-contract-rules security-rules windows-compat-rules doc-impl-sync-rules code-style release-rules workflow-rules; do
  f=".harness/rules/$r.md"
  need "$f"
  [ -f "$f" ] && { has_frontmatter "$f" && ok "规则 frontmatter：$r" || bad "规则缺 frontmatter：$f"; }
done
grep -q "修改" .harness/rules/always-on.md && grep -q "\.harness" .harness/rules/always-on.md \
  && ok "always-on.md 含第一红线（禁改 .harness）" || bad "always-on.md 第一红线缺失"
grep -q "protocol.ts" .harness/rules/always-on.md && ok "always-on.md 含协议契约红线" || bad "always-on.md 缺协议契约红线"

echo "== 4. hooks 与策略 =="
for f in .harness/hooks/pre-action-check.sh .harness/hooks/post-change-gate.sh \
         .harness/hooks/audit-logger.sh .harness/contracts/policy.yaml \
         .harness/scripts/doc-contract-check.mjs .harness/scripts/protocol-boundary-check.mjs \
         .harness/scripts/rollback.sh .harness/scripts/harness-validate.sh \
         .harness/evals/positive .harness/evals/negative; do
  need "$f"
done
node -e "JSON.parse(require('fs').readFileSync('.harness/hooks/hooks.json','utf8'))" \
  && ok "hooks.json 可解析" || bad "hooks.json 非法 JSON"
grep -q "PreToolUse" .harness/hooks/hooks.json && grep -q "post-change-gate" .harness/hooks/hooks.json \
  && ok "hooks.json 映射 PreToolUse / post-change-gate" || bad "hooks.json 缺关键事件映射"

echo "== 5. 脚本语法 =="
for s in .harness/hooks/pre-action-check.sh .harness/hooks/post-change-gate.sh \
         .harness/hooks/audit-logger.sh .harness/scripts/rollback.sh \
         .harness/skills/openspec-workflow/scripts/validate-change.sh; do
  bash -n "$s" && ok "$(basename "$s") 语法" || bad "$(basename "$s") 语法错误"
done
for j in .harness/scripts/doc-contract-check.mjs .harness/scripts/protocol-boundary-check.mjs; do
  node --check "$j" && ok "$(basename "$j") 语法" || bad "$(basename "$j") 语法错误"
done

echo "== 6. 关键约束在位 =="
grep -q "\.harness" .gitignore && grep -q "work" .gitignore \
  && ok ".gitignore 含 .harness/work/" || bad ".gitignore 缺少 .harness/work/"
grep -q "human_approval" .harness/contracts/policy.yaml \
  && ok "policy.yaml 含高风险人工审批" || bad "policy.yaml 缺 human_approval"
grep -qE "max_iteration_rounds" .harness/contracts/policy.yaml \
  && ok "policy.yaml 含迭代上限" || bad "policy.yaml 缺迭代上限"
grep -q "protocol.ts" .harness/hooks/post-change-gate.sh \
  && ok "门禁含协议契约检查" || bad "门禁缺协议契约检查"
grep -q "doc-contract-check" .harness/hooks/post-change-gate.sh \
  && ok "门禁含文档一致性检查" || bad "门禁缺文档一致性检查"

echo "== 7. OpenSpec 任务流程（openspec/ 骨架 + 校验脚本） =="
for f in openspec/AGENTS.md openspec/project.md openspec/changes/README.md openspec/changes/archive; do
  need "$f"
done
grep -q "^### Requirement:" openspec/specs/bridge-protocol/spec.md 2>/dev/null \
  && grep -q "^#### Scenario:" openspec/specs/bridge-protocol/spec.md 2>/dev/null \
  && ok "seed 规格（bridge-protocol）含 Requirement/Scenario" || bad "seed 规格格式不完整"
bash .harness/skills/openspec-workflow/scripts/validate-change.sh >/dev/null 2>&1 \
  && ok "活跃提案校验实跑通过（或无活跃提案）" || bad "活跃提案存在格式违规"

echo "== 8. 校验脚本实跑 =="
node .harness/scripts/protocol-boundary-check.mjs >/dev/null 2>&1 && ok "protocol-boundary-check 通过" || bad "protocol-boundary-check 未通过"
node .harness/scripts/doc-contract-check.mjs >/dev/null 2>&1 && ok "doc-contract-check 通过" || bad "doc-contract-check 未通过"

echo "== 9. 评测用例覆盖 =="
pos=$(ls .harness/evals/positive 2>/dev/null | wc -l | tr -d ' ')
neg=$(ls .harness/evals/negative 2>/dev/null | wc -l | tr -d ' ')
[ "${pos:-0}" -ge 4 ] && ok "正向用例 ${pos} 条（≥4）" || bad "正向用例不足（${pos}）"
[ "${neg:-0}" -ge 6 ] && ok "负面用例 ${neg} 条（≥6）" || bad "负面用例不足（${neg}）"
fm_fail=0
for f in .harness/evals/positive/*.md .harness/evals/negative/*.md; do
  has_frontmatter "$f" || { bad "eval 缺 frontmatter：$f"; fm_fail=1; }
done
[ "$fm_fail" -eq 0 ] && ok "全部 eval 带 frontmatter（kind/expected/enforced_by）"

echo "== 10. 根入口与脚本 =="
need AGENTS.md
node -e '
  const s = require("./package.json").scripts || {};
  const need = ["gate","harness:validate","arch:check","openspec:validate"];
  const miss = need.filter((k) => !s[k]);
  if (miss.length) { console.error("缺少脚本: " + miss.join(", ")); process.exit(1); }
' && ok "package.json 提供 gate / harness:validate / arch:check / openspec:validate" \
  || bad "package.json 缺少护栏快捷命令"

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "⛔ harness-validate 未通过"
  exit 1
fi
echo "✅ harness-validate 全部通过"
