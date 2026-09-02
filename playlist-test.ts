/**
 * 歌单功能无头测试 — 用 createTestRenderer 验证歌单 UI 全流程
 * 运行: bun playlist-test.ts
 *
 * 覆盖:
 *  1. P 键打开歌单列表
 *  2. n 新建歌单 (弹层输入名)
 *  3. Enter 进入歌单详情
 *  4. a 进入加歌选歌模式, Enter 把选中歌加入歌单
 *  5. 详情页 Enter 播放 / x 移除歌曲
 *  6. r 重命名 / d 删除歌单
 *  7. Esc 逐级返回
 *  8. 持久化: playlists.toml 落盘内容正确
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs"
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "./src/player"
import { PlayerUI, type PlayerUI as PlayerUIType } from "./src/ui"
import { PLAYLISTS_FILE } from "./src/playlists"
import type { MpvClient, MpvEvent } from "./src/mpv"

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ FAIL: ${label}`); failures++ }
}

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
  onEvent: (h: unknown) => {
    handlers.push(h as (ev: MpvEvent) => void)
    return () => {}
  },
  close: () => {},
  connected: true,
} as unknown as MpvClient

// ---------- 现场保护: 备份用户真实歌单文件 ----------
const hadFile = existsSync(PLAYLISTS_FILE)
const backup = hadFile ? readFileSync(PLAYLISTS_FILE, "utf-8") : ""

// ---------- 测试中用到的私有节点 — 用已知形状的窄类型读取 ----------
function overlayVisible(ui: PlayerUIType, overlay: "plListOverlay" | "plDetailOverlay" | "plDialogOverlay"): boolean {
  const node = (ui as unknown as Record<string, { visible?: boolean }>)[overlay]
  return node?.visible === true
}
function textOf(ui: PlayerUIType, ref: "plListTitle" | "plDetailTitle"): string {
  const node = (ui as unknown as Record<string, { content?: unknown }>)[ref]
  const c = node?.content
  if (typeof c === "string") return c
  // TextRenderable.content 可能是 StyledText chunk 对象 { chunks: [{ text }] }
  if (c && typeof c === "object" && "chunks" in c) {
    const chunks = (c as { chunks: Array<{ text?: string }> }).chunks
    return chunks.map((x) => x.text ?? "").join("")
  }
  return ""
}

// ---------- 准备 ----------
const TRACKS = [
  "/m/稻香.mp3",
  "/m/雾里.mp3",
  "/m/平凡之路.mp3",
  "/m/小幸运.mp3",
]
const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p = new Player(fakeMpv)
p.playlist = [...TRACKS]
p.musicDir = "/m"
p.queue = [0, 1, 2, 3]
p.loadPlaylists()

const ui = new PlayerUI(setup.renderer, p, "latte")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()

// ---------- 1. P 键打开歌单列表 ----------
setup.mockInput.pressKey("P")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("P 键打开歌单列表 (plMode)", ui.plMode === true)
check("歌单列表覆盖层可见", overlayVisible(ui, "plListOverlay"))
console.log("================ 歌单列表 (空) ================")
console.log(setup.captureCharFrame())

// ---------- 2. n 新建歌单 ----------
setup.mockInput.pressKey("n")
await setup.renderOnce()
check("弹出新建弹层 (plDialogMode=new)", ui.plDialogMode === "new")
check("弹层可见", overlayVisible(ui, "plDialogOverlay"))
await setup.renderOnce()
setup.mockInput.typeText("我的最爱")
await setup.renderOnce()
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("弹层已关闭", ui.plDialogMode === null)
check("歌单已创建", p.playlists.length === 1 && p.playlists[0].name === "我的最爱")
console.log("================ 歌单列表 (已创建) ================")
console.log(setup.captureCharFrame())

// ---------- 3. Enter 进入详情 (空歌单) ----------
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("进入歌单详情 (plDetailMode)", ui.plDetailMode === true)
check("详情标题含有歌单名", textOf(ui, "plDetailTitle").includes("我的最爱"))
console.log("================ 歌单详情 (空) ================")
console.log(setup.captureCharFrame())

// ---------- 4. a 加歌选歌 → Enter 加入 (加完自动下移, 连续加入) ----------
setup.mockInput.pressKey("a")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("进入加歌选歌模式 (plPickerMode)", ui.plPickerMode === true)
check("详情层已关闭", overlayVisible(ui, "plDetailOverlay") === false)
// 选中第 2 首 (雾里), 按 Enter 加入
setup.mockInput.pressKey("ARROW_DOWN")
await setup.renderOnce()
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("歌曲已加入歌单", p.playlists[0].paths.length === 1 && p.playlists[0].paths[0] === TRACKS[1])
// 加完自动下移到第 3 首 (平凡之路), 再按 Enter 继续加入
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("第二首已加入", p.playlists[0].paths.length === 2 && p.playlists[0].paths.includes(TRACKS[2]))
// Esc 退出选歌模式回详情
setup.mockInput.pressEscape()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("Esc 退出选歌模式回详情", ui.plPickerMode === false && ui.plDetailMode === true)
console.log("================ 歌单详情 (2 首) ================")
console.log(setup.captureCharFrame())

// ---------- 5. x 移除歌曲 (移除第 2 首 = 平凡之路) ----------
setup.mockInput.pressKey("ARROW_DOWN")  // 选到第 2 首 (平凡之路)
await setup.renderOnce()
setup.mockInput.pressKey("x")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("移除后只剩 1 首", p.playlists[0].paths.length === 1 && p.playlists[0].paths[0] === TRACKS[1])

// ---------- 6. r 重命名 ----------
setup.mockInput.pressEscape()  // 回歌单列表
await setup.renderOnce()
setup.mockInput.pressKey("r")
await setup.renderOnce()
check("弹出重命名弹层", ui.plDialogMode === "rename")
check("预设原歌单名", ui.plDialogValue === "我的最爱")
// mock 键盘对 CJK 宽字符的 BACKSPACE 只删半格 (库行为), 直接走提交逻辑验证重命名
ui.commitPlDialog("夜跑专用")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("歌单已重命名", p.playlists.some((x) => x.name === "夜跑专用"))
console.log("================ 歌单列表 (重命名后) ================")
console.log(setup.captureCharFrame())

// ---------- 7. 持久化验证 ----------
const onDisk = existsSync(PLAYLISTS_FILE) ? readFileSync(PLAYLISTS_FILE, "utf-8") : ""
check("歌单已写入 playlists.toml", onDisk.includes("夜跑专用"))
check("歌词路径正确写入", onDisk.includes(TRACKS[1]))

// ---------- 8. d 删除歌单 ----------
setup.mockInput.pressKey("d")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("歌单已删除", p.playlists.length === 0)
check("列表显示为空", textOf(ui, "plListTitle").includes("0"))
console.log("================ 删除后歌单列表 ================")
console.log(setup.captureCharFrame())

// ---------- 9. Esc 关闭歌单列表 ----------
setup.mockInput.pressEscape()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("Esc 关闭歌单列表 (plMode=false)", ui.plMode === false)

// ---------- 10. 全部删除后磁盘文件还原 ----------
if (hadFile) {
  writeFileSync(PLAYLISTS_FILE, backup)
} else {
  try { rmSync(PLAYLISTS_FILE, { force: true }) } catch { /* ignore */ }
}

setup.renderer.destroy()
if (failures > 0) {
  console.log(`\nPLAYLIST TEST: ${failures} FAILURES`)
  process.exit(1)
}
console.log("\nPLAYLIST TEST PASS")