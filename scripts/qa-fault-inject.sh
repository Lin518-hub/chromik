#!/usr/bin/env bash
# QA-06 故障注入验收（开发代理缓存）：在独立 userData 中播种示例图库，
# 对开发代理（CHPX）注入截断 / 位翻转 / 头部损坏 / 垃圾文件 / 外部删除，
# 验证"校验失败 → 移除残骸 → 按需重建"自愈闭环与 cache_state 审计记录。
# 用法：scripts/qa-fault-inject.sh [报告输出路径，默认 qa/fault-inject/report.json]
# 退出码：0 = 全部场景通过；1 = 任一场景失败。
set -euo pipefail

REPORT="${1:-qa/fault-inject/report.json}"
OUT_DIR="$(dirname "$REPORT")"
USER_DATA="$(mktemp -d /tmp/chromik-fault-inject.XXXXXX)"
trap 'rm -rf "$USER_DATA"' EXIT
mkdir -p "$OUT_DIR"

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 180 "$@"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 180 "$@"
    return
  fi
  # macOS 没有 GNU timeout：用看门狗保持同样的有界行为。
  "$@" &
  local child=$!
  ( sleep 180; kill "$child" 2>/dev/null || true ) &
  local watchdog=$!
  wait "$child"; local status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

echo "[fault-inject] 构建…"
npm run build >/dev/null 2>&1

echo "[fault-inject] 启动应用并注入故障（独立 userData=${USER_DATA}）…"
set +e
run_with_timeout env \
  FILMLAB_TEST_USER_DATA="$USER_DATA" \
  FILMLAB_SEED_DEMO=1 \
  FILMLAB_QA_LIBRARY_COUNT=1 \
  FILMLAB_QA_FAULT_INJECT=1 \
  FILMLAB_QA_FAULT_REPORT="$REPORT" \
  npm start >"$OUT_DIR/app.log" 2>&1
APP_STATUS=$?
set -e

if [ ! -s "$REPORT" ]; then
  echo "✗ 报告缺失：${REPORT}（应用日志见 ${OUT_DIR}/app.log）"
  tail -40 "$OUT_DIR/app.log" || true
  exit 1
fi

if [ "$APP_STATUS" -ne 0 ]; then
  echo "✗ 应用退出码非零：$APP_STATUS（自愈场景失败会让 harness 以 1 退出）"
fi

node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const steps = report.steps || [];
const failed = steps.filter((step) => !step.ok);
const badProtocol = (report.protocol || []).filter((check) => check.status !== 200 || check.bytes <= 0);
const damaged = (report.cacheStates || []).filter((state) => state.status === "damaged");
const rebuilt = (report.cacheStates || []).filter((state) => state.rebuildCount > 0);
console.log(`  主体=${report.subjects} 注入场景=${report.injections} 协议检查=${report.protocolChecks} 通过=${report.passed ? "是" : "否"}`);
console.log(`  重建过的缓存=${rebuilt.length} 残留 damaged=${damaged.length} 耗时=${report.durationMs}ms`);
for (const step of failed) console.log(`  ✗ ${step.subjectId} ${step.kind}${step.reason ? `：${step.reason}` : ""}`);
for (const check of badProtocol) console.log(`  ✗ 协议 ${check.subjectId}：status=${check.status} bytes=${check.bytes}`);
for (const state of damaged) console.log(`  ✗ 簿记残留 damaged：${state.path}`);
process.exit(report.passed ? 0 : 1);
' "$REPORT"
NODE_STATUS=$?

if [ "$NODE_STATUS" -ne 0 ] || [ "$APP_STATUS" -ne 0 ]; then
  echo "[fault-inject] ✗ 未通过（日志见 $OUT_DIR/app.log）"
  exit 1
fi
echo "[fault-inject] ✓ 全部自愈场景通过：报告 $REPORT"
