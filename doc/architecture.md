# 架构总览 — 蓝汐音乐 (lxm-tui)

> Bun + TypeScript + `@opentui/core` 终端播放器, 引擎是外部 `mpv` (unix socket JSON IPC)。
> 从 Python curses 版 `lxm.py` 移植, 配置兼容。
> 版本: r-0.2 (index.ts HELP / `--version` / package.json 三处一致)

## 目录结构

```
index.ts              入口: CLI / mpv 拉起 / renderer / 100ms 主循环 / 退出清理
src/
  config.ts           config.toml 读写 (自研 TOML 子集)
  cache.ts            缓存目录 ~/.cache/lxmusic/ (state.toml / scan-cache.toml)
  scanner.ts          音乐目录递归扫描 (带缓存) + 文件名工具
  lrc.ts              LRC 解析 (多时间戳 / offset / 头部 tag)
  mpv.ts              MpvClient: JSON IPC, 事件驱动 + request_id 响应匹配
  player.ts           Player: 全部播放状态与逻辑, 不含 UI
  playlists.ts        歌单持久化 (playlists.toml, [[playlist]] 子表)
  theme.ts            Catppuccin 四口味 (latte/frappe/macchiato/mocha)
  ui.ts               PlayerUI: 组件树 + 按键路由 + 渲染 (最大文件, 见 doc/ui.md)
tests/                脚本式断言 (非 bun:test), 见 doc/testing.md
dist/ dist-js/        构建产物, 勿手改
```

## 构建

- 单文件: `bun run build` → `dist/lxm-tui` (`bun build --compile --target=bun-linux-arm64`)。
  OpenTUI 原生 `libopentui.so` 内嵌, 运行不需 bun/node_modules, 仍需系统 mpv。
- 便携: `bun run build:portable` → `dist-js/` (~67MB): `app.js` bundle + UPX 压缩 bun
  运行时 + 最小 node_modules + `lxm.sh` 启动器。UPX 安全 (运行时无 trailer)。
- **UPX 雷区**: 单文件 `dist/lxm-tui` 不能用 UPX — bun --compile 把模块图作为未压缩
  trailer 追加在 ELF 尾部, 运行时经 /proc/self/exe 按偏移读; UPX 只解内存镜像不改磁盘
  → trailer 读坏 (`--overlay=copy` 也救不了)。压缩请用 build:portable。
- `@opentui/core` 从**父目录** `/home/flt18355/Daily/tools/node_modules` 解析 (bun 向上
  查找), 不在本项目 node_modules — build-portable.sh 的 NM_PARENT 即为此事。

## 启动流程 (index.ts main())

1. 解析 argv: `config` / `cache` 子命令 / `-h` / `-v` / 位置参数 = 音乐目录。
2. 音乐目录优先级: 命令行 > config `music_directory` > `~/Music`。不存在即退出。
3. `scanDirectoryCached` 扫描 (先查 scan-cache.toml, 目录 mtime 未变直接复用, 否则
   全量扫并写缓存), 空则退出。
4. 拉起 mpv: `Bun.spawn(["mpv","--idle=yes","--no-video", --input-ipc-server=...,
   "--terminal=no","--quiet","--no-config","--volume=100"])`; `waitForSocket` 轮询 5s。
5. `createCliRenderer({ exitOnCtrlC, screenMode:"alternate-screen", useMouse:true })`。
6. `MpvClient.connect` (40 次 × 100ms 重试)。
7. `new Player(mpv)`: 注入 playlist/queue, 从 config 恢复 volume/speed/theme/favorites;
   断点续播从**缓存 state.toml** 读 (旧 config 同名键自动迁移; pendingSeek 等 time-pos>0.2 后 seek)。
8. `new PlayerUI(renderer, player, theme)`; `ui.onQuit = () => shutdown(0)`。
9. 主循环: `setInterval(() => ui.tick(), 100)`。
10. 退出统一走 `shutdown(code)` (幂等 `exited`): 清 interval → `player.saveState()` →
    `mpv.close()` → `renderer.destroy()` → kill mpv (2s 宽限后 kill(9)) → 删 socket →
    `process.exit`。SIGINT/SIGTERM/renderer destroy/mpv 意外退出都接这里。

## 其他专题

- [player.md](player.md) — Player 核心模型 (queue/favMode/suppressEndFile/淡入淡出)
- [mpv.md](mpv.md) — mpv IPC 协议与事件消费
- [ui.md](ui.md) — UI 架构 (改 ui.ts 前必读)
- [data.md](data.md) — 配置/缓存/歌单文件
- [testing.md](testing.md) — 测试规约
- [pitfalls.md](pitfalls.md) — 已知坑与决策记录