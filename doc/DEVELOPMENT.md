# 蓝汐音乐 (lxm-tui) — AI 开发文档

> 本文档面向后续接手的 AI 代理 / 开发者。记录架构、数据流、不变量与踩坑史。
> 改代码前先读完本文件; 改完代码后若行为契约有变, 同步更新本文件。
> 当前版本: r-0.2 (字符串同时存在于 `index.ts` HELP 与 `--version` 输出、`package.json`)

## 0. 一句话概览

Bun + TypeScript + `@opentui/core` 的终端音乐播放器, 播放引擎是外部 `mpv` 进程,
通过 unix socket 上的 JSON IPC 驱动。从 Python curses 版 `lxm.py` 移植, 配置文件双向兼容。

## 1. 目录结构

```
index.ts              入口: CLI 参数 / mpv 拉起 / renderer / 100ms 主循环 / 退出清理
src/
  config.ts           config.toml 读写 (自研 TOML 子集解析, 非完整 TOML)
  scanner.ts          音乐目录递归扫描 + 文件名工具 (baseName/titleOf/dirBase)
  lrc.ts              LRC 歌词解析 (多时间戳展开 / offset / 头部 tag)
  mpv.ts              MpvClient: unix socket JSON IPC, 事件驱动 + request_id 响应匹配
  player.ts           Player: 全部播放状态与逻辑, 不含任何 UI
  playlists.ts        歌单持久化 (独立 playlists.toml, [[playlist]] 子表数组)
  theme.ts            Catppuccin 四口味主题 (latte/frappe/macchiato/mocha)
  ui.ts               PlayerUI: OpenTUI 组件树 + 按键路由 + 渲染更新 (约 1750 行, 最大文件)
tests/
  playlist-test-env.ts   数据隔离模块 — 必须作为 playlist-test 的第一条 import
  playlist-test.ts       歌单 CRUD / 加歌选歌 / 游标对齐
  ui-test.ts             无头渲染冒烟 (createTestRenderer)
  theme-test.ts          主题循环切换
  regress-test.ts        回归: end-file 切歌链防多米诺
  regress2-test.ts       回归: 搜索/收藏模式下切歌
doc/                    本文档
build-portable.sh   可分发目录构建脚本 (bun run build:portable)
```

运行: `bun index.ts [音乐目录]`。测试: `bun run test` (package.json 链式跑 5 个;
`bun test` 原生 runner **不识别** `*-test.ts` 命名, 不要改用)。

编译单文件二进制: `bun run build` → `dist/lxm-tui` (`bun build --compile
--target=bun-linux-arm64 index.ts --outfile dist/lxm-tui`)。OpenTUI 的原生
`libopentui.so` 会被内嵌进产物, 运行不再需要 bun / node_modules, 但仍需系统 `mpv`。
可压缩的便携方案: `bun run build:portable` (`build-portable.sh`) → `dist-js/` 目录
(~67MB): `app.js` 单文件 bundle + 外置 UPX 压缩 bun 运行时 + 最小 node_modules
(@opentui/core, core-linux-arm64, bun-ffi-structs, diff, marked, string-width,
strip-ansi, emoji-regex) + `lxm.sh` 启动器。此方案 UPX 安全 (运行时无 trailer)。
注意: `@opentui/core` 实际从**父目录** `/home/flt18355/Daily/tools/node_modules`
解析 (bun 向上查找), 不在本项目 node_modules 里 — 脚本里 NM_PARENT 就是为此。
`dist/`、`dist-js/` 是产物目录, 不要手改, 也不要提交。

## 2. 启动流程 (index.ts main())

1. 解析 argv: `config` 子命令 / `-h` / `-v` / 位置参数 = 音乐目录。
2. 音乐目录优先级: 命令行 > config `music_directory` > `~/Music`。不存在则退出。
3. `scanDirectory` 扫描音频文件 (扩展名白名单见 scanner.ts `AUDIO_EXTS`), 空则退出。
4. 拉起 mpv: `Bun.spawn(["mpv","--idle=yes","--no-video",
   `--input-ipc-server=/tmp/lanxi_mpv_<pid>.sock`,"--terminal=no","--quiet","--no-config","--volume=100"])`。
   `waitForSocket` 轮询 socket 出现 (5s 超时)。
