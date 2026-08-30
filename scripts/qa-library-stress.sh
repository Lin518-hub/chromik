#!/usr/bin/env bash
# QA-06：以真实 Electron 图库加载 1000 帧，验证数据全部到达 UI，
# 但 DOM 仅挂载视口窗口内的卡片/图片，避免大图库一次解码全部缩略图。
set -euo pipefail

OUT="${1:-qa/library-stress}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/chromik-library-stress.XXXXXX")"
trap 'rm -rf "$USER_DATA"' EXIT

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout 90 "$@"; return; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout 90 "$@"; return; fi
  "$@" &
  local child=$!
  ( sleep 90; kill "$child" 2>/dev/null || true ) &
  local watchdog=$!
  local status=0
  wait "$child" || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

echo "[library-stress] 构建…"
npm run build >/dev/null 2>&1

echo "[library-stress] 加载 1000 帧独立图库…"
run_with_timeout env \
  FILMLAB_TEST_USER_DATA="$USER_DATA" \
  FILMLAB_SEED_DEMO=1 \
  FILMLAB_QA_LIBRARY_COUNT=1000 \
  FILMLAB_CAPTURE_VIEW=library \
  FILMLAB_CAPTURE_DELAY_MS=6000 \
  FILMLAB_CAPTURE_PATH="$OUT/library-1000.png" \
  npm start >"$OUT/app.log" 2>&1

node -e '
const fs = require("node:fs");
const log = fs.readFileSync(process.argv[1], "utf8");
const match = /CHROMIK_LIBRARY_DOM (\{[^\n]+\})/.exec(log);
if (!match) throw new Error("缺少 CHROMIK_LIBRARY_DOM 证据");
const result = JSON.parse(match[1]);
const numeric = (value) => Number(value);
const passed = numeric(result.expected) === 1000
  && numeric(result.items) === 1000
  && numeric(result.cards) > 0 && numeric(result.cards) <= 80
  && numeric(result.images) > 0 && numeric(result.images) <= 80
  && numeric(result.rows) > 0 && numeric(result.columns) > 0;
console.log(`  数据=${result.items}/${result.expected} DOM卡片=${result.cards} 图片=${result.images} 网格=${result.rows}×${result.columns}`);
if (!passed) process.exit(1);
if (!/CHROMIK_CAPTURE_STATE .*"matched":true/.test(log)) throw new Error("没有到达图库页面");
if (/Uncaught|TypeError|Cannot read|is not a function|white screen|CHROMIK_CAPTURE_FAILED/i.test(log)) throw new Error("应用日志包含渲染错误");
' "$OUT/app.log"

test -s "$OUT/library-1000.png"
echo "[library-stress] ✓ 1000 帧完整加载，DOM 保持有界：证据 $OUT"
