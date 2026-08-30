#!/usr/bin/env bash
# QA-02 / 冒烟验收：以开发模式启动 Chromik，走通主闭环并截图，检查渲染进程报错。
# 用法：scripts/qa-smoke.sh [输出目录，默认 qa/smoke]
# 退出码：0 = 通过；1 = 任一检查失败。
set -euo pipefail

OUT="${1:-qa/smoke}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
QA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chromik-smoke.XXXXXX")"
trap 'rm -rf "$QA_ROOT"' EXIT

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 45 "$@"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 45 "$@"
    return
  fi
  # macOS does not ship GNU timeout. Keep the same bounded behavior with a
  # background watchdog so a failed Electron launch cannot stall CI forever.
  "$@" &
  local child=$!
  ( sleep 45; kill "$child" 2>/dev/null || true ) &
  local watchdog=$!
  local status=0
  wait "$child" || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

echo "[smoke] 构建…"
npm run build >/dev/null 2>&1

echo "[smoke] 启动应用（示例胶卷 + 各视图截图）…"
# 冒烟序列：图库 → 校准 → 分帧 → 调整 → 导出 → 设置，每步截图
VIEWS="library calibrate segment develop export settings"
FAILED=0
for view in $VIEWS; do
  rm -f "$OUT/smoke-$view.png" "$OUT/app-$view.log"
  if ! run_with_timeout env \
    FILMLAB_TEST_USER_DATA="$QA_ROOT/$view" \
    FILMLAB_SEED_DEMO=1 \
    FILMLAB_CAPTURE_VIEW="$view" \
    FILMLAB_CAPTURE_PATH="$OUT/smoke-$view.png" \
    npm start >"$OUT/app-$view.log" 2>&1; then
    echo "  ✗ ${view}：应用超时或以失败状态退出"
    FAILED=1
  fi
done

echo "[smoke] 检查渲染进程错误…"
for view in $VIEWS; do
  if grep -qiE "Uncaught|TypeError|Cannot read|is not a function|white screen|CHROMIK_CAPTURE_FAILED" "$OUT/app-$view.log"; then
    echo "  ✗ ${view}：渲染错误见 $OUT/app-$view.log"
    FAILED=1
  elif ! grep -q 'CHROMIK_CAPTURE_STATE.*"matched":true' "$OUT/app-$view.log"; then
    echo "  ✗ ${view}：没有到达目标页面"
    FAILED=1
  else
    echo "  ✓ $view"
  fi
done

UNIQUE_SCREENSHOTS="$(SMOKE_OUT="$OUT" node -e "const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'); const views=['library','calibrate','segment','develop','export','settings']; console.log(new Set(views.map(v=>p.join(process.env.SMOKE_OUT, 'smoke-'+v+'.png')).filter(f=>fs.existsSync(f)).map(f=>c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))).size)")"
if [ "$UNIQUE_SCREENSHOTS" != "6" ]; then
  echo "  ✗ 6 个目标页面只有 $UNIQUE_SCREENSHOTS 个不同截图，疑似导航假阳性"
  FAILED=1
fi

echo "[smoke] 检查截图产出…"
for view in $VIEWS; do
  if [ ! -s "$OUT/smoke-$view.png" ]; then
    echo "  ✗ $view 截图缺失"
    FAILED=1
  fi
done

if [ "$FAILED" = "1" ]; then
  echo "[smoke] 失败：请人工查看日志与截图。"
  exit 1
fi
echo "[smoke] 通过：6 视图截图与日志见 $OUT"