5. `createCliRenderer({ exitOnCtrlC, screenMode:"alternate-screen", useMouse:true })`。
6. `MpvClient.connect` (40 次 × 100ms 重试)。
7. `new Player(mpv)`, 注入 playlist/queue, 从 config 恢复: `volume`(0~150)、`speed`(0.25~4)、
   `theme`(`parseThemeName`, 无效回退 latte)、`favorites`、`last_path`+`last_pos` 断点续播
   (在 playlist 里找到 last_path 才恢复, `pendingSeek` 等 time-pos>0.2 后一次性 seek)。
8. `new PlayerUI(renderer, player, theme)`; `ui.onQuit = () => shutdown(0)`。
9. 主循环: `setInterval(() => ui.tick(), 100)`。
10. 退出路径全部汇聚到 `shutdown(code)`: 幂等 (`exited` 标志), 顺序 = 清 interval →
    `player.saveState()` → `mpv.close()` → `renderer.destroy()` → kill mpv 进程 (2s 宽限后 kill(9))
    → 删 socket 文件 → `process.exit`。SIGINT/SIGTERM/renderer destroy 事件都接这里;
    mpv 意外退出也会触发 shutdown。

## 3. mpv IPC 协议 (src/mpv.ts)

- 线协议: 每行一个 JSON。发 `{"command":[...],"request_id":N}\n`;
  回含 `request_id` 的是命令响应, 含 `event` 的是事件。
- `command()` 超时 4s 返回 `null` (不抛错); 断线时 `flushPending()` 把挂起请求全部 resolve(null)。
- 事件订阅: `observeProperty(id, name)`, UI 挂了 id 1~4:
  `time-pos` / `duration` / `pause` / `eof-reached`。
- **UI 消费事件的位置**: `PlayerUI.attachMpvEvents()`:
  - `property-change time-pos` → `p.timePos`; 顺带处理 `pendingSeek`。
  - `property-change duration/pause` → 对应字段。
  - `file-loaded` → `p.onFileLoaded()` (解除 end-file 抑制 + 补拉 duration)。
  - `end-file` 且 reason ∈ {eof, stop} 且 `!suppressEndFile` → `p.maybeAdvance()` 自动切歌。

## 4. Player 核心模型 (src/player.ts)

### queue 索引模型 (最重要的不变量)

- `playlist: string[]` 是真实文件列表; `queue: number[]` 是**指向 playlist 下标的索引数组**。
- 所有"下一首/上一首/随机/收藏模式"都只重排 queue, `idx` 始终是 playlist 真实下标。
- `selToPlaylistIdx(sel, isFiltered)`: UI 游标 → 真实下标。过滤视图 (搜索/收藏) 中
  `sel` 是 queue 内位置, 非过滤时是 playlist 位置。**任何新过滤视图都必须走这个映射, 别自创。**

### 切歌防多米诺 (suppressEndFile)

`playIndex()` loadfile 前设 `suppressEndFile = true` (旧文件停止会触发 end-file),
`file-loaded` 事件解除; 另有 2s 定时器兜底防止永久抑制。
**改动任何切歌路径都必须保持这个抑制窗口**, regress-test.ts 专防这个回归。

### 淡入淡出

`updateFade()` 每 tick 调用: 新歌 `fadeVol` 从 0 以 `volume/8` 每帧渐升;
剩余 <2s 且非单曲循环时渐降。`volume` 是淡入目标, 所以启动恢复音量必须**先于**首次播放。

### 收藏与 favMode

- `favorites: string[]` 存绝对路径 (不是下标, 重扫目录不丢)。
- `favMode` 开启时 queue 替换为收藏下标; **favMode 严格跟随 UI view** —
  `setView` 离开收藏视图必然 `toggleFavMode()` 还原全量 queue。破坏此不变量会导致
  列表视图只显示收藏 (历史 bug)。

### 状态持久化

`saveState()` 只写 `last_path`/`last_pos`。favorites 在 toggle 时即时写;
theme/volume/speed 在设置调整时即时 `saveConfig`。

## 5. UI 架构 (src/ui.ts) — 改这里前必读

### 四视图状态机

```
view: "list" | "fav" | "pl" | "settings"   (tab 键 1/2/3/4 或鼠标点击)
plLevel: "list" | "detail"                  (歌单 tab 内二级)
plPickerMode                                 (详情内 a 加歌选歌, 数据源=全库 playlist)
plDialogMode: "new" | "rename" | "set-dir" | null  (居中输入弹层)
```

- 每个视图游标独立: `savedListSel`/`savedFavSel` 在 `setView` 离开时存、进入时恢复。
- `searchActive` 是叠加在 list/fav 上的过滤态 (queue 换成搜索结果), 进视图切换会清。
- 全屏歌词 `fullLyrics` 与帮助 `showHelp` 是 absolute overlay (zIndex 200/300), 不是视图。

