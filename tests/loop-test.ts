// 回归测试: 单曲循环 — loop-file 必须用 set_property 设置, loadfile 不传 options
// (mpv >= 0.35 的 loadfile 已移除位置 options 参数, 传 --loop-file=inf 会 invalid parameter → 卡死)
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "../src/player"
import { PlayerUI } from "../src/ui"
import type { MpvClient } from "../src/mpv"

const props: Array<[string, unknown]> = []
const handlers: Array<(ev: any) => void> = []
let loadedArgs: Array<{ path: string; rest: unknown[] }> = []
const fakeMpv = {
  command: async () => null,
  setProperty: async (name: string, value: unknown) => { props.push([name, value]); return null },
  getProperty: async () => undefined,
  observeProperty: async () => null,
  pause: async () => null,
  seek: async () => null,
  loadfile: async (path: string, ...rest: unknown[]) => { loadedArgs.push({ path, rest: [...rest] }); return null },
  onEvent: (h: any) => { handlers.push(h); return () => {} },
  close: () => {}, connected: true,
} as unknown as MpvClient

const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
p.mpvReady = true // 延迟启动: 测试直连, 视为已就绪
p.playlist = ["/m/1.mp3","/m/2.mp3","/m/3.mp3"]
p.musicDir = "/m"
p.queue = [0,1,2]
const ui = new PlayerUI(setup.renderer, p)

// 场景 1: 单曲循环模式下播放 → loadfile 必须无多余参数, 且 loop-file 设为 inf
// 默认 OFF, 从 OFF 真实调用 cycleRepeat 两次到 ONE (REPEAT_CYCLE = [OFF, ALL, ONE])
p.cycleRepeat()  // OFF -> ALL
p.cycleRepeat()  // ALL -> ONE
await p.playIndex(1)
console.log("repeat =", p.repeat, "(期望 ONE)")
if (p.repeat !== "ONE") { console.log("FAIL: 未进入 ONE 模式"); process.exit(1) }
console.log("loadfile 参数 =", JSON.stringify(loadedArgs[0]), "(期望无 --loop-file 位置参数)")
const hasOpt = loadedArgs.some((a) => a.rest.some((x) => typeof x === "string" && x.startsWith("--")))
if (hasOpt) { console.log("FAIL: loadfile 仍传了位置 options"); process.exit(1) }
const loopInf = props.filter(([n, v]) => n === "loop-file" && v === "inf").length
console.log("setProperty loop-file=inf 次数 =", loopInf, "(期望 >= 1)")
if (loopInf < 1) { console.log("FAIL: 未设置 loop-file=inf"); process.exit(1) }

// 场景 2: 切到非循环 → loop-file 应设为 no
props.length = 0
p.cycleRepeat()  // ONE -> OFF
const repAfter: string = p.repeat
console.log("cycleRepeat 后 repeat =", repAfter, "(期望 OFF)")
if (repAfter !== "OFF") { console.log("FAIL: cycleRepeat 未切换"); process.exit(1) }
const loopNo = props.filter(([n, v]) => n === "loop-file" && v === "no").length
console.log("setProperty loop-file=no 次数 =", loopNo, "(期望 >= 1)")
if (loopNo < 1) { console.log("FAIL: 切出 ONE 未复位 loop-file"); process.exit(1) }

// 场景 3: 自然 eof 时 ONE 分支仍能命中 playIndex 兜底 (loop-file 万一失效也不卡死)
props.length = 0
loadedArgs = []
p.repeat = "ONE"
p.idx = 2
await p.maybeAdvance()
console.log("maybeAdvance(ONE) 重载 =", loadedArgs.length, "次 (期望 1), idx =", p.idx, "(期望 2)")
if (loadedArgs.length !== 1 || p.idx !== 2) { console.log("FAIL: ONE 兜底重播失效"); process.exit(1) }

setup.renderer.destroy()
console.log("\nLOOP PASS")