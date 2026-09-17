/**
 * 新功能无头测试 — 播放次数内存缓存 + 睡眠定时器
 * 运行: bun tests/features-test.ts
 *
 * 覆盖:
 *  1. loadPlayCounts 启动载入 plays.toml → playCountOf 内存读
 *  2. playIndex 发起播放 → bumpPlay 落盘 + 内存同步
 *  3. 睡眠定时器: cycleSleep 预设循环 (0→15→30→60→90→0), sleepUntil 设置/清除
 *  4. sleepRemaining 倒计时 / sleepExpired 到点清空
 *
 * 数据隔离: 第一条副作用 import 把 LXM_CACHE_DIR 指向进程专属临时目录,
 * 全程绝不读写用户真实的 ~/.cache/lxmusic/ 与 ~/.config/lxmusic/config.toml。
 */
// 必须第一条: env 设好后再 import player → cache (读 LXM_CACHE_DIR 常量)
import { TEST_CACHE_DIR } from "./features-test-env.ts"
import { rmSync } from "fs"
import { createTestRenderer } from "@opentui/core/testing"
import { Player, SLEEP_PRESETS } from "../src/player"
import { PlayerUI } from "../src/ui"
import { CACHE_DIR, loadPlays, totalPlays } from "../src/cache"
import type { MpvClient, MpvEvent } from "../src/mpv"

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ FAIL: ${label}`); failures++ }
}

// ---------- 确认隔离生效 ----------
check("缓存目录已隔离到临时路径", CACHE_DIR === TEST_CACHE_DIR)

// ---------- fake mpv (与 ui-test 同款哑对象) ----------
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

const p = new Player(fakeMpv)
p.mpvReady = true // 延迟启动: 测试直连, 视为已就绪
p.playlist = ["/m/稻香.mp3", "/m/雾里.flac", "/m/平凡之路.ogg"]
p.musicDir = "/m"
p.queue = [0, 1, 2]

// ---------- 1. 启动空载入 ----------
p.loadPlayCounts()
check("初始 playCountOf 为 0", p.playCountOf("/m/稻香.mp3") === 0)
check("playCountOf(null) 为 0", p.playCountOf(null) === 0)

// ---------- 2. playIndex → 落盘 + 内存同步 ----------
await p.playIndex(0)
await p.playIndex(0)
check("同曲两次播放 playCount=2 (当前歌)", p.playCount === 2 && p.playCountOf("/m/稻香.mp3") === 2)
await p.playIndex(1)
check("另一曲首次播放 playCount=1", p.playCount === 1 && p.playCountOf("/m/雾里.flac") === 1)
check("plays.toml 落盘正确", loadPlays().some((x) => x.path === "/m/稻香.mp3" && x.count === 2))
check("totalPlays 累计 3", totalPlays() === 3)
// 重启模拟: 新 Player + loadPlayCounts 从盘载入
const p2 = new Player(fakeMpv)
p2.loadPlayCounts()
check("重启后内存载入正确", p2.playCountOf("/m/稻香.mp3") === 2 && p2.playCountOf("/m/雾里.flac") === 1)

// ---------- 3. 睡眠定时器预设循环 ----------
check("初始睡眠关闭", p2.sleepUntil === null && p2.sleepMinutes === 0)
// 先给 UI 测试用的 p2 加个播放列表 (播放次数来自磁盘载入: 稻香×2, 雾里×1)
p2.playlist = ["/m/稻香.mp3", "/m/雾里.flac", "/m/平凡之路.ogg"]
p2.queue = [0, 1, 2]
p2.musicDir = "/m"
check("磁盘计数在内存可用", p2.playCountOf("/m/稻香.mp3") === 2)
const m1 = p2.cycleSleep()
check("首次 cycle → 15 分钟", m1 === 15 && p2.sleepMinutes === 15 && p2.sleepUntil !== null)
check("预设顺序正确", SLEEP_PRESETS.join(",") === "0,15,30,60,90")
p2.cycleSleep() // → 30
p2.cycleSleep() // → 60
p2.cycleSleep() // → 90
check("循环到 90 分钟", p2.sleepMinutes === 90)
p2.cycleSleep() // → 0 (关)
check("循环回 0 关闭", p2.sleepMinutes === 0 && p2.sleepUntil === null)
// 反向: 0 ← 90
p2.cycleSleep(-1)
check("反向循环 0→90", p2.sleepMinutes === 90 && p2.sleepUntil !== null)

// ---------- 4. 倒计时与到点 ----------
const before = p2.sleepRemaining()
check("sleepRemaining 为正", before > 0 && before <= 90 * 60)
check("sleepExpired 未到点 false", p2.sleepExpired() === false)
p2.sleepUntil = Date.now() - 1000
check("sleepExpired 到点 true", p2.sleepExpired() === true)
check("到点后定时器清空", p2.sleepUntil === null && p2.sleepExpired() === false)
check("关闭后 remaining 为 0", p2.sleepRemaining() === 0)

// ---------- 清理 ----------
try { rmSync(TEST_CACHE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }

console.log("================ UI 渲染验证 ================")
const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const ui = new PlayerUI(setup.renderer, p2, "latte")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
const frameHas = (sub: string) => setup.captureCharFrame().includes(sub)

// 播放次数行内显示 (稻香播过 2 次)
check("列表行显示播放次数 ♪2", frameHas("稻香.mp3") && frameHas("\uF001 2"))

// 设置视图: 6 行 + 睡眠定时行
p2.sleepMinutes = 0
p2.sleepUntil = null
ui.updatePlaylist()
setup.mockInput.pressKey("4")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("设置视图有睡眠定时行", frameHas("睡眠定时"))
check("设置视图初始睡眠=关闭", frameHas("关闭"))

// z 键切换睡眠定时
setup.mockInput.pressKey("z")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("z 键开启睡眠 15 分钟", p2.sleepMinutes === 15 && p2.sleepUntil !== null)
check("设置行显示 15 分钟", frameHas("15 分钟"))
setup.mockInput.pressEscape()  // 回列表
await setup.renderOnce()

// i 键打开歌曲信息弹层
setup.mockInput.pressKey("i")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("i 键打开信息弹层", ui.showInfo === true && frameHas("歌曲信息"))
check("信息弹层显示已播放行", frameHas("已播放"))
// 任意键关闭
setup.mockInput.pressKey("i")
await setup.renderOnce()
check("再按 i 关闭弹层", ui.showInfo === false)

setup.renderer.destroy()

if (failures > 0) {
  console.log(`\nFEATURES TEST FAILED (${failures})`)
  process.exit(1)
}
console.log("\nFEATURES TEST PASS")