# UI 架构 (src/ui.ts) — 改这里前必读

> `ui.ts` 约 1750 行, 是单文件最大模块。PlayerUI 是单个高内聚类 — 状态字段
> (sel/view/plRows...) 被所有方法交叉读写, `applyTheme` 全树重建依赖统一备份清单,
> **拆成多类需暴露私有状态或回调注入, 得不偿失, 保持单体**。
> 文件顶部有区块导航注释 (方法名 + 行号), 按需用 `read file:a-b` 精准读取, 别整读。

## 四视图状态机

```
view: "list" | "fav" | "pl" | "settings"   (tab 1/2/3/4 或鼠标点击)
plLevel: "list" | "detail"                  (歌单 tab 内二级)
plPickerMode                                 (详情内 a 加歌选歌, 数据源=全库 playlist)
plDialogMode: "new" | "rename" | "set-dir" | null  (居中输入弹层)
```

- 每视图游标独立: `savedListSel`/`savedFavSel` 在 `setView` 离开时存、进入时恢复。
- `searchActive` 是叠加在 list/fav 上的过滤态 (queue 换成搜索结果), 进视图切换会清。
- 全屏歌词 `fullLyrics` 与帮助 `showHelp` 是 absolute overlay (zIndex 200/100), 不是视图;
  歌曲信息弹层 `showInfo` 是居中卡片 overlay (zIndex 150, `i` 键开, 任意键关)。
- 帮助 overlay 为分组卡片式: `helpSections` (图标 + 组名 + `[键, 说明]` 列表), 键列按显示宽度
  22 对齐; 标题与底部带 `VERSION` (见 src/version.ts)。加/改帮助项只动 `helpSections`。
- tab 栏右端 `playsStat` (设置按钮右边) 显示"共播放 N 次", 由 tick 里 `totalPlayCount`
  触发更新 (playIndex 时 +1, 见 data.md plays.toml)。
- 睡眠定时器: `z` 全局切换预设 (见 player.md), 头部 `headRightText` 实时倒计时,
  tick 里 `sleepExpired()` 到点自动暂停; 设置视图第 4 行可 ←/→ 切换。

## 渲染更新管线

- `tick()` (100ms): 布局维护 (歌词区收起 / 列表分隔线宽度) → 等化器动画 → `updatePlaylist()` →
  `updateNowPlaying()` → `updateLyrics()` → 标题/状态栏 → `p.updateFade()` → duration 兜底拉取 → 全屏歌词。
- `updatePlaylist()` 是列表区唯一真相源, 三函数协作:
  - `listCount()`: 当前视图行数 (settings 恒 8: 主题/音量/倍速/歌词延迟/睡眠定时/音乐目录/缓存/版本)。
  - `rowAt(i)`: 返回 `{ marker, num, text, meta, playing }`
    (`num` = 右对齐序号列, `text` = 标题, `meta` = 右侧"扩展名 + 时长秒数")。
  - `rebuildPlaylistRows(count)`: 行数变化时增删行节点 (**每行 = box + num + text + meta 四节点**), 否则只改 content。
  - **新增视图必须同时改这三处 + `onRowClick` + `playlistTitle` + `handleKey` 路由**,
    漏一处就是渲染错位或按键穿透。
- 列表行去扩展名显示歌名 (`titleOf`), 右侧 meta 显示格式 + 时长 (秒, 未知为 `--`)。
  时长来自 `p.durationOf` (播放回填 + `src/duration.ts` 后台探测, 见 player.md)。
- 三列配色: 序号选中=sky粗体/播放=overlay; 标题选中=text粗体/播放=green粗体/其余=text;
  meta 选中=text/播放=green/其余=overlay。播放行最左 marker 用 green 播放图标。
- 超宽滚动: 选中/播放行的歌名超长时用 `scrollText` 行内滚动 (marquee, 由 `tickCount` 驱动);
  非选中行 `clipWidth` 截断。歌词区当前句同样滚动 (小窗 + 全屏)。
- 行内播放次数: 每行尾部 `♪N` (`playCountOf`, 内存缓存, 只播过才显示);
  正在播放卡片标题后追加"已播放 N 次"。
- 视觉润色 (纯排版, 无状态):
  - 顶栏下 **顶部渐变色彩线** (accent, 6 段 flexGrow 平分: sky→lavender→pink→peach→yellow→green)。
  - 正在播放卡片紧凑化 (去上下内边距), 底部一条 `╸` **渐变分隔线** (`nowDivider`, 铺满卡片内宽)。
  - 进度条 **8x 高分辨率**: 9 段分数块 `▏▎▍▌▋▊▉█` 平滑填充 + sky/lavender/pink 三段渐变。
  - 列表标题下 `plDivider` 细线 (`─`, 宽度随 `scrollbox.width` 在 tick 刷新, 缓存 `lastPlDivW`)。
  - 状态栏右侧音量块字符 (`volGlyph`: 0→▁ … 100+→█)。
