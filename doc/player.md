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

## 播放次数内存缓存 (playCounts)

- `loadPlays()` 在启动时 (index.ts) 全量载入 `plays.toml` 到 `playCounts: Map<path, count>`,
  UI 行内显示用 `playCountOf(path)` (内存读, 不逐首读盘)。
- `playIndex()` 每次发起播放 `bumpPlay(path)` 落盘后同步 `playCounts.set(path, n)`,
  内存与 plays.toml 始终一致。`toggleFavorite`/`refreshDir` 不影响计数 (绝对路径键)。

## 睡眠定时器 (sleepUntil/sleepMinutes)

- `SLEEP_PRESETS = [0, 15, 30, 60, 90]` (0 = 关闭); `cycleSleep(dir)` 循环切换预设。
- `sleepUntil` 是绝对毫秒时间戳; 到点由 UI tick 的 `sleepExpired()` 检测 →
  自动暂停 (`mpv.pause(true)`), 清空定时器; 定时器状态**不持久化** (重启即失效)。
- 头部 `headRightText` 显示 `⏰ mm:ss` 剩余倒计时; 设置视图第 4 行 ←/→ 或全局 `z` 切换。

## 歌词延迟 (lyricDelay)

- `lyricDelay` (秒, **-5~5**, 步进 0.25 取整) `setLyricDelay(d)` clamp; 启动从 config `lyric_delay` 恢复。
- UI 歌词匹配用 `timePos - lyricDelay` 作为基准时间 (小窗 + 全屏一致):
  延迟 > 0 → 歌词滞后于声音 (字幕偏快时往后调正数); 延迟 < 0 → 歌词提前; 0 = 同步。
- 持久化 `saveConfig({ lyric_delay })`; 纯 UI 层逻辑, 不触碰 mpv。

## 歌曲文件操作 (renameTrack / deleteTrack)

UI 的 `R`/`D` 直接改**磁盘文件**, 所以路径键的数据结构必须一次性全部跟着搬。绝对路径
到处都是 (playlist / queue 只是下标 / favorites / playlists.toml / plays.toml /
durations.toml / state.toml / scan-cache.toml / 内存 playCounts+durations), 漏一处就是脏数据。

- `renameTrack(oldPath, newBase)`: 校验 (空名 / 含 `/` `\` NUL / `.` `..` / 同名 / 目标已存在)
  → `renameSync` 本体 → 同名 `.lrc` 一起改名 (保留 `.lrc`/`.LRC` 大小写) → 同步
  playlist / currentPath (+`saveCacheState({last_path})`) / favorites (+saveConfig) /
  playlists (+savePlaylists) / 内存 playCounts+durations (键搬迁, 计数相加) /
  `renameTrackData` (plays.toml + durations.toml) / `renameInScanCache`。
  **扩展名沿用原文件**; 同目录就地改名, 不重排 playlist 顺序 (`d` 重扫才重排)。
- `deleteTrack(path)`: 删本体 → 删同名 `.lrc` → 若 `currentPath === path` 先 `stopPlayback()`
  → `removePlaylistIndex(k)` → `totalPlayCount -= 该曲计数` → 清 favorites / playlists /
  内存计数+时长 / `dropTrackData` / `dropFromScanCache`。
- `removePlaylistIndex(k)`: `queue` 过滤掉 k 并把大于 k 的下标统一 -1 (随机/收藏顺序保持),
  `idx` 跟随修正。**不要在别处手写这段重编号**。
- `stopPlayback()`: 删正在播的曲时用。复用 `suppressEndFile` 抑制窗口 (stop 也会发
  end-file) → 否则会被当成自然播完而自动跳下一首; mpv `command("stop")` + 清空播放状态。
- `findLrc` 已改为同步 (`src/lrc.ts`), 因为改名/删除要在同一同步流程里处理歌词文件。

## 时长缓存 (durations)

- `durations: Map<path, 秒>` — 列表右侧显示每首时长用; 未知显示 `--`。
- **持久化** `~/.cache/lxmusic/durations.toml` (`[[durations]]`): 启动 `loadDurations()`
  载入, 命中即直接显示; 仅对缺失项后台探测, 免每次重算。
- 两条回填路径: (1) 播放时 mpv `duration` property-change / `get_property` → `noteDuration`
  (见 ui.ts attachMpvEvents); (2) 启动后 `src/duration.ts` 的 `probeDurations` 用独立
  mpv 实例串行探测**缺失项**, 逐首 `onDurationsUpdated` 通知 UI 刷新 (不阻塞)。
- `noteDuration` 幂等 (值不变不写盘/不回调) 并 `saveDuration` 落盘; `durationOf(path)` 读取
  (多处调用, 见 ui.md)。