### 渲染更新管线

- `tick()` (100ms): 等化器动画 → `updatePlaylist()` → `updateNowPlaying()` →
  `updateLyrics()` → 标题/状态栏 → `p.updateFade()` → duration 兜底拉取 → 全屏歌词。
- `updatePlaylist()` 是列表区唯一真相源, 三个函数协作:
  - `listCount()`: 当前视图行数 (settings 恒 4)。
  - `rowAt(i)`: 返回 `{ marker, text, playing }`。
  - `rebuildPlaylistRows(count)`: 行数变化时增删行节点 (box+text), 否则只改 content。
  - **新增视图必须同时改这三处 + `onRowClick` + `playlistTitle` + `handleKey` 路由**,
    漏一处就是渲染错位或按键穿透。
- 歌词高亮: 当前句 = `time <= timePos` 的最后一行; **同一时间戳的所有行一起高亮**
  (和声/重复词), 小窗与全屏 (KTV) 两处逻辑一致, 样式差异靠前缀图标 + 颜色。
  注意 LRC 里空文本时间戳行会照常渲染成空行, 这是歌词文件问题, 不是 bug。

### 事件挂接规则 (历史踩坑)

- `attachGlobalKeys()` 只在构造时挂一次; `applyTheme` 重建树后**不得**重复挂, 否则一次按键响应多遍。
- `searchInput` / `plDialogInput` 的 ENTER/CHANGE 事件在 `buildTree` 内挂 —
  重建树后由 `attachInputEvents`/`attachDialogEvents` 重新挂到新节点。

### 主题切换 = 全树重建

`applyTheme(name)`: 备份 `showHelp/fullLyrics/searchMode/searchActive/searchQuery/msg/msgUntil/
view/plLevel/plCurrent/plPickerMode/savedListSel/sel` → `renderer.root` 下整树
`destroyRecursively()` → `buildTree()` → 恢复备份字段。`savedFavSel`/`dirInput` 不在清单 —
它们是实例字段天然存活; 但渲染节点引用 (plRows/lyricRows/fullLyricRows) 清空重建。
新增任何"跨重建要存活"的 UI 状态, 必须加进这个备份/恢复清单。

### 按键路由顺序 (handleKey)

优先级从上到下: 帮助覆盖层任意键关闭 → 全屏歌词拦截 (L/Esc/q 退出, 空格/n/p 可用) →
searchMode (仅 Esc 退出, 其余交输入框) → plDialog 弹层 (仅 Esc 关闭, 其余交 input) →
j/k/up/down 统一导航 (视图感知) → settings 视图路由块 (Esc/←/→/Enter) →
pl 视图路由块 → 普通 switch (空格/n/p/seek/m/s/f/F/l/L/d/h/1..4/q/±/M)。
**在视图路由块里 return 的键不会落入全局 switch**; 反之全局键 (如 +/- 音量)
在 settings 路由块故意不拦截, 让设置视图也能用。

### 快捷键现状

- `t` 已废弃 (只 flash 提示去设置); 主题/音量/倍速/目录全部收进 `4` 设置视图。
- `r`/`a` 不再是倍速 (在歌单视图里是重命名/加歌); 倍速只在设置视图 `←/→` 步进 0.25。
- 音量 `+`/`-` 即时 `saveConfig({ volume })`; 倍速调整 `saveConfig({ speed })`。

### Nerd Font 图标
源码里用 `\uXXXX` 转义写 FontAwesome PUA 码位 (终端 nerd font 渲染; 源码保持可 grep):
F025 标题耳机 / F001 音乐 / F004 收藏 / F03A 列表 / F1C5 歌单 / F013 设置 /
F002 搜索 / F04B play / F04C pause / F04D stop / F074 随机 / F026 静音 /
F1FC 主题画笔 / F067 新建 / F044 重命名 / F055 加入 / F1F8 删除 / F07B 目录 /
F07C 目录已切换。**禁止引入 emoji**; 方向键 ←→↑↓ 与进度块 █░▁-▆ 是功能符号, 允许。

## 6. 配置与数据文件

### ~/.config/lxmusic/config.toml

- 自研 TOML **子集**解析器 (`parseToml`): 只支持顶层 `key = value` (字符串/数字/布尔/
  单行字符串数组), **不支持嵌套表**。所以歌单放独立文件。
