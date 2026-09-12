# 蓝汐音乐 (lxm-tui) — 开发文档入口

> 改代码前先读对应专题文档; 改完若行为契约有变, 同步更新对应文档。
> 版本: r-0.2 (index.ts HELP / `--version` / package.json 三处一致)

## 文档索引 (按需读, 别整读)

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 架构总览: 目录结构 / 构建 / 启动流程 |
| [player.md](player.md) | Player 核心模型: queue 索引 / suppressEndFile / 淡入淡出 / favMode / loop-file |
| [mpv.md](mpv.md) | mpv IPC 协议: 线协议 / 事件消费 / loadfile 陷阱 |
| [ui.md](ui.md) | UI 架构 (改 ui.ts 前必读): 状态机 / 渲染管线 / 按键路由 / 主题重建 |
| [data.md](data.md) | 配置与数据文件: config.toml / 缓存 state.toml / playlists.toml |
| [testing.md](testing.md) | 测试规约: 隔离 / 渲染断言 / 测试文件表 |
| [pitfalls.md](pitfalls.md) | 已知坑与决策记录 (UPX / loadfile / favMode / scan-cache 等) |

## 快速命令

```bash
bun index.ts [音乐目录]      # 启动
bun index.ts config [--music-directory DIR]   # 配置
bun index.ts cache [--clear] # 缓存查看/清空
bun run test                 # 7 个测试全绿
bunx tsc --noEmit            # 类型检查 (TS5097 扩展名告警可忽略)
bun run build:portable       # 重建 dist-js/ 产物 (源码改动后必须)
```

## 改代码最小阅读集

- 改播放逻辑 → [player.md](player.md) + [mpv.md](mpv.md)
- 改界面 → [ui.md](ui.md) (+ [player.md](player.md) 的 queue/favMode 不变量)
- 改持久化/数据 → [data.md](data.md)
- 新功能动测试 → [testing.md](testing.md)
- 验证: `bunx tsc --noEmit` + `bun run test` + `bun index.ts -v` + `bun index.ts cache`