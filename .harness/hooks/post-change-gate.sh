#!/usr/bin/env bash
# post-change-gate.sh — 变更后质量门禁（契约边界 / 文档同步 / 类型 / 单测 / 构建 / 提案）
# 用法: bash .harness/hooks/post-change-gate.sh [变更文件...]   （无参数时用 git status 检测）
#
# 退出码：0 = 通过；2 = **阻断**（Stop 钩子的阻断语义；其他非零码在宿主里只是提示，等于没拦）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p .harness/work
LOG=".harness/work/gate-out.log"

FAILED=()
pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED+=("$1"); }
run() { # run <描述> <命令...>
  local desc="$1"; shift
  echo "  ▶ $desc"
  if "$@" >"$LOG" 2>&1; then
    pass "$desc"
  else
    fail "$desc"
    echo "----- 失败输出（尾 25 行）-----"
    tail -25 "$LOG"
    echo "------------------------------"
  fi
}

# ---------- 1. 收集变更文件 ----------
declare -a FILES=()
if [ $# -gt 0 ]; then
  FILES=("$@")
else
  while IFS= read -r line; do
    [ -n "$line" ] && FILES+=("$line")
  done < <(git status --porcelain 2>/dev/null | sed -e 's/^...//' -e 's/.* -> //')
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "[gate] 无变更文件；执行全量门禁（安全默认）"
else
  echo "[gate] 检测到 ${#FILES[@]} 个变更文件"
fi

MATCH() {
  local pat="$1" f
  for f in "${FILES[@]}"; do
    case "$f" in
      $pat) return 0 ;;
    esac
  done
  return 1
}

touch_src=false
[ ${#FILES[@]} -eq 0 ] && touch_src=true
MATCH "src/*" && touch_src=true
MATCH "test/*" && touch_src=true
MATCH "tsconfig.json" && touch_src=true

# ---------- 2. 公共门禁（永远跑） ----------
echo "== 公共门禁 =="
run "协议边界校验 (protocol-boundary-check)" node .harness/scripts/protocol-boundary-check.mjs
run "文档-实现一致性 (doc-contract-check)" node .harness/scripts/doc-contract-check.mjs

# ---------- 3. 源码门禁 ----------
if [ "$touch_src" = true ]; then
  echo "== 源码门禁 =="
  run "类型检查 (tsc --noEmit)" npm run typecheck
  run "单元测试 (vitest)" npm test
  run "构建 (tsc → dist/)" npm run build
else
  echo "== 源码门禁：跳过（未触及 src/test） =="
fi

# ---------- 4. 协议契约门禁（高风险） ----------
if MATCH "src/protocol.ts"; then
  echo "== 协议契约门禁（高风险） =="
  active="$(find openspec/changes -maxdepth 1 -mindepth 1 -type d ! -name archive 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${active:-0}" -gt 0 ]; then
    pass "protocol.ts 变更存在活跃提案（${active} 个）"
    run "提案格式校验" bash .harness/skills/openspec-workflow/scripts/validate-change.sh
    echo "  ⚠️  protocol.ts 属 wire 契约：请确认 PROTOCOL_VERSION 已评估 + 两份 README 协议表已同步 + 人工审批"
  else
    fail "protocol.ts 变更但没有活跃 OpenSpec 提案（第三方平台按此契约实现）"
  fi
fi

# ---------- 4.5 契约门禁（AsyncAPI / OpenAPI 与代码零漂移） ----------
if MATCH "src/protocol.ts" || MATCH "src/core/errors.ts" || MATCH "contracts/*" || MATCH "scripts/gen-contracts.mjs"; then
  echo "== 契约门禁 =="
  run "契约-代码一致性 (contracts:check)" npm run contracts:check
fi

# ---------- 5. OpenSpec 提案门禁 ----------
if MATCH "openspec/changes/*"; then
  echo "== OpenSpec 提案门禁 =="
  run "活跃提案格式校验" bash .harness/skills/openspec-workflow/scripts/validate-change.sh
  arch_bad="$(git status --porcelain -- openspec/changes/archive 2>/dev/null | grep -E '^.[MD]|^[MD].')"
  if [ -n "$arch_bad" ]; then
    fail "openspec/changes/archive 只增不改，检出修改/删除：$arch_bad"
  else
    pass "归档目录未被修改/删除"
  fi
fi

# ---------- 6. 发布包门禁 ----------
if MATCH "package.json"; then
  echo "== 发布包门禁 =="
  node -e '
    const p = require("./package.json");
    const fail = [];
    if (!Array.isArray(p.files) || !p.files.includes("dist")) fail.push("files 缺 dist");
    if (!p.bin || !String(p.bin["agent-bridge"] ?? "").startsWith("dist/")) fail.push("bin 未指向 dist/");
    if (!p.engines || !p.engines.node) fail.push("engines.node 缺失");
    if (fail.length) { console.error(fail.join("; ")); process.exit(1); }
  ' && pass "package.json 发布字段完整（files/bin/engines）" || fail "package.json 发布字段不完整（见日志）"
  if [ -f dist/cli.js ]; then
    head -n1 dist/cli.js | grep -q "#!/usr/bin/env node" && pass "dist/cli.js 带 node shebang" || fail "dist/cli.js 缺 shebang（npm i -g 后无法执行）"
  fi
fi

# ---------- 7. 汇总 ----------
echo ""
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "⛔ [gate] 门禁未通过（${#FAILED[@]} 项失败）："
  for f in "${FAILED[@]}"; do echo "   - $f"; done
  bash .harness/hooks/audit-logger.sh "agent" "post-change-gate" "failed" "failures=${#FAILED[@]}" >/dev/null 2>&1 || true
  exit 2
fi

echo "✅ [gate] 门禁全部通过"
bash .harness/hooks/audit-logger.sh "agent" "post-change-gate" "passed" "files=${#FILES[@]}" >/dev/null 2>&1 || true
exit 0
