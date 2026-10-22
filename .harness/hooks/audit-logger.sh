#!/usr/bin/env bash
# audit-logger.sh — 全链路审计（JSONL 追加到 .harness/work/audit-<date>.jsonl）
# 用法: bash .harness/hooks/audit-logger.sh <actor> <action> <result> [detail]
# 注意: detail 为单行纯文本，不得含 token / 密钥
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$ROOT/.harness/work"
mkdir -p "$WORK_DIR"

actor="${1:-unknown}"
action="${2:-unknown}"
result="${3:-unknown}"
detail="${4:-}"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
file="$WORK_DIR/audit-$(date +%F).jsonl"

printf '{"ts":"%s","actor":"%s","action":"%s","result":"%s","detail":"%s"}\n' \
  "$ts" "$actor" "$action" "$result" "$detail" >> "$file"

echo "[audit] $ts $actor $action -> $result ($detail)"
