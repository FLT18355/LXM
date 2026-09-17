# 配置与数据文件

## ~/.config/lxmusic/config.toml (src/config.ts)

- 自研 TOML **子集**解析器 (`parseToml`): 只支持顶层 `key = value`
  (字符串/数字/布尔/单行字符串数组), **不支持嵌套表** — 所以歌单放独立文件。
- `saveConfig(patch)` = 读旧 → 合并 → 整文件重写 (带固定头)。写失败静默 ignore。
- 已知键: `music_directory` `favorites[]` `theme` `volume` `speed`。
  (`last_path`/`last_pos` 已迁移到缓存 state.toml)
- 与 Python 版 lxm.py 共用, 保持键名 snake_case, 别改格式。

## ~/.cache/lxmusic/ (缓存目录, src/cache.ts)

运行时状态与可重建数据, **不属于配置**, 随时可清空:

- `state.toml` — 断点续播 `last_path`/`last_pos`。退出 `player.saveState()` 写入,
  启动恢复。旧 config.toml 同名键启动时一次性迁移并清出。
- `scan-cache.toml` — 音乐目录扫描结果 (dir + mtime + files[])。启动用
  `scanner.scanDirectoryCached()`: 目录 mtime 不变则复用, 否则重扫更新。
- `plays.toml` — 播放次数统计 (`[[plays]]` 子表: path + count)。每次 `playIndex`
  发起播放 +1; 导航栏"共播放 N 次"显示总量。启动时全量载入内存
  (`player.loadPlayCounts()`, 见 player.md), 列表行/正在播放卡片/歌曲信息弹层
  都用内存版 `playCountOf`。
- 清空: `bun index.ts cache --clear` 或设置视图缓存行 Enter。
- 环境变量 `LXM_CACHE_DIR` 可重定向 (测试隔离用)。

## ~/.config/lxmusic/playlists.toml (src/playlists.ts)

- `[[playlist]]` + `name` + `paths[]` 极简子集。
- 整文件覆盖写。加载时过滤无名歌单。
- 环境变量 `LXM_PLAYLISTS_FILE` 可重定向 (测试隔离用)。