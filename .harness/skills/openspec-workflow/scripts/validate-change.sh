#!/usr/bin/env bash
# validate-change.sh — 校验 OpenSpec 提案格式（post-change-gate.sh 自动调用）
# 用法: bash .harness/skills/openspec-workflow/scripts/validate-change.sh [change-id]
#       缺省校验 openspec/changes/ 下全部活跃提案；退出码非 0 = 存在格式违规
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHANGES_DIR="$ROOT/openspec/changes"

fail_count=0
fail() { echo "  ❌ $1"; fail_count=$((fail_count + 1)); }
ok()   { echo "  ✅ $1"; }

check_change() {
  local dir="$1" id
  id="$(basename "$dir")"
  echo "— 提案 $id —"

  # 1. proposal.md：三章节
  if [ ! -f "$dir/proposal.md" ]; then
    fail "[$id] 缺 proposal.md"
  else
    grep -q "^## Why" "$dir/proposal.md" || fail "[$id] proposal.md 缺 '## Why'"
    grep -q "^## What Changes" "$dir/proposal.md" || fail "[$id] proposal.md 缺 '## What Changes'"
    grep -q "^## Impact" "$dir/proposal.md" || fail "[$id] proposal.md 缺 '## Impact'"
  fi

  # 2. tasks.md：勾选项 + 归档组
  if [ ! -f "$dir/tasks.md" ]; then
    fail "[$id] 缺 tasks.md（实施留痕主线索）"
  else
    grep -qE '^\s*- \[[ x]\]' "$dir/tasks.md" || fail "[$id] tasks.md 没有任何勾选项"
    grep -qi "归档" "$dir/tasks.md" || fail "[$id] tasks.md 缺'归档'组"
    grep -qE '^\s*- \[[x]\]' "$dir/tasks.md" || echo "  ℹ️  [$id] 尚无已完成项（正常：待评审/刚获批）"
    # 编号规范：每项以 N.N 开头
    bad_num=$(grep -E '^\s*- \[[ x]\] ' "$dir/tasks.md" | grep -vE '^\s*- \[[ x]\] [0-9]+\.[0-9]+' | wc -l | tr -d ' ')
    [ "${bad_num:-0}" -eq 0 ] || fail "[$id] tasks.md 有 ${bad_num} 项缺编号（应为 1.1 / 1.2…）"
  fi

  # 3. spec 增量
  if [ -d "$dir/specs" ]; then
    while IFS= read -r delta; do
      grep -qE "^## (ADDED|MODIFIED|REMOVED) Requirements" "$delta" \
        || fail "[$id] ${delta#"$dir/"} 缺规范操作头（## ADDED/MODIFIED/REMOVED Requirements）"
      grep -q "^### Requirement:" "$delta" \
        || fail "[$id] ${delta#"$dir/"} 缺 '### Requirement:'"
      if grep -q "^### Requirement:" "$delta" && ! grep -q "^#### Scenario:" "$delta"; then
        fail "[$id] ${delta#"$dir/"} 的 Requirement 缺 Scenario"
      fi
    done < <(find "$dir/specs" -name "spec.md" -type f 2>/dev/null)
  else
    echo "  ℹ️  [$id] 无 specs/ 增量（纯 bug 修复可接受）"
  fi

  # 4. 活跃提案内不应有归档痕迹
  [ -d "$dir/archive" ] && fail "[$id] 活跃提案内不应有 archive/ 子目录"
  return 0
}

declare -a TARGETS=()
if [ $# -gt 0 ]; then
  for id in "$@"; do
    [ -d "$CHANGES_DIR/$id" ] || { echo "⛔ 提案不存在: $id"; exit 1; }
    TARGETS+=("$CHANGES_DIR/$id")
  done
else
  while IFS= read -r d; do
    TARGETS+=("$d")
  done < <(find "$CHANGES_DIR" -maxdepth 1 -mindepth 1 -type d ! -name archive 2>/dev/null)
fi

echo "[openspec] 活跃提案数：${#TARGETS[@]}"
if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "✅ 无活跃变更提案（格式校验无事可做）"
  exit 0
fi

for d in "${TARGETS[@]}"; do check_change "$d"; done

echo ""
if [ "$fail_count" -gt 0 ]; then
  echo "⛔ [openspec] 校验未通过（${fail_count} 处违规）——修复后重跑，禁止进入评审/实施"
  exit 1
fi
echo "✅ [openspec] 全部活跃提案格式合法"
