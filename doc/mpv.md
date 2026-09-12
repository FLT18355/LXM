# mpv IPC 协议 (src/mpv.ts)

## 线协议

- 每行一个 JSON。发 `{"command":[...],"request_id":N}\n`;
  含 `request_id` 的是命令响应, 含 `event` 的是事件。
- `command()` 超时 4s 返回 `null` (不抛错); 断线 `flushPending()` 把挂起请求全部 resolve(null)。

## 事件订阅

- `observeProperty(id, name)`, UI 挂了 id 1~4:
  `time-pos` / `duration` / `pause` / `eof-reached`。

## UI 消费事件的位置 (PlayerUI.attachMpvEvents)

- `property-change time-pos` → `p.timePos`; 顺带处理 `pendingSeek` (一次 seek 后清)。
- `property-change duration/pause` → 对应字段。
- `file-loaded` → `p.onFileLoaded()` (解除 end-file 抑制 + 补拉 duration)。
- `end-file` 且 reason ∈ {eof, stop} 且 `!suppressEndFile` → `p.maybeAdvance()` 自动切歌。

## loop-file (单曲循环) — 关键陷阱

- 单曲循环 = `set_property("loop-file","inf")`。
- **mpv ≥ 0.35 的 `loadfile` 命令已删除位置 options 参数**:
  `loadfile URL MODE --opt=val` / 数组 / 对象形式全部 `invalid parameter` (v0.41 实测)。
  任何文件加载参数必须走 `set_property`。
- `loop-file` 是持久属性, 跨 `loadfile` 保持; `maybeAdvance` 的 ONE 分支 (同索引重载)
  是兜底路径, 正常时 loop-file 生效 mpv 无缝循环不发 end-file。