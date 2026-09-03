// 主题测试: 默认 latte, 循环切换, 树重建正常
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "../src/player"
import { PlayerUI } from "../src/ui"
import { THEME_ORDER, THEMES } from "../src/theme"
import type { MpvClient, MpvEvent } from "../src/mpv"

const handlers: Array<(ev: MpvEvent) => void> = []
const fakeMpv = {
  command: async () => null, setProperty: async () => null, getProperty: async () => undefined,
  observeProperty: async () => null, pause: async () => null, seek: async () => null,
  loadfile: async () => null, onEvent: (h: any) => { handlers.push(h); return () => {} },
  close: () => {}, connected: true,
} as unknown as MpvClient

const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
p.playlist = ["/m/稻香.mp3","/m/雾里.mp3"]
p.musicDir = "/m"
p.queue = [0,1]
p.lyrics = [ {time:0,text:"第一行"}, {time:5,text:"第二行"} ]
const ui = new PlayerUI(setup.renderer, p, "latte")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()

// 1. 默认 latte
console.log("默认主题:", (ui as any).themeName, "背景:", (ui as any).theme.base, "(期望 #eff1f5)")
if ((ui as any).theme.base !== "#eff1f5") { console.log("FAIL: 默认主题错误"); process.exit(1) }

// 2. 循环切换 3 次 → frappe → macchiato → mocha
for (const expect of THEME_ORDER.slice(1)) {
  ui.cycleTheme()
  await setup.renderOnce()
  const name = (ui as any).themeName
  const bg = (ui as any).theme.base
  console.log("切换后:", name, "背景:", bg, `(期望 ${expect} ${THEMES[expect].base})`)
  if (name !== expect) { console.log(`FAIL: 期望 ${expect} 得到 ${name}`); process.exit(1) }
  if (bg !== THEMES[expect].base) { console.log("FAIL: 色值错误"); process.exit(1) }
}

// 3. 再切一次回到 latte
ui.cycleTheme()
await setup.renderOnce()
console.log("回到 latte:", (ui as any).themeName, "(期望 latte)")
if ((ui as any).themeName !== "latte") { console.log("FAIL: 未回到 latte"); process.exit(1) }

// 4. 树重建后界面仍正常渲染
ui.tick()
await setup.renderOnce()
const frame = setup.captureCharFrame()
console.log("重建后渲染完成")

setup.renderer.destroy()
console.log("\nTHEME TEST PASS")
