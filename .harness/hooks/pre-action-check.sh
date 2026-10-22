#!/usr/bin/env bash
# pre-action-check.sh — 工具调用前置拦截
#
# 退出码语义（WorkBuddy / CodeBuddy 钩子规范，与 Claude Code 一致）：
#   0  = 放行
#   2  = **阻断**（stderr 内容回填给模型）
#   其他非零 = 非阻断错误（只提示，仍然放行）—— ⚠️ 所以阻断必须用 2，用 1 等于没拦
#
# 用法：echo '<tool_input JSON>' | bash .harness/hooks/pre-action-check.sh   # 钩子调用
#       bash .harness/hooks/pre-action-check.sh "<拟执行动作>"               # 人肉自测
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RAW="${1:-}"
if [ -z "$RAW" ] && [ ! -t 0 ]; then
  RAW="$(cat)"
fi
if [ -z "$RAW" ]; then
  echo "[pre-action-check] 无输入动作，放行（无操作）"
  exit 0
fi

# 宿主会把整个 tool_input 以 JSON 从 stdin 传入：归一化成「工具 + 目标」一行，
# 否则 JSON 里的引号/换行会让下面的模式匹配失准（也会让 .harness 读取被误判成写入）。
ACTION="$RAW"
case "$(printf '%s' "$RAW" | cut -c1)" in
  '{')
    ACTION="$(printf '%s' "$RAW" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    const ti = j.tool_input || {};
    const tool = j.tool_name || "?";
    const tgt = ti.command || ti.file_path || ti.path || ti.pattern || ti.url || ti.notebook_path || "";
    process.stdout.write((tool === "Bash" ? String(tgt) : `${tool} ${tgt}`).trim());
  } catch {
    process.stdout.write(s.replace(/\s+/g, " ").slice(0, 2000));
  }
});' 2>/dev/null)"
    ;;
esac

block() {
  local reason="$1"
  {
    echo "⛔ [pre-action-check] 已拦截：$reason"
    echo "    动作: $ACTION"
    echo "    处置: 属高风险/禁止项（policy.yaml），须人工审批后由人工执行或显式授权。"
  } >&2
  bash "$ROOT/.harness/hooks/audit-logger.sh" "agent" "pre-action-blocked" "blocked" "$reason" >/dev/null 2>&1 || true
  exit 2
}

warn() {
  echo "⚠️  [pre-action-check] $1（放行，但需在变更方案与审计中写明）" >&2
}

# ---------- 第一红线：.harness 保护（work/ 写入除外） ----------
# 读/执行护栏脚本是合法的（Agent 必须能读规则、能跑 gate）；写/删/移动才是红线。
if echo "$ACTION" | grep -qE '(\.harness[/\\])' && ! echo "$ACTION" | grep -qE '\.harness[/\\]work[/\\]'; then
  exec_ok=0
  echo "$ACTION" | grep -qE '^[[:space:]]*(node|bash|sh|npx|npm|pnpm|cat|less|head|tail|grep|rg|ls|find|Read|Glob|Grep)([[:space:]]|$)' && exec_ok=1
  echo "$ACTION" | grep -qE '^[[:space:]]*git[[:space:]]+(status|diff|log)' && exec_ok=1
  write_hint=0
  echo "$ACTION" | grep -qiE '(edit|write|update|delete|remove|append|touch|sed[[:space:]]+-i)|修改|写入|删除|移动|覆盖|新建|追加' && write_hint=1
  if [ "$exec_ok" -eq 0 ] || [ "$write_hint" -eq 1 ]; then
    block "试图修改/删除 .harness/ 护栏配置（仅人工维护，always-on.md 第一红线）"
  fi
fi

# ---------- 归档只增不改 ----------
if echo "$ACTION" | grep -qE 'openspec/changes/archive/'; then
  if echo "$ACTION" | grep -qiE '(edit|write|rm |del |mv )'; then
    block "试图修改/移动 openspec/changes/archive/（历史留痕只增不改）"
  fi
fi

# ---------- 危险文件系统操作 ----------
if echo "$ACTION" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*[rRfF][a-zA-Z]*[[:space:]])'; then
  block "递归/强制删除（rm -rf 类）"
