# 蓝汐音乐 (lxm-tui)

OpenTUI 版本地音乐播放器，基于 **mpv JSON IPC**。由 curses 的 `lxm.py` 移植而来，全新 UI

## 特性

-  播放 / 暂停 / 上一首 / 下一首（mpv 驱动，支持全格式）
-  三种循环模式：不循环 / 列表循环 / 单曲循环
-  LRC 歌词实时滚动 + 全屏 KTV 歌词模式（`L`）
-  随机播放（shuffle）
-  中文搜索（原生 Unicode 输入框）
-  收藏：`f` 收藏当前曲，列表区四视图 tab（`1` 播放列表 / `2` 收藏 / `3` 歌单 / `4` 设置）
-  歌单管理：创建 / 重命名 / 删除歌单，进入歌单详情，选歌加入 / 移除，独立持久化为 `playlists.toml`（`3` 或 `P` 进入）
-  设置视图（`4`）：主题（Catppuccin 四口味）· 音量· 倍速（均自动保存）· 音乐目录（输入路径即时重扫）
-  断点续播：退出记住歌曲与位置，重开自动续播
  -  切歌淡入淡出（渐弱 → 渐强）
  -  静音切换（M 或 0）· 进度条鼠标点击/拖动定位
-  Catppuccin Latte 配色 + 渐变进度条 + 伪频谱等化器
-  鼠标点击 tab 切换视图 · 点击播放列表行直接播放

## 运行

```bash
# 需要 bun (>= 1.3.0) 和 mpv
bun install        # 首次
bun index.ts                       # 启动 (使用配置中的音乐目录)
bun index.ts /path/to/music        # 指定目录
bun index.ts -v / --version        # 显示版本
bun index.ts config                # 查看当前配置
bun index.ts config --music-directory /path/to/music   # 设置音乐目录
```

配置保存在 `~/.config/lxmusic/config.toml`（与 Python 版兼容，可混用）。

## 编译为二进制

```bash
bun run build           # → dist/lxm-tui (单文件 ~129MB, 已内嵌 OpenTUI 原生 .so)
./dist/lxm-tui          # 直接运行, 无需 bun / 无需 node_modules

bun run build:portable  # → dist-js/ (可分发目录 ~67MB, 运行时外置)
./dist-js/lxm.sh        # 薄壳启动器; 也可 ./dist-js/lxm-tui .
```

两种产物都仍依赖系统 `mpv`。目标平台由 `--target` 指定 (默认 bun-linux-arm64; 其他平台改成
`bun-linux-x64` / `bun-darwin-arm64` 等)。

**UPX 注意**: 单文件 `dist/lxm-tui` **不能**用 UPX 压 (会破坏尾部模块图, 启动报
`SyntaxError: Invalid character: '\0'`)。要压缩体积就用 `build:portable` — 它把 bun
运行时拆成独立可执行文件再 UPX, 压完仍可用。

全局安装 (任意目录敲 `lxm`): `ln -s /path/to/dist-js/lxm.sh ~/.local/bin/lxm`
(启动器会跟随软链定位 dist-js, 勿直接拷走 lxm.sh)。

## 快捷键

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| 空格 / Enter | 播放 / 暂停 / 播放选中 | n / p | 下一首 / 上一首 |
| ← / → | 快退 / 快进 5 秒 | [ / ] | 快退 / 快进 10 秒 |
| + / - | 音量增 / 减 (自动保存) | M / 0 | 静音切换 |
| m | 循环模式切换 | M / 0 | 静音切换 |
| 1 / 2 / 3 / 4 | 切换视图：播放列表 / 收藏 / 歌单 / 设置 | ↑↓ / jk | 选择行 |
| l / L | 歌词开关 / 全屏歌词 | f | 收藏当前曲 |
| / | 搜索 (Enter 确认, Esc 取消) | d | 重新扫描目录 |
| + / - | 音量增 / 减（自动保存） | h | 帮助 (任意键关闭) |
| P | 进入歌单视图 (= 3) | q / Esc | 退出 / 逐级返回 |
| 歌单视图内 | n / r / d | 新建 / 重命名 / 删除歌单 |
| 歌单详情内 | Enter / a / x | 播放 / 加歌 / 移除 |
| 设置视图内 | Enter 或 ←/→ | 主题=切换 · 音量=±5 · 倍速=±0.25 · 目录=弹层输入路径 |


## 开发

架构、数据流、不变量与踩坑史见 [`doc/DEVELOPMENT.md`](doc/DEVELOPMENT.md) (面向后续 AI / 开发者, 改码前必读)。

```bash
bunx tsc --noEmit          # 类型检查
bun run test               # 全部测试 (tests/ 下所有 *-test.ts)
bun tests/ui-test.ts       # 无头 UI 渲染测试 (createTestRenderer)
bun tests/theme-test.ts    # 主题切换测试
bun tests/playlist-test.ts # 歌单功能测试 (数据隔离到临时文件)
bun tests/regress-test.ts  # 回归测试 (end-file 切歌链防多米诺)
bun tests/regress2-test.ts # 回归测试 (搜索/收藏模式下切歌)
```

## 结构

```
index.ts          入口: 参数 / mpv 启动 / renderer / 主循环 / 清理
src/config.ts     配置读写 (TOML, 兼容 Python 版)
src/scanner.ts    音乐目录递归扫描
src/lrc.ts        LRC 歌词解析
src/mpv.ts        mpv JSON IPC 客户端 (Bun unix socket, 事件驱动)
src/player.ts     播放器状态与逻辑
src/playlists.ts  歌单持久化 (TOML 子表数组)
src/theme.ts      Catppuccin 四口味主题 (Latte/Frappé/Macchiato/Mocha)
src/ui.ts         OpenTUI 界面 (四视图 tab: 列表/收藏/歌单/设置, 设置内切换主题)
tests/            无头测试 (ui / theme / playlist / regress / regress2)
```