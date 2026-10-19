#!/bin/sh
# 构建可分发目录 dist-js/ (UPX 友好方案):
#   运行时外置 + 单文件 JS bundle + 最小 node_modules + 薄壳启动器
# 产物 ~67MB, UPX 只压独立 bun 运行时 (无 trailer, 压完仍可用)。
# 注意: 不要用 UPX 压 dist/lxm-tui (--compile 单文件), 会破坏尾部模块图。
# 用法: bun run build:portable
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$ROOT/dist-js"
NM_PARENT=$(dirname "$ROOT")/node_modules   # @opentui 实际装在父目录

command -v upx >/dev/null || { echo "需要 upx (可选: 去掉 upx 行则不压缩)"; exit 1; }
[ -d "$NM_PARENT/@opentui/core" ] || { echo "找不到 $NM_PARENT/@opentui/core"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/node_modules/@opentui"

# 1. 单文件 JS bundle (包外置, 运行时按目录解析)
bun build "$ROOT/index.ts" --target=bun --packages=external --outfile "$OUT/app.js"

# 2. 最小运行时依赖树
cp -r "$NM_PARENT/@opentui/core" "$NM_PARENT/@opentui/core-linux-arm64" "$OUT/node_modules/@opentui/"
for m in bun-ffi-structs diff marked string-width strip-ansi emoji-regex; do
  [ -d "$NM_PARENT/$m" ] && cp -r "$NM_PARENT/$m" "$OUT/node_modules/" || true
done

# 3. bun 运行时副本 + UPX 压缩 (约 77M -> 34M, 耗时 ~2 分钟)
cp "$(readlink -f "$(command -v bun)")" "$OUT/lxm-tui"
upx -9 "$OUT/lxm-tui" >/dev/null

# 4. 入口: package.json 使 ./lxm-tui . 可运行; lxm.sh 转发全部参数
printf '{"name":"lxm-tui","module":"app.js"}\n' > "$OUT/package.json"
cat > "$OUT/lxm.sh" <<'EOF'
#!/bin/sh
# lxm-tui 启动器: 把参数原样转发给同目录的 app.js (支持经软链接调用)
self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
d=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)
exec "$d/lxm-tui" "$d/app.js" "$@"
EOF
chmod +x "$OUT/lxm.sh"

echo "OK -> $OUT ($(du -sh "$OUT" | cut -f1))"
echo "运行: $OUT/lxm.sh [音乐目录|-v|config ...]"
