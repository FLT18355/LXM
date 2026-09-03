/**
 * 歌单功能无头测试 — 用 createTestRenderer 验证歌单 UI 全流程
 * 运行: bun playlist-test.ts
 *
 * 覆盖:
 *  1. P 键打开歌单列表
 *  2. n 新建歌单 (弹层输入名)
 *  3. Enter 进入歌单详情 (并验证 plMode 正确关闭 — 修复 Enter 弹回 bug)
 *  4. a 进入加歌选歌模式, Enter 把选中歌加入歌单
 *  4.5 歌单内播放: 详情页 Enter 应播所选曲, 不弹回第一首
 *  5. x 移除歌曲
 *  6. r 重命名 / d 删除歌单
 *  7. Esc 逐级返回
 *  8. 持久化: 临时 playlists.toml 落盘内容正确
 *
 * 数据隔离: 第一条副作用 import 把歌单文件指向进程专属临时路径,
 * 全程绝不读写用户真实的 ~/.config/lxmusic/playlists.toml。
 */
// 必须第一条: 设好 env 后, 下面的 player→playlists 静态 import 才会读到临时路径
import { TEST_PLAYLISTS_FILE } from "./playlist-test-env.ts"
import { existsSync, readFileSync, rmSync } from "fs"
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "./src/player"
import { PlayerUI } from "./src/ui"
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

// ---------- 确认隔离生效 ----------
check("歌单文件已隔离到临时路径", PLAYLISTS_FILE === TEST_PLAYLISTS_FILE)

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

// 渲染快照里是否含某文本 — 用公开渲染结果替代对私有节点的强转读取
function frameHas(substr: string): boolean {
  return setup.captureCharFrame().includes(substr)
}

// ---------- 1. P 键打开歌单列表 ----------
setup.mockInput.pressKey("P")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("P 键打开歌单列表 (view=pl)", ui.view === "pl" && ui.plLevel === "list")
console.log("================ 歌单列表 (空) ================")
console.log(setup.captureCharFrame())

// ---------- 2. n 新建歌单 ----------
setup.mockInput.pressKey("n")
await setup.renderOnce()
check("弹出新建弹层 (plDialogMode=new)", ui.plDialogMode === "new")
check("弹层已渲染", frameHas("新建歌单"))
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

// ---------- 3. Enter 进入详情 (空歌单) — 同时验证 plMode 被关闭 ----------
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("进入歌单详情 (plLevel=detail)", ui.view === "pl" && ui.plLevel === "detail")
check("详情态仍留在歌单视图 (view=pl)", ui.view === "pl")
console.log("================ 歌单详情 (空) ================")
console.log(setup.captureCharFrame())

// ---------- 4. a 加歌选歌 → Enter 加入 (加完自动下移, 连续加入) ----------
setup.mockInput.pressKey("a")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("进入加歌选歌模式 (plPickerMode)", ui.plPickerMode === true)
check("仍留歌单详情 (plLevel=detail)", ui.view === "pl" && ui.plLevel === "detail")
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
check("Esc 退出选歌模式回详情", ui.plPickerMode === false && ui.view === "pl" && ui.plLevel === "detail")
console.log("================ 歌单详情 (2 首) ================")
console.log(setup.captureCharFrame())

// ---------- 4.5 歌单内播放: 详情页选第 2 首 Enter, 不应弹回第 1 首 ----------
setup.mockInput.pressKey("ARROW_DOWN")  // 选到第 2 首 (平凡之路)
await setup.renderOnce()
setup.mockInput.pressEnter()            // 播放 → 关闭详情, 主视图 sel 对齐到该曲
await Bun.sleep(30)  // 等 playIndex 异步链 (.then 里 setView 退列表) 完成
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("详情页 Enter 后退回列表视图", ui.view === "list")
check("主视图 sel 对齐到实际播放曲的 playlist 索引", ui.sel === p.playlist.indexOf(TRACKS[2]))
check("正在播放的是所选第 2 首 (未弹回)", p.currentPath === TRACKS[2])

// ---------- 5. x 移除歌曲 (重新进详情, 移除第 1 首 = 雾里) ----------
setup.mockInput.pressKey("P")
await setup.renderOnce()
setup.mockInput.pressEnter()  // 进详情
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("重新进入详情 sel=0", ui.view === "pl" && ui.plLevel === "detail" && ui.sel === 0)
setup.mockInput.pressKey("x")  // 移除第 1 首 (雾里)
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("移除后只剩 1 首", p.playlists[0].paths.length === 1 && p.playlists[0].paths[0] === TRACKS[2])

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
check("歌单已写入临时 playlists.toml", onDisk.includes("夜跑专用"))
check("歌曲路径正确写入", onDisk.includes(TRACKS[2]))

// ---------- 8. d 删除歌单 ----------
setup.mockInput.pressKey("d")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("歌单已删除", p.playlists.length === 0)
check("列表显示为空", frameHas("共 0 个"))
console.log("================ 删除后歌单列表 ================")
console.log(setup.captureCharFrame())

// ---------- 9. Esc 关闭歌单列表 ----------
setup.mockInput.pressEscape()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("Esc 关闭歌单列表 (view=list)", ui.view === "list")

// ---------- 10. 清理临时文件 ----------
try { rmSync(TEST_PLAYLISTS_FILE, { force: true }) } catch { /* ignore */ }

setup.renderer.destroy()
if (failures > 0) {
  console.log(`\nPLAYLIST TEST: ${failures} FAILURES`)
  process.exit(1)
}
console.log("\nPLAYLIST TEST PASS")
