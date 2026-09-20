/**
 * 歌曲文件操作无头测试 — 重命名 (R) / 删除 (D)
 * 运行: bun tests/track-ops-test.ts
 *
 * 覆盖:
 *  1. renameTrack: 真实文件改名 + playlist/favorites/playlists/plays/durations/state/scan-cache 全链路同步
 *  2. renameTrack 失败分支: 空名 / 含路径分隔符 / 同名 / 目标已存在 (文件一律不动)
 *  3. deleteTrack: 删文件 + queue/idx 重编号 + 计数回落 + 各持久化清理 + 正播曲停播
 *  4. 子目录内的文件: 根目录 mtime 不变时扫描缓存也必须同步 (幽灵条目回归防线)
 *  5. UI: R 弹层改名 · D 确认弹层 (Esc 取消 / Enter 删除) · 设置视图不响应
 *
 * 数据隔离: 第一条 import 把缓存目录/歌单文件/配置文件/音乐目录全指向临时路径,
 * 本测试真的会改名删文件, 绝不碰主人真实音乐库。
 */
import { TEST_MUSIC_DIR, TEST_ROOT, TEST_CONFIG_FILE, TEST_CACHE_DIR } from "./track-ops-test-env.ts"
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { createTestRenderer } from "@opentui/core/testing"
import { Player } from "../src/player"
import { PlayerUI } from "../src/ui"
import { CACHE_DIR, loadDurations, loadPlays, loadState, saveScanCache } from "../src/cache"
import { scanDirectory, scanDirectoryCached } from "../src/scanner"
import { CONFIG_FILE } from "../src/config"
import { PLAYLISTS_FILE } from "../src/playlists"
import type { MpvClient, MpvEvent } from "../src/mpv"

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    console.log(`  ✗ FAIL: ${label}`)
    failures++
  }
}

