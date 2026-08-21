// 回归测试: 播放中按回车选歌, 旧文件 end-file(stop) 不应触发自动切歌
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "./src/player"
import { PlayerUI } from "./src/ui"
import type { MpvClient, MpvEvent } from "./src/mpv"

const handlers: Array<(ev: MpvEvent) => void> = []
let loaded: string[] = []
const fakeMpv = {
  command: async (_n: string, ..._a: unknown[]) => null,
  setProperty: async () => null,
  getProperty: async () => undefined,
  observeProperty: async () => null,
  pause: async () => null,
  seek: async () => null,
  loadfile: async (path: string) => { loaded.push(path); return null },
  onEvent: (h: any) => { handlers.push(h); return () => {} },
  close: () => {}, connected: true,
} as unknown as MpvClient
function emit(ev: MpvEvent) { for (const h of [...handlers]) h(ev) }

const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
p.playlist = ["/m/1.mp3","/m/2.mp3","/m/3.mp3","/m/4.mp3","/m/5.mp3"]
p.musicDir = "/m"
p.queue = [0,1,2,3,4]
const ui = new PlayerUI(setup.renderer, p)

// 场景: 正在播第 1 首, 用户选第 3 首回车
p.playing = true
p.currentPath = p.playlist[0]
p.idx = 0
await setup.renderOnce()

ui.sel = 2  // 选中第 3 首
ui.playSel()
await setup.renderOnce()
console.log("按回车后 idx =", p.idx, "(期望 2)")
if (p.idx !== 2) { console.log("FAIL: 切歌失败"); process.exit(1) }

// 旧文件 end-file(stop) 到达 — 此时已抑制, 不应切歌
emit({ event: "end-file", reason: "stop" })
await setup.renderOnce()
console.log("end-file(stop) 后 idx =", p.idx, "(期望仍 2)")
if (p.idx !== 2) { console.log("FAIL: end-file 多米诺发生!"); process.exit(1) }

// 新文件加载完成
emit({ event: "file-loaded" })
await setup.renderOnce()
console.log("file-loaded 后 idx =", p.idx, "(期望 2)")

// 之后自然播完 eof — 应正常切到下一首
emit({ event: "end-file", reason: "eof" })
await new Promise(r => setTimeout(r, 50))
await setup.renderOnce()
const idxAfterEof: number = p.idx
console.log("自然 eof 后 idx =", idxAfterEof, "(期望 3, 即播放第 4 首)")
if (idxAfterEof !== 3) { console.log("FAIL: eof 未正常切歌"); process.exit(1) }
console.log("已加载:", loaded.map(x => x.split("/").pop()).join(", "))

setup.renderer.destroy()
console.log("\nREGRESSION PASS")
