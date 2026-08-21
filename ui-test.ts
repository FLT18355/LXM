/**
 * UI 无头测试 — 用 createTestRenderer 验证界面渲染 + 交互
 * 运行: bun ui-test.ts
 */
import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
import { createTestRenderer, KeyCodes } from "@opentui/core/testing"
import { Player } from "./src/player"
import { PlayerUI } from "./src/ui"
import type { MpvClient, MpvEvent } from "./src/mpv"

// ---------- fake mpv ----------
const handlers: Array<(ev: MpvEvent) => void> = []
const fakeMpv = {
  command: async () => null,
  setProperty: async () => null,
  getProperty: async () => undefined,
  observeProperty: async () => null,
  pause: async () => null,
  seek: async () => null,
  loadfile: async () => null,
  onEvent: (h: (ev: MpvEvent) => void) => {
    handlers.push(h)
    return () => {}
  },
  close: () => {},
  connected: true,
} as unknown as MpvClient

function emit(ev: MpvEvent) {
  for (const h of [...handlers]) h(ev)
}

// ---------- 准备 ----------
const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
p.playlist = [
  "/home/flt18355/音乐/稻香.mp3",
  "/home/flt18355/音乐/绿色-陈雪凝.mp3",
  "/home/flt18355/音乐/反乌托邦-栖云,星尘,海伊.mp3",
  "/home/flt18355/音乐/如愿bili.m4a",
  "/home/flt18355/音乐/雾里bili.m4a",
]
p.musicDir = "/home/flt18355/音乐"
p.queue = [0, 1, 2, 3, 4]
p.favorites = ["/home/flt18355/音乐/稻香.mp3"]
p.lyrics = [
  { time: 0, text: "对这个世界如果你有太多的抱怨" },
  { time: 5, text: "跌倒了就不敢继续往前走" },
  { time: 10, text: "为什么人要这么的脆弱 堕落" },
  { time: 15, text: "请你打开电视看看" },
  { time: 20, text: "多少人为生命在努力勇敢的走下去" },
]
p.playing = true
p.currentPath = p.playlist[0]
p.timePos = 7
p.duration = 231
p.titleTag = "稻香"
p.artistTag = "周杰伦"

const ui = new PlayerUI(setup.renderer, p)
ui.tick()
await setup.renderOnce()
const frame1 = setup.captureCharFrame()
console.log("================ 初始界面 ================")
console.log(frame1)

// ---------- 测试: 播放中 → 切到下一首 ----------
p.idx = 1
p.currentPath = p.playlist[1]
p.titleTag = "绿色"
p.artistTag = "陈雪凝"
p.lyrics = []
p.timePos = 12
p.duration = 200
ui.afterTrackChange()
ui.tick()
await setup.renderOnce()
console.log("================ 播放第二首 (无歌词) ================")
console.log(setup.captureCharFrame())

// ---------- 测试: 搜索 ----------
setup.mockInput.pressKey("/")
ui.tick()
await setup.renderOnce()
setup.mockInput.typeText("稻香")
await setup.renderOnce()
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
console.log("================ 搜索 '稻香' 后 ================")
console.log(setup.captureCharFrame())

// ---------- 测试: 进入搜索浏览模式后 Esc 退出 ----------
setup.mockInput.pressEscape()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
console.log("================ Esc 退出搜索 ================")
console.log(setup.captureCharFrame())

// ---------- 测试: 全屏歌词 (直接调用) ----------
ui.setFullLyrics(true)
await setup.renderOnce()
console.log("================ 全屏歌词 ================")
console.log(setup.captureCharFrame())

// ---------- 测试: 帮助 ----------
ui.showHelp = true; (ui as any).helpOverlay.visible = true; await setup.renderOnce()
console.log("================ 帮助界面 ================")
console.log(setup.captureCharFrame())

setup.renderer.destroy()
console.log("\nALL UI TESTS DONE")