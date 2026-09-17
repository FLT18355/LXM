# 测试规约

- 全部用 `createTestRenderer` 无头渲染, fake MpvClient (哑对象, `onEvent` 收集 handler 供手动 emit)。
- **playlist-test.ts 的第一条 import 必须是 `./playlist-test-env`** — 模块求值时设置
  `LXM_PLAYLISTS_FILE` 指向进程临时文件, ESM import 顺序保证后续 `player → playlists`
  链读隔离路径, 绝不碰用户真实歌单。移动 import 位置 = 污染主人歌单。
- **cache-test.ts 自建隔离**: 第一条 import 前设置 `LXM_CACHE_DIR` 指向进程临时目录
  (在 import cache 模块之前, 因为 CACHE_DIR 是模块求值常量)。测试用临时目录兼作被扫描
  目录, scan-cache mtime 校验有 500ms 容差, 吸收"缓存文件写在被扫描目录内"的自指抖动。
- 布局就绪需 **两次 `tick()` + `renderOnce()`** — 首帧 `lyricInner.height` 等几何量
  未计算, `updateLyrics` 会早退。验证渲染结果用 `captureCharFrame()` 做文本/缩进断言
  (StyledText 的 `content` 不是纯字符串, `String()` 拿不到)。
- 测试会 `saveConfig` 落盘 (如 speed), 跑之前备份 `~/.config/lxmusic/config.toml`。
- 没有 git 仓库。改动前评估可回滚性, 大改先复制备份。
- 运行: `bun run test` (package.json 链式跑 7 个)。`bun test` 原生 runner **不识别**
  `*-test.ts` 命名, 勿改用。

## 测试文件

| 文件 | 覆盖 |
|---|---|
| ui-test.ts | 无头渲染冒烟 |
| theme-test.ts | 主题循环切换 |
| playlist-test.ts | 歌单 CRUD / 加歌选歌 / 游标对齐 |
| regress-test.ts | end-file 切歌链防多米诺 |
| regress2-test.ts | 搜索/收藏模式下切歌 |
| loop-test.ts | 单曲循环走 set_property, loadfile 不传 options |
| cache-test.ts | 缓存 state 读写 / scan-cache mtime 校验 / clearCache |
| features-test.ts | 播放次数内存缓存 (loadPlayCounts/playIndex 同步) / 睡眠定时器 (cycleSleep/到点) / z 键与信息弹层渲染 |