- 歌词高亮: 当前句 = `time <= (timePos - lyricDelay)` 的最后一行; **同一时间戳所有行一起高亮**
  (和声/重复词), 小窗与全屏 (KTV) 逻辑一致; `lyricDelay` 由设置行 4 调整 (-5~5s, 负=提前, 见 player.md)。
  LRC 空文本时间戳行会照常渲染成空行 (歌词文件问题, 非 bug)。
- **歌词区自动收起**: `lyricsBox.visible = showLyrics && lyrics.length > 0` (tick 里维护);
  无歌词/关闭时不占高度, 把空间让给列表。

## 事件挂接规则 (历史踩坑)

- `attachGlobalKeys()` 只在构造时挂一次; `applyTheme` 重建树后**不得**重复挂, 否则一次按键响应多遍。
- `searchInput` / `plDialogInput` 的 ENTER/CHANGE 在 `buildTree` 内挂 — 重建树后由
  `attachInputEvents`/`attachDialogEvents` 重新挂到新节点。

## 主题切换 = 全树重建

`applyTheme(name)`: 备份 `showHelp/fullLyrics/showInfo/searchMode/searchActive/searchQuery/msg/msgUntil/
view/plLevel/plCurrent/plPickerMode/savedListSel/sel` → 整树 `destroyRecursively()` →
`buildTree()` → 恢复备份。`savedFavSel`/`dirInput` 不在清单 (实例字段天然存活);
渲染节点引用 (plRows/lyricRows/fullLyricRows/infoLines/nowDivider/plDivider/lyricsBox) 清空重建; showInfo 恢复时经
`openInfo()` 重填内容 (nowDivider/lyricsBox/lastPlDivW 由 tick 重算, 无需备份)。
**新增任何"跨重建要存活"的 UI 状态, 必须加进备份/恢复清单。**

## 按键路由顺序 (handleKey)

优先级从上到下: 帮助任意键关闭 → 歌曲信息弹层任意键关闭 → 全屏歌词拦截 (L/Esc/q 退出, 空格/n/p 可用) →
searchMode (仅 Esc 退出) → plDialog 弹层 (仅 Esc 关闭) →
j/k/up/down 统一导航 (视图感知) → g/G 列表首尾 → settings 路由块 (Esc/←/→/Enter) →
pl 路由块 → 普通 switch (空格/n/p/seek/m/s/z/i/f/F/l/L/d/h/1..4/q/±/M)。
**视图路由块里 return 的键不会落入全局 switch**; 反之全局键 (如 +/- 音量, z 睡眠)
在 settings 路由块故意不拦截, 让设置视图也能用。

## 快捷键现状

- `t` 废弃 (只 flash 提示); 主题/音量/倍速/歌词延迟/睡眠定时/目录/缓存/版本全在 `4` 设置视图
  (设置行: 0 主题 / 1 音量 / 2 倍速 / 3 歌词延迟 / 4 睡眠定时 / 5 音乐目录 / 6 缓存 / 7 版本只读)。
- `r`/`a` 在歌单视图是重命名/加歌; 倍速/歌词延迟只在设置视图 `←/→` 步进 0.25
  (歌词延迟 -5~5s, 负=提前/正=滞后)。
- 音量 `+`/`-` 即时 `saveConfig({ volume })`; 倍速调整 `saveConfig({ speed })`; 歌词延迟 `saveConfig({ lyric_delay })`。
- 新增键: `z` 睡眠定时循环 (15/30/60/90 分钟, 0=关, 全视图可用) · `i` 歌曲信息弹层 ·
  `g`/`G` 列表首/尾 (vim 风格)。

## Nerd Font 图标

源码用 `\uXXXX` 转义写 FontAwesome PUA 码位 (保持可 grep): F025 标题耳机 / F001 音乐 /
F004 收藏 / F03A 列表 / F1C5 歌单 / F013 设置 / F002 搜索 / F04B play / F04C pause /
F04D stop / F074 随机 / F026 静音 / F1FC 主题画笔 / F067 新建 / F044 重命名 / F055 加入 /
F1F8 删除 / F07B 目录 / F07C 目录已切换 / F017 睡眠定时时钟。
**禁止 emoji**; 功能符号 (非图标) 可用: 方向键 ←→↑↓ · 进度块 █░ + 分数块 ▏▎▍▌▋▊▉ ·
音量块 ▁▂▃▄▅▆▇█ · 分隔 `─`/`╸` · 等化器 ▁-▆。