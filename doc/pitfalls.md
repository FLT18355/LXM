# 已知坑与决策记录

| 坑 | 结论 |
|---|---|
| end-file 在切歌瞬间误触发 | suppressEndFile 抑制窗口, 勿删 (见 player.md) |
| favMode 残留导致列表视图只显示收藏 | favMode 严格跟随 view (见 player.md) |
| 重建主题树后按键双响应 | attachGlobalKeys 只挂一次 (见 ui.md) |
| `bun test` 找不到测试 | 用 `bun run test`; 勿改文件名成 `*.test.ts` 引原生 runner |
| README 曾有 menu-test.ts | 不存在的历史遗留, 已删; 再写文档前核对文件真实存在 |
| 歌词同时间戳多行只亮一行 | 已修: 按 `time === curTime` 集合高亮 |
| InputRenderable 宽度动态改 | plDialog 输入框 set-dir 模式加宽到 70, closePlDialog 恢复 40 |
| LRC 空行渲染 | 歌词文件自带空文本时间戳, 播放器忠实显示, 非 bug |
| UPX 压单文件产物报 `SyntaxError: Invalid character: '\0'` | 勿 UPX `dist/lxm-tui`! bun --compile 把模块图作为未压缩 trailer 追加在 ELF 尾部, 运行时经 /proc/self/exe 按偏移读; UPX 只解内存镜像不改磁盘 → trailer 读坏 (`--overlay=copy` 也救不了)。要压缩用 `bun run build:portable` → dist-js/ (运行时外置再 UPX, 实测可用)。`upx -d` 可还原单文件版; `libopentui.so` 压不了 (缺 DT_INIT) |
| `loadfile` 传 options 参数报 `invalid parameter` (mpv ≥ 0.35) | 位置/数组/对象三种形式全被拒, 单曲循环卡死。文件级参数一律 `set_property` (见 mpv.md) |
| scan-cache mtime 校验被"缓存文件写在扫描目录内"打破 | 测试用临时目录兼作扫描目录时, 保存缓存改变目录 mtime → 下轮读取必然失效。loadScanCache 用 500ms 容差吸收; 真实场景 (音乐目录≠缓存目录) 无此问题 |