#!/usr/bin/env bun
/**
 * 本地音乐播放器 — OpenTUI 版 (基于 mpv JSON IPC)
 *
 * 用法:
 *   bun index.ts [音乐目录]                # 启动播放器
 *   bun index.ts config --music-directory /xxx/xx   # 配置音乐目录
 */
import { existsSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { createCliRenderer } from "@opentui/core"
import { CONFIG_FILE, loadConfig, saveConfig } from "./src/config"
import { scanDirectory } from "./src/scanner"
import { MpvClient, waitForSocket } from "./src/mpv"
import { Player } from "./src/player"
import { PlayerUI } from "./src/ui"
import { parseThemeName } from "./src/theme"

const HELP = `
本地音乐播放器 (OpenTUI + mpv)

版本: dev-0.0.0.10465

用法:
  bun index.ts [音乐目录]                        启动播放器
  bun index.ts config [--music-directory DIR]   配置/查看音乐目录
  bun index.ts -v | --version                   显示版本

快捷键:
  空格/Enter  播放/暂停/播放选中   n/p  下一首/上一首
  ←/→  ±5秒   [/]  ±10秒          r/a  减速/加速
  +/-  音量   ↑↓/jk  选择          s  随机
  m  循环模式   /  搜索(支持中文)   f/F  收藏
  l/L  歌词开关/全屏歌词 (KTV)     d  重新扫描目录
  h  帮助   q/Esc  退出
  M/0  静音
`

async function handleConfig(args: string[]): Promise<void> {
  let musicDir: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--music-directory") {
      musicDir = args[i + 1]
      i++
    }
  }
  if (musicDir) {
    musicDir = resolve(musicDir)
    try {
      if (!existsSync(musicDir)) throw new Error("not a dir")
    } catch {
      console.log(`目录不存在喵: ${musicDir}`)
      process.exit(1)
    }
    saveConfig({ music_directory: musicDir })
    console.log("已保存配置喵~")
    console.log(`  配置文件: ${CONFIG_FILE}`)
    console.log(`  音乐目录: ${musicDir}`)
    return
  }
  const cfg = loadConfig()
  if (cfg["music_directory"]) {
    console.log(`当前音乐目录: ${cfg["music_directory"]}`)
    console.log(`  配置文件: ${CONFIG_FILE}`)
  } else {
    console.log("尚未配置音乐目录喵~")
    console.log("用法: bun index.ts config --music-directory /xxx/xx")
  }
}

async function main() {
  const argv = Bun.argv.slice(2)
  if (argv[0] === "config") {
    await handleConfig(argv.slice(1))
    return
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(HELP)
    return
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log("dev-0.0.0.10465")
    return
  }
  let dirArg: string | undefined
  for (const a of argv) {
    if (!a.startsWith("-")) {
      dirArg = a
      break
    }
  }

  // ---------- 确定音乐目录 (命令行 > 配置 > ~/Music) ----------
  const cfg = loadConfig()
  const musicDir = resolve(dirArg || (cfg["music_directory"] as string) || join(process.env.HOME || "~", "Music"))
  try {
    const st = await Bun.spawn(["test", "-d", musicDir]).exited
    if (st !== 0) throw new Error("not a dir")
  } catch {
    console.log(`目录不存在喵: ${musicDir}`)
    console.log("可用 bun index.ts config --music-directory /xxx/xx 配置")
    process.exit(1)
  }

  const playlist = await scanDirectory(musicDir)
  if (!playlist.length) {
    console.log(`在 ${musicDir} 中没找到音频文件喵~`)
    process.exit(1)
  }
  console.log(`扫描到 ${playlist.length} 首曲目喵~`)

  // ---------- 启动 mpv ----------
  const socketPath = join(tmpdir(), `lanxi_mpv_${process.pid}.sock`)
  try {
    if (existsSync(socketPath)) Bun.spawnSync(["rm", "-f", socketPath])
  } catch {
    /* ignore */
  }
  const mpvCmd = [
    "mpv", "--idle=yes", "--no-video", `--input-ipc-server=${socketPath}`,
    "--terminal=no", "--quiet", "--no-config", "--volume=100",
  ]
  let mpvProc: ReturnType<typeof Bun.spawn>
  try {
    mpvProc = Bun.spawn(mpvCmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  } catch {
    console.log("未找到 mpv, 请先安装喵~")
    process.exit(1)
  }
  if (!(await waitForSocket(socketPath, 5000))) {
    console.log("mpv 启动超时喵~")
    mpvProc.kill()
    process.exit(1)
  }

  // ---------- 创建 renderer ----------
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
  })

  let interval: ReturnType<typeof setInterval> | null = null
  let exited = false

  const mpv = new MpvClient()

  const shutdown = async (code = 0) => {
    if (exited) return
    exited = true
    if (interval) clearInterval(interval)
    try {
      player.saveState()
    } catch {
      /* ignore */
    }
    mpv.close()
    renderer.destroy()
    try {
      mpvProc.kill()
      await Promise.race([mpvProc.exited, new Promise((r) => setTimeout(r, 2000))])
      if (mpvProc.exitCode === null) mpvProc.kill(9)
    } catch {
      /* ignore */
    }
    try {
      rmSync(socketPath, { force: true })
    } catch {
      /* ignore */
    }
    process.exit(code)
  }

  // mpv 意外退出时也退出
  mpvProc.exited.then((code) => {
    if (!exited) {
      console.log(`\nmpv 已退出 (code ${code}) 喵~`)
      shutdown(code === null ? 1 : code)
    }
  })

  try {
    await mpv.connect(socketPath, 40, 100)
  } catch {
    console.log("无法连接 mpv IPC socket 喵~")
    mpvProc.kill()
    process.exit(1)
  }

  const player = new Player(mpv)
  player.musicDir = musicDir
  player.playlist = playlist
  player.queue = playlist.map((_, i) => i)

  const ui = new PlayerUI(renderer, player, parseThemeName(cfg["theme"]))

  // ---------- 恢复断点续播 ----------
  player.favorites = Array.isArray(cfg["favorites"]) ? (cfg["favorites"] as string[]) : []
  const lastPath = cfg["last_path"] as string | undefined
  const lastPos = Number(cfg["last_pos"] || 0)
  if (lastPath) {
    const idx = playlist.indexOf(lastPath)
    if (idx !== -1) {
      player.idx = idx
      player.currentPath = lastPath
      await player.playIndex(idx)
      if (lastPos > 0) player.pendingSeek = lastPos
    }
  }

  ui.onQuit = () => {
    shutdown(0)
  }
  ui.updatePlaylist()
  ui.updateNowPlaying()

  // ---------- 主循环 (100ms) ----------
  interval = setInterval(() => {
    if (!exited) ui.tick()
  }, 100)

  // 渲染器被外部销毁 (Ctrl+C / 信号) 时兜底清理
  renderer.once("destroy", () => {
    if (!exited) {
      exited = true
      if (interval) clearInterval(interval)
      try {
        player.saveState()
      } catch {
        /* ignore */
      }
      mpv.close()
      try {
        mpvProc.kill(9)
        rmSync(socketPath, { force: true })
      } catch {
        /* ignore */
      }
    }
  })

  process.on("SIGINT", () => shutdown(0))
  process.on("SIGTERM", () => shutdown(0))
}

main().catch((err) => {
  console.error("播放器崩溃了喵~", err)
  process.exit(1)
})