- `saveConfig(patch)` = 读旧 → 合并 → 整文件重写 (带固定头注释)。写失败静默 ignore。
- 已知键: `music_directory` `favorites[]` `last_path` `last_pos` `theme` `volume` `speed`。
- 与 Python 版 lxm.py 共用, 保持键名 snake_case, 别改格式。

### ~/.config/lxmusic/playlists.toml

- `[[playlist]]` + `name` + `paths[]` 的极简子集, 解析/序列化在 playlists.ts。
- 整文件覆盖写。加载时过滤无名歌单。
- 环境变量 `LXM_PLAYLISTS_FILE` 可重定向 (测试隔离用, 见下)。

## 7. 测试规约

- 全部用 `createTestRenderer` 无头渲染, fake MpvClient (返回 null/undefined 的哑对象,
  `onEvent` 把 handler 收集进数组供手动 `emit`)。
- **playlist-test.ts 的第一条 import 必须是 `./playlist-test-env`** — 它在模块求值时
  设置 `LXM_PLAYLISTS_FILE` 指向进程临时文件, ESM import 顺序保证后续
  `player → playlists` 链读到隔离路径, 绝不碰用户真实歌单。移动 import 位置 = 污染主人歌单。
- 布局就绪需要 **两次 `tick()` + `renderOnce()`** — 首帧时 `lyricInner.height` 等
  几何量未计算, `updateLyrics` 会早退。验证渲染结果用 `captureCharFrame()` 做
  文本/缩进断言 (StyledText 的 `content` 不是纯字符串, `String()` 拿不到)。
- 测试会 `saveConfig` 落盘的 (如 speed), 跑之前自己备份 `~/.config/lxmusic/config.toml`。
- 没有 git 仓库。改动前评估可回滚性, 大改先复制备份。

## 8. 性能注意 (本机特性)

- 这台机器 fork/exec 极慢: 能用 `statSync`/`rmSync(force)` 就别 spawn;
  index.ts 里已有多处此类优化 (注释标明), 别"顺手重构"回去。
- 渲染走增量更新 (`updatePlaylist` 只在行数变化时增删节点; `lastPlTitle` 缓存避免
  重复赋值)。别在 tick 里无条件重建节点。
- `clipWidth` 按 CJK 宽字符 (code > 0x2e7f 且非中间区间) 计 2 列截断, 列表/歌词都用它。

## 9. 已知坑与决策记录

| 坑 | 结论 |
|---|---|
| end-file 在切歌瞬间误触发 | suppressEndFile 抑制窗口 (§4), 勿删 |
| favMode 残留导致列表视图只显示收藏 | favMode 严格跟随 view (§4) |
| 重建主题树后按键双响应 | attachGlobalKeys 只挂一次 (§5) |
| `bun test` 找不到测试 | 用 `bun run test`; 勿改文件名成 `*.test.ts` 引原生 runner (测试是脚本式断言非 bun:test) |
| README 曾有 menu-test.ts | 不存在的历史遗留, 已删; 再写文档前核对文件真实存在 |
| 歌词同时间戳多行只亮一行 | 已修: 按 `time === curTime` 集合高亮 (§5) |
| InputRenderable 宽度动态改 | plDialog 输入框 set-dir 模式加宽到 70, closePlDialog 恢复 40 |
| LRC 空行渲染 | 歌词文件自带空文本时间戳, 播放器忠实显示, 非 bug |
| UPX 压单文件产物后报 `SyntaxError: Invalid character: '\0'` | 勿 UPX `dist/lxm-tui`! bun --compile 把模块图作为**未压缩** trailer 追加在 ELF 尾部, 运行时经 /proc/self/exe 从磁盘原文件按偏移读取; UPX 只解内存镜像不改磁盘文件 → trailer 读坏 (`--overlay=copy` 也救不了: OpenTUI native worker 偏移同样错位)。要压缩用 `bun run build:portable` → `dist-js/` (~67MB): 运行时外置成独立 bun 可执行再 UPX (实测官方 bun 压完可用), 配 `lxm.sh` 薄壳启动器。`upx -d` 可还原单文件版; `--strip` 无体积效果; `libopentui.so` 压不了 (缺 DT_INIT) |

## 10. 验证清单 (每次改动后)

```bash
bunx tsc --noEmit    # 必须干净 (TS5097 扩展名告警可忽略)
bun run test         # 5 个测试全绿
bun index.ts -v      # 版本号与 package.json 一致
```

交互面改动无法无头覆盖时, 明确告知用户需真机验证, 不要谎称已验证。
