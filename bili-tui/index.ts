#!/usr/bin/env bun
/**
 * bili-tui — 哔哩哔哩下载器 (yt-dlp 图形化)
 *
 * 用法:
 *   bun index.ts [视频链接]     # 启动; 带链接则自动解析
 *   bun index.ts -h | --help    # 帮助
 */
import { createCliRenderer } from "@opentui/core"
import { App } from "./src/ui"

const HELP = `bili-tui — 哔哩哔哩下载器 (yt-dlp 图形化)

用法:
  bun index.ts [链接]    启动 TUI; 传入链接时自动解析
  bun index.ts -h        显示帮助

支持: 哔哩哔哩视频 / 多P合集 / 番剧 / 音频 (bilibili.com, b23.tv)
功能: 清晰度选择 (视频画质 / 音乐音质) · 批量下载 · 下载进度与日志
依赖: yt-dlp (必需), ffmpeg (合并音视频流)
`

async function main() {
  const argv = Bun.argv.slice(2)
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP)
    return
  }
  const which = Bun.which("yt-dlp")
  if (!which) {
    console.error("找不到 yt-dlp, 请先安装: pip install yt-dlp 或 pacman -S yt-dlp")
    process.exit(1)
  }
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
  })
  const app = new App(renderer)
  const link = argv.find((a) => !a.startsWith("-"))
  if (link) app.startWithUrl(link)
}

main()
