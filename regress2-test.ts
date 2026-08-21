// 回归测试: 搜索结果选中项播放时应映射到搜索结果, 而非普通列表第 N 首
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "./src/player"
import { PlayerUI } from "./src/ui"
import type { MpvClient, MpvEvent } from "./src/mpv"

const handlers: Array<(ev: MpvEvent) => void> = []
let loaded: string[] = []
const fakeMpv = {
  command: async () => null, setProperty: async () => null, getProperty: async () => undefined,
  observeProperty: async () => null, pause: async () => null, seek: async () => null,
  loadfile: async (path: string) => { loaded.push(path); return null },
  onEvent: (h: any) => { handlers.push(h); return () => {} },
  close: () => {}, connected: true,
} as unknown as MpvClient

const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
// 普通列表: 0 稻香, 1 绿色, 2 反乌托邦, 3 如愿, 4 雾里
p.playlist = ["/m/稻香.mp3","/m/绿色.mp3","/m/反乌托邦.mp3","/m/如愿.m4a","/m/雾里.mp3"]
p.musicDir = "/m"
p.queue = [0,1,2,3,4]
const ui = new PlayerUI(setup.renderer, p)

// 搜索 "雾里" → 结果应只有 queue=[4]
ui.enterSearch()
ui.doSearch("雾里")
await setup.renderOnce()
console.log("搜索结果 queue =", JSON.stringify(p.queue), "(期望 [4])")
if (JSON.stringify(p.queue) !== "[4]") { console.log("FAIL: 搜索异常"); process.exit(1) }

// 选中第一首(唯一结果)回车
ui.sel = 0
ui.playSel()
await new Promise(r => setTimeout(r, 50))
await setup.renderOnce()
const played = loaded.pop()
console.log("播放的 =", played, "(期望 /m/雾里.mp3)")
if (played !== "/m/雾里.mp3") { console.log("FAIL: 播放错误"); process.exit(1) }

// 收藏模式下同样验证: 收藏队列 [1,3] (绿色、如愿), 选中第 2 项(sel=1) → 应播放 如愿
ui.exitSearch(true)
p.favorites = [p.playlist[1], p.playlist[3]]
p.toggleFavMode()
await setup.renderOnce()
ui.sel = 1
ui.playSel()
await new Promise(r => setTimeout(r, 50))
await setup.renderOnce()
const played2 = loaded.pop()
console.log("收藏模式播放的 =", played2, "(期望 /m/如愿.m4a)")
if (played2 !== "/m/如愿.m4a") { console.log("FAIL: 收藏模式错误"); process.exit(1) }

setup.renderer.destroy()
console.log("\nREGRESSION2 PASS")
