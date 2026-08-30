#!/usr/bin/env bash
# P2 字体子集化：把 6 个全量 HarmonyOS Sans SC TTF（约 47 MB）子集化为
# “界面文案实际使用的字符 + ASCII + 常用标点”，用户自由文本缺字回退系统字体。
# 用法：scripts/subset-fonts.sh [venv python，默认 .qa-venv/bin/python]
# 产物：src/renderer/assets/fonts/*.ttf 原地替换（提交前人工检查 git diff 体积）。
set -euo pipefail

PYTHON="${1:-.qa-venv/bin/python}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FONT_DIR="$SRC_DIR/src/renderer/assets/fonts"
TEXT_FILE="$(mktemp /tmp/chromik-font-glyphs.XXXXXX)"
trap 'rm -f "$TEXT_FILE"' EXIT

echo "[subset-fonts] 收集界面文案字符…"
# 界面文案全部在源码中：TS/TSX/CSS/HTML/JSON + 发布文档标题字符。
find "$SRC_DIR/src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' -o -name '*.json' \) -print0 \
  | xargs -0 cat > "$TEXT_FILE"
# ASCII 可打印 + 常用中文标点 + UI 图标字符 + 拉丁扩展基本区。
printf '!\"#$%%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~¥€£·—–…‘’“”〈〉《》【】、。，；：？！（）％×÷℃°·‧–≈≠≤≥±©®™✓✗↗→↑↓★☆▸◂▾◦•…' >> "$TEXT_FILE"

echo "[subset-fonts] 逐字重子集化（TTF → WOFF2）…"
for FONT in "$FONT_DIR"/*.ttf; do
  NAME="$(basename "$FONT")"
  OUTPUT="${FONT%.ttf}.woff2"
  TEMP="$(mktemp "${TMPDIR:-/tmp}/chromik-font.XXXXXX")"
  "$PYTHON" -m fontTools.subset "$FONT" \
    --text-file="$TEXT_FILE" \
    --layout-features='*' \
    --flavor=woff2 \
    --output-file="$TEMP"
  SIZE_BEFORE="$(wc -c < "$FONT" | tr -d ' ')"
  SIZE_AFTER="$(wc -c < "$TEMP" | tr -d ' ')"
  echo "  ${NAME}：$((SIZE_BEFORE / 1024)) KB → $((SIZE_AFTER / 1024)) KB"
  mv "$TEMP" "$OUTPUT"
  rm "$FONT"
done
echo "[subset-fonts] 完成。请运行 npm run build 确认体积并目检界面字体。"