fi
if echo "$ACTION" | grep -qE '(del[[:space:]]+/[sS][qQ]|Remove-Item[[:space:]].*-Recurse)'; then
  block "Windows 递归删除"
fi

# ---------- git 危险操作 ----------
if echo "$ACTION" | grep -qE 'git[[:space:]]+(push[[:space:]].*--force|reset[[:space:]]+--hard|rebase[[:space:]]+-i|filter-branch)'; then
  block "git 强推/硬重置/改写历史（policy.yaml 高风险）"
fi

# ---------- 发布类外发动作 ----------
if echo "$ACTION" | grep -qE '(npm[[:space:]]+publish|npm[[:space:]]+unpublish|npm[[:space:]]+(i|install)[[:space:]]+-g)'; then
  block "发布到 npm / 全局安装（不可逆外发动作，须人工执行）"
fi
if echo "$ACTION" | grep -qE 'git[[:space:]]+tag'; then
  warn "打 tag 属中风险（写远端前的最后一步），须与 package.json 版本一致"
fi

# ---------- 明文凭据 ----------
if echo "$ACTION" | grep -qE '\b(sk|rk|xai|gsk|ghp|gho|AKIA)[-_][A-Za-z0-9_-]{12,}'; then
  block "疑似真实 API Key 出现在写入/命令中（测试请用 tok_smoke 这类伪值）"
fi
if echo "$ACTION" | grep -qE 'device_token[[:space:]]*[:=][[:space:]]*["'"'"'][a-zA-Z0-9_-]{12,}'; then
  block "疑似明文 device_token 写入（只允许 tokenTail() 输出尾号）"
fi

# ---------- 凭据文件读取 ----------
if echo "$ACTION" | grep -qE '(readFileSync|readFile|cat|Get-Content|createReadStream).*(\.credentials\.json|auth\.json|\.codex/|\.claude/|\.gemini/|oauth_creds)' ; then
  block "试图读取凭据文件内容（只允许 existsSync 判存在，security-rules.md）"
fi

# ---------- shell 字符串拼接（平台参数注入面） ----------
# exec/execSync 一律禁止：它们接受整条 shell 字符串（误用 Regex.exec 不算，故不匹配裸 .exec(）
if echo "$ACTION" | grep -qE '(execSync\(|child_process[^|;]*exec\(|from[[:space:]]+['"'"']node:child_process['"'"'][^|;]*\bexec\b)'; then
  block "出现 exec/execSync：平台参数会被拼成 shell 字符串，必须用 spawn + 参数数组（引号规则只在 win-exec.ts）"
fi
if echo "$ACTION" | grep -qE 'shell:[[:space:]]*true'; then
  # 已知合法位置：runner.ts（Windows 垫片分支）、agent-adapters.ts（版本探测）
  if ! echo "$ACTION" | grep -qE '(runner\.ts|agent-adapters\.ts)'; then
    block "新增 shell:true（只允许 runner.ts 与 agent-adapters.ts 两处，且一律经 win-exec.ts）"
  else
    warn "shell:true 属已知例外位置，改动须保持 win-exec.ts 的引号规则"
  fi
fi

# ---------- 非回环监听 ----------
if echo "$ACTION" | grep -qE '(listen\([^)]*0\.0\.0\.0|listen\([^)]*::|host:[[:space:]]*["'"'"']0\.0\.0\.0)'; then
  block "试图绑定非回环地址（只允许 127.0.0.1 授权回调）"
fi

# ---------- 协议契约 ----------
if echo "$ACTION" | grep -qE 'src[/\\]protocol\.ts' && echo "$ACTION" | grep -qiE '(write|edit|delete)'; then
  if [ -d "$ROOT/openspec/changes" ] && [ -n "$(find "$ROOT/openspec/changes" -maxdepth 1 -mindepth 1 -type d ! -name archive 2>/dev/null)" ]; then
    warn "改动 protocol.ts 存在活跃提案——确认提案已获批、README 协议表同步、PROTOCOL_VERSION 已评估"
  else
    block "改动 src/protocol.ts 但没有活跃 OpenSpec 提案（第三方平台按此契约实现，必须先提案）"
  fi
fi

echo "✅ [pre-action-check] 放行（未命中禁止项；后续由 post-change-gate.sh 门禁兜底）"
exit 0
