# Player 核心模型 (src/player.ts)

## queue 索引模型 (最重要的不变量)

- `playlist: string[]` 真实文件列表; `queue: number[]` 指向 playlist 下标的索引数组。
- 下一首/上一首/随机/收藏都只重排 queue, `idx` 始终是 playlist 真实下标。
- `selToPlaylistIdx(sel, isFiltered)`: UI 游标 → 真实下标。过滤视图 (搜索/收藏) 中
  `sel` 是 queue 内位置, 非过滤时是 playlist 位置。**任何新过滤视图必须走这个映射。**

## 切歌防多米诺 (suppressEndFile)

`playIndex()` loadfile 前设 `suppressEndFile = true` (旧文件停止会触发 end-file),
`file-loaded` 事件解除; 另有 2s 定时器兜底防永久抑制。
**改动任何切歌路径必须保持这个抑制窗口**, regress-test.ts 专防回归。

## 淡入淡出 (updateFade, tick 调)

- 新歌 `fadeVol` 从 0 以 `volume/8` 每帧渐升; `volume` 是淡入目标,
  **启动恢复音量必须先于首次播放**。
- 剩余 <2s 且非单曲循环时渐降。

## 收藏与 favMode

- `favorites: string[]` 存绝对路径 (非下标, 重扫不丢)。
- favMode 开启时 queue 换成收藏下标; **favMode 严格跟随 UI view** —
  `setView` 离开收藏视图必然 `toggleFavMode()` 还原全量 queue (历史 bug 教训)。

## 单曲循环 (loop-file)

- 单曲循环 = `set_property("loop-file","inf")`, 切换模式即时应用 (cycleRepeat 内)。
- **mpv ≥ 0.35 的 `loadfile` 已删位置 options 参数** (`--opt=val` / 数组 / 对象全被拒),
  任何文件级参数必须走 `set_property` (详见 [mpv.md](mpv.md))。
- `loop-file` 是持久属性, 跨 loadfile 保持; `maybeAdvance` 的 ONE 分支 (同索引重载)
  是兜底, 正常时 mpv 无缝循环不发 end-file。

## 状态持久化

- `saveState()` 写 `last_path`/`last_pos` 到**缓存** `~/.cache/lxmusic/state.toml`
  (运行时状态, 不属于配置)。favorites 即时写 config; theme/volume/speed 调整即时写。
- 旧 config.toml 的同名键启动时一次性迁移到缓存并清出。