# 蓝汐音乐 (lxm-tui)

OpenTUI 版本地音乐播放器，基于 **mpv JSON IPC**。由 AI 制作

## 特性

- 🎵 播放 / 暂停 / 上一首 / 下一首（mpv 驱动，支持全格式）
- 🔁 三种循环模式：不循环 / 列表循环 / 单曲循环
- 📜 LRC 歌词实时滚动 + 全屏 KTV 歌词模式（`L`）
- 🔀 随机播放（shuffle）
- 🔍 中文搜索（原生 Unicode 输入框）
- ♥ 收藏夹 + 只看收藏模式（`f` / `F`）
- 🎨 四种 Catppuccin 主题: Latte 拿铁 / Frappé 冰沙 / Macchiato 玛奇朵 / Mocha 摩卡 (`t` 循环切换, 自动保存)
- 💾 断点续播：退出记住歌曲与位置，重开自动续播
  - 🎚 切歌淡入淡出（渐弱 → 渐强）
  - 🔇 静音切换（M 或 0）· 进度条鼠标点击/拖动定位
- 🐱 Catppuccin Latte 配色 + 渐变进度条 + 伪频谱等化器
- 🖱 鼠标点击播放列表行直接播放

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

## openTUI

```bash
bun add @opentui/core # 安装openTUI(要在项目里面)
npx skills add anomalyco/opentui --skill opentui # AI skills
```


配置保存在 `~/.config/lxmusic/config.toml`（与 Python 版兼容，可混用）。

## 快捷键

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| 空格 / Enter | 播放 / 暂停 / 播放选中 | n / p | 下一首 / 上一首 |
| ← / → | 快退 / 快进 5 秒 | [ / ] | 快退 / 快进 10 秒 |
| r / a | 减速 / 加速 (0.25x~4x) | + / - | 音量增 / 减 |
  | m | 循环模式切换 | t | 切换主题 (Latte→Frappé→Macchiato→Mocha) |
  | M / 0 | 静音切换 |  |  |
| m | 循环模式切换 | / | 搜索 (Enter 确认, Esc 取消) |
| l / L | 歌词开关 / 全屏歌词 | f / F | 收藏 / 只看收藏 |
| d | 重新扫描目录 | h | 帮助 (任意键关闭) |
| t | 切换主题 (Latte→Frappé→Macchiato→Mocha) | q / Esc | 退出 / 退出搜索 |


## 开发

```bash
bunx tsc --noEmit   # 类型检查
bun ui-test.ts      # 无头 UI 渲染测试 (createTestRenderer)
bun theme-test.ts   # 主题测试
bun menu-test.ts    # 主菜单测试   # 主题切换测试
bun menu-test.ts    # 功能面板测试
bun regress-test.ts # 回归测试 (end-file 切歌链防多米诺)
```

## 结构

```
index.ts        入口: 参数 / mpv 启动 / renderer / 主循环 / 清理
src/config.ts   配置读写 (TOML, 兼容 Python 版)
src/scanner.ts  音乐目录递归扫描
src/lrc.ts      LRC 歌词解析
src/mpv.ts      mpv JSON IPC 客户端 (Bun unix socket, 事件驱动)
src/player.ts   播放器状态与逻辑
src/theme.ts    Catppuccin 四口味主题 (Latte/Frappé/Macchiato/Mocha)
src/ui.ts       OpenTUI 界面, 支持 t 键实时切换主题
```