// ---------- fake mpv (记录 stop 等命令) ----------
const handlers: Array<(ev: MpvEvent) => void> = []
const commands: string[][] = []
const fakeMpv = {
  command: async (name: string, ...args: unknown[]) => {
    commands.push([name, ...args.map(String)])
    return null
  },
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
check("缓存目录已隔离", CACHE_DIR === TEST_CACHE_DIR)
check("配置文件已隔离", CONFIG_FILE === TEST_CONFIG_FILE)
check("歌单文件已隔离", PLAYLISTS_FILE === join(TEST_ROOT, "playlists.toml"))

// ---------- 准备 ----------
const A = join(TEST_MUSIC_DIR, "稻香.mp3")
const A2 = join(TEST_MUSIC_DIR, "稻香remix.mp3")
const B = join(TEST_MUSIC_DIR, "雾里.flac")
const C = join(TEST_MUSIC_DIR, "sub", "平凡之路.ogg")
const C2 = join(TEST_MUSIC_DIR, "sub", "平凡之路2.ogg")

const p = new Player(fakeMpv)
p.mpvReady = true
p.playlist = [A, B, C]
p.musicDir = TEST_MUSIC_DIR
p.queue = [0, 1, 2]
p.favorites = [A, C]
p.createPlaylist("测试")
p.addTrackToPlaylist("测试", A)
p.addTrackToPlaylist("测试", C)
await p.playIndex(2) // C 播 1 次
await p.playIndex(0) // A 播 1 次; currentPath = A
p.noteDuration(A, 200)
p.noteDuration(C, 180)
p.saveState() // state.toml: last_path = A
saveScanCache(TEST_MUSIC_DIR, await scanDirectory(TEST_MUSIC_DIR))

check("前置: 计数已落盘", loadPlays().some((x) => x.path === A && x.count === 1))
check("前置: 断点续播指向 A", loadState().last_path === A)
check("前置: 同名 .lrc 存在", existsSync(join(TEST_MUSIC_DIR, "稻香.lrc")))

// ---------- 1. renameTrack 全链路 ----------
const r1 = p.renameTrack(A, "稻香remix")
check("renameTrack 返回成功 + 新路径", r1.ok === true && r1.newPath === A2)
check("磁盘: 新名存在 / 旧名消失", existsSync(A2) && !existsSync(A))
check("同名 .lrc 一并改名", existsSync(join(TEST_MUSIC_DIR, "稻香remix.lrc")) && !existsSync(join(TEST_MUSIC_DIR, "稻香.lrc")))
check("playlist 路径已更新", p.playlist[0] === A2 && !p.playlist.includes(A))
check("currentPath 跟随改名", p.currentPath === A2)
check("favorites 跟随改名", p.favorites.includes(A2) && !p.favorites.includes(A))
check("歌单路径跟随改名", p.playlists[0].paths.includes(A2) && !p.playlists[0].paths.includes(A))
check("内存播放次数跟随改名", p.playCountOf(A2) === 1 && p.playCountOf(A) === 0)
check("内存时长跟随改名", p.durationOf(A2) === 200 && p.durationOf(A) === 0)
check(
  "plays.toml 键已改名",
  loadPlays().some((x) => x.path === A2 && x.count === 1) && !loadPlays().some((x) => x.path === A),
)
check("durations.toml 键已改名", loadDurations().some((x) => x.path === A2 && x.dur === 200))
check("state.toml 断点续播已改名", loadState().last_path === A2)
check("favorites 已写回隔离的 config.toml", readFileSync(CONFIG_FILE, "utf-8").includes(A2))
check("playlists.toml 已写回新路径", readFileSync(PLAYLISTS_FILE, "utf-8").includes(A2))
check("扫描缓存已同步 (仍能列出新名)", (await scanDirectoryCached(TEST_MUSIC_DIR)).includes(A2))

// ---------- 2. renameTrack 失败分支 (文件必须不动) ----------
const placed = join(TEST_MUSIC_DIR, "占位.mp3")
writeFileSync(placed, "dummy") // 制造一个 .mp3 同名目标 (A2 扩展名也是 .mp3)
const bad = [
  ["空名", "   "],
  ["含路径分隔符", "a/b"],
  ["同名", "稻香remix"],
  ["目标已存在", "占位"],
] as const
for (const [label, name] of bad) {
  const r = p.renameTrack(A2, name)
  check(`重命名拒绝: ${label}`, r.ok === false && r.error !== undefined)
}
check("失败分支未动任何文件", existsSync(A2) && readFileSync(placed, "utf-8") === "dummy")
check("源文件不存在时报错", p.renameTrack(join(TEST_MUSIC_DIR, "不存在.mp3"), "x").ok === false)

// ---------- 3. deleteTrack: 队列重编号 + 计数回落 + 正播曲停播 ----------
const p2 = new Player(fakeMpv)
p2.mpvReady = true
p2.playlist = [A2, B, C]
p2.musicDir = TEST_MUSIC_DIR
p2.queue = [2, 0, 1] // 模拟随机顺序 (C, A2, B)
p2.idx = 1 // 真实下标 1 = B
p2.favorites = [B]
p2.createPlaylist("删测试")
p2.addTrackToPlaylist("删测试", B)
p2.addTrackToPlaylist("删测试", C)
await p2.playIndex(1) // B 播 1 次; 停不下来也没关系
await p2.playIndex(1) // B 播 2 次; currentPath = B, playing = true
p2.noteDuration(B, 111)
const totalBefore = p2.totalPlayCount

const r2 = p2.deleteTrack(B)
check("deleteTrack 返回成功", r2.ok === true)
check("磁盘文件已删除", !existsSync(B))
check("playlist 移除后顺序不变", p2.playlist.length === 2 && p2.playlist[0] === A2 && p2.playlist[1] === C)
check("queue 下标重编号 [2,0,1] → [1,0]", p2.queue.join(",") === "1,0")
check("idx 修正到同位置 (指向 C)", p2.idx === 1 && p2.playlist[p2.idx] === C)
check("正播曲删除 → 停播清状态", p2.playing === false && p2.currentPath === null && p2.playCount === 0)
check("已通知 mpv stop", commands.some((c) => c[0] === "stop"))
check("suppressEndFile 抑制 end-file (防自动切歌)", p2.suppressEndFile === true)
check("favorites 已移除", p2.favorites.length === 0)
check("歌单已移除该曲", p2.playlists[0].paths.join(",") === C)
check("内存计数/时长已清", p2.playCountOf(B) === 0 && p2.durationOf(B) === 0)
check("totalPlayCount 回落 2", p2.totalPlayCount === totalBefore - 2)
check("plays.toml 条目已清", !loadPlays().some((x) => x.path === B))
check("durations.toml 条目已清", !loadDurations().some((x) => x.path === B))
check("playlists.toml 已移除该曲", !readFileSync(PLAYLISTS_FILE, "utf-8").includes(B))
check("删除不存在的文件报错", p2.deleteTrack(B).ok === false)
check("同曲二次删除不重复扣计数", p2.totalPlayCount === totalBefore - 2)

// ---------- 4. 子目录内文件: 根 mtime 不变时扫描缓存也要同步 ----------
saveScanCache(TEST_MUSIC_DIR, await scanDirectory(TEST_MUSIC_DIR))
const r3 = p2.renameTrack(C, "平凡之路2")
check("子目录改名成功", r3.ok === true && existsSync(C2) && !existsSync(C))
const listed = await scanDirectoryCached(TEST_MUSIC_DIR)
check("扫描缓存已同步改名 (无幽灵旧条目)", listed.includes(C2) && !listed.includes(C))
p2.deleteTrack(C2)
const listed2 = await scanDirectoryCached(TEST_MUSIC_DIR)
check("扫描缓存与磁盘实际内容一致 (删除后)", listed2.join("|") === (await scanDirectory(TEST_MUSIC_DIR)).join("|"))
check("子目录内不留残余文件", !existsSync(C) && !existsSync(C2))

// ---------- 5. UI: R 重命名 / D 删除确认 ----------
const U = join(TEST_MUSIC_DIR, "ui-歌.mp3")
const U2 = join(TEST_MUSIC_DIR, "ui-新歌.mp3")
writeFileSync(U, "dummy")
const setup = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
const p3 = new Player(fakeMpv)
p3.mpvReady = true
p3.playlist = [U]
p3.musicDir = TEST_MUSIC_DIR
p3.queue = [0]
const ui = new PlayerUI(setup.renderer, p3, "latte")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
const frameHas = (sub: string) => setup.captureCharFrame().includes(sub)

setup.mockInput.pressKey("R")
await setup.renderOnce()
check("R 打开重命名歌曲弹层", ui.plDialogMode === "rename-song" && ui.pendingSongPath === U)
check("弹层预填当前歌名", ui.plDialogValue === "ui-歌")
check("弹层已渲染", frameHas("重命名歌曲"))
ui.commitPlDialog("ui-新歌")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("弹层已关闭", ui.plDialogMode === null && ui.pendingSongPath === null)
check("文件已改名", existsSync(U2) && !existsSync(U))
check("列表跟随新名", p3.playlist[0] === U2 && frameHas("ui-新歌"))

setup.mockInput.pressKey("D")
await setup.renderOnce()
check("D 打开确认弹层", ui.confirmAction !== null)
check("确认弹层已渲染", frameHas("确认") && frameHas("删除"))
setup.mockInput.pressEscape()
await setup.renderOnce()
check("Esc 取消确认 (文件保留)", ui.confirmAction === null && existsSync(U2))

setup.mockInput.pressKey("D")
await setup.renderOnce()
setup.mockInput.pressEnter()
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("Enter 确认后文件已删除", !existsSync(U2))
check("playlist 已清空", p3.playlist.length === 0)
check("空列表不崩 (sel=0)", ui.sel === 0)

setup.mockInput.pressKey("4")
await setup.renderOnce()
ui.tick()
await setup.renderOnce()
check("已切到设置视图", ui.view === "settings")
setup.mockInput.pressKey("R")
await setup.renderOnce()
check("设置视图 R 不弹层", ui.plDialogMode === null && ui.msg.includes("没有可重命名"))
setup.mockInput.pressKey("D")
await setup.renderOnce()
check("设置视图 D 不弹确认", ui.confirmAction === null && ui.msg.includes("没有可删除"))

setup.renderer.destroy()
try {
  rmSync(TEST_ROOT, { recursive: true, force: true })
} catch {
  /* ignore */
}

if (failures > 0) {
  console.log(`\nTRACK OPS TEST: ${failures} FAILURES`)
  process.exit(1)
}
console.log("\nTRACK OPS TEST PASS")