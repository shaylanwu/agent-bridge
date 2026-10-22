#!/usr/bin/env bash
# rollback.sh — 变更回退（默认 dry-run；CONFIRM=1 才真正执行）
# 用法:
#   bash .harness/scripts/rollback.sh --files src/cli.ts src/runner.ts   # 回退指定文件到 HEAD
#   bash .harness/scripts/rollback.sh --dist                             # 只删构建产物后重编
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CONFIRM="${CONFIRM:-0}"

if [ $# -eq 0 ]; then
  echo "用法: bash .harness/scripts/rollback.sh --files <文件...> | --dist"
  echo "默认 dry-run；CONFIRM=1 执行。"
  exit 2
fi

MODE="$1"; shift

case "$MODE" in
  --dist)
    echo "[rollback] 目标：清除 dist/ 并重新构建（不触碰源码）"
    if [ "$CONFIRM" != "1" ]; then
      echo "  (dry-run) 将执行：rm -rf dist && npm run build"
      echo "  确认执行：CONFIRM=1 bash .harness/scripts/rollback.sh --dist"
      exit 0
    fi
    rm -rf dist && npm run build || { echo "⛔ 重建失败"; exit 1; }
    bash .harness/hooks/audit-logger.sh "human" "rollback-dist" "done" "dist rebuilt" >/dev/null 2>&1 || true
    echo "✅ dist 已重建"
    ;;

  --files)
    [ $# -gt 0 ] || { echo "⛔ --files 需要至少一个文件"; exit 2; }
    echo "[rollback] 目标文件（对照 HEAD）："
    for f in "$@"; do
      [ -f "$f" ] || { echo "  ❌ 不存在：$f"; exit 1; }
      echo "  - $f"
    done
    # 先备份，再回退；备份目录在 .harness/work/（gitignore）
    BAK=".harness/work/rollback-$(date +%Y%m%d-%H%M%S)"
    echo "[rollback] 备份到 ${BAK}/"
    if [ "$CONFIRM" != "1" ]; then
      echo "  (dry-run) 将执行：备份 → git checkout -- <files>"
      echo "  确认执行：CONFIRM=1 bash .harness/scripts/rollback.sh --files $*"
      exit 0
    fi
    mkdir -p "$BAK"
    for f in "$@"; do
      mkdir -p "$BAK/$(dirname "$f")"
      cp "$f" "$BAK/$f"
    done
    git checkout -- "$@" || { echo "⛔ git checkout 失败"; exit 1; }
    bash .harness/hooks/audit-logger.sh "human" "rollback-files" "done" "files=$#, backup=${BAK}" >/dev/null 2>&1 || true
    echo "✅ 已回退到 HEAD（备份保留在 ${BAK}/）"
    echo "提醒：回退后必须重跑 bash .harness/hooks/post-change-gate.sh"
    ;;

  *)
    echo "⛔ 未知模式：$MODE（支持 --files / --dist）"
    exit 2
    ;;
esac
