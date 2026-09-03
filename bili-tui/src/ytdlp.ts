/**
 * yt-dlp 封装 — 探测 / 下载 / 进度解析 (仅哔哩哔哩)
 */
import { join } from "path"
import { existsSync } from "fs"
import type { Subprocess } from "bun"

const YTDLP = Bun.which("yt-dlp") || "yt-dlp"

/** cookies 文件存在时返回 --cookies 参数; 否则为空数组 */
function cookiesArgs(file?: string): string[] {
  return file && existsSync(file) ? ["--cookies", file] : []
}

/** 哔哩哔哩域名白名单; 返回 false 表示不是受支持的 URL */
export function biliHostOk(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase()
  return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv"
}

// ------------------------------------------------------------------
// yt-dlp -J 原始 JSON 形状 (只声明用到的字段)
// ------------------------------------------------------------------

interface RawFormat {
  format_id: string | number
  ext?: string
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  vbr?: number
  abr?: number
  filesize?: number
  filesize_approx?: number
}

interface RawEntry {
  id?: string | number
  title?: string
  url?: string
  webpage_url?: string
  index?: number
  duration?: number
}

interface RawInfo {
  _type?: string
  id?: string | number
  title?: string
  fulltitle?: string
  uploader?: string
  duration?: number
  webpage_url?: string
  original_url?: string
  entries?: RawEntry[]
  formats?: RawFormat[]
}

// ------------------------------------------------------------------
// 领域类型
// ------------------------------------------------------------------

export interface VideoFormat {
  id: string
  ext: string
  width?: number
  height?: number
  fps?: number
  vcodec: string
  acodec: string
  tbr?: number
  filesize?: number
}

export interface VideoInfo {
  kind: "video"
  id: string
  title: string
  uploader?: string
  duration?: number
  webpageUrl: string
  formats: VideoFormat[]
  hasVideo: boolean
  hasAudio: boolean
}

export interface ListEntry {
  id: string
  title: string
  url: string
  index?: number
  duration?: number
}

export interface ListInfo {
  kind: "list"
  id: string
  title: string
  webpageUrl: string
  entries: ListEntry[]
}

export type Probe = VideoInfo | ListInfo

// ------------------------------------------------------------------
// 探测
// ------------------------------------------------------------------

async function runJson(args: string[], cookies?: string): Promise<RawInfo> {
  const proc = Bun.spawn([YTDLP, "-J", "--no-warnings", ...cookiesArgs(cookies), ...args], { stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if (code !== 0) {
    const msg = err.trim().split("\n").filter(Boolean).slice(-3).join(" · ")
    throw new Error(msg || `yt-dlp 退出码 ${code}`)
  }
  return JSON.parse(out) as RawInfo
}

function appendP(base: string, n: number): string {
  const sep = base.includes("?") ? "&" : "?"
  return `${base}${sep}p=${n}`
}

function toListInfo(j: RawInfo, url: string): ListInfo {
  const base = j.webpage_url || j.original_url || url
  const entries: ListEntry[] = (j.entries || []).map((e, i) => ({
    id: String(e.id ?? i + 1),
    title: e.title || String(e.id ?? `P${i + 1}`),
    // 同一视频多 P 时 flat 条目常没有 url, 用 ?p= 回退
    url: e.url || e.webpage_url || appendP(base, e.index ?? i + 1),
    index: e.index ?? i + 1,
    duration: e.duration,
  }))
  return { kind: "list", id: String(j.id ?? ""), title: j.title || url, webpageUrl: base, entries }
}

function toVideoInfo(j: RawInfo, url: string): VideoInfo {
  const formats: VideoFormat[] = (j.formats || []).map((f) => ({
    id: String(f.format_id),
    ext: f.ext || "mp4",
    width: f.width,
    height: f.height,
    fps: f.fps,
    vcodec: f.vcodec || "none",
    acodec: f.acodec || "none",
    tbr: f.tbr ?? f.vbr ?? f.abr,
    filesize: f.filesize ?? f.filesize_approx,
  }))
  return {
    kind: "video",
    id: String(j.id ?? ""),
    title: j.title || j.fulltitle || url,
    uploader: j.uploader,
    duration: j.duration,
    webpageUrl: j.webpage_url || url,
    formats,
    hasVideo: formats.some((f) => f.vcodec !== "none"),
    hasAudio: formats.some((f) => f.acodec !== "none"),
  }
}

/** 扁平探测 (列表用, 快): 多P/合集返回 list, 否则返回 video */
export async function probe(url: string, cookies?: string): Promise<Probe> {
  const j = await runJson(["--flat-playlist", "--", url], cookies)
  if (j._type === "playlist" || Array.isArray(j.entries)) return toListInfo(j, url)
  return toVideoInfo(j, url)
}

/** 完整探测 (单视频用): 带 formats */
export async function probeFull(url: string, cookies?: string): Promise<Probe> {
  const j = await runJson(["--no-playlist", "--", url], cookies)
  if (j._type === "playlist" || Array.isArray(j.entries)) {
    // --no-playlist 下合集页仍可能返回列表; 兜底当列表处理
    return toListInfo(j, url)
  }
  return toVideoInfo(j, url)
}

// ------------------------------------------------------------------
// 格式菜单
// ------------------------------------------------------------------

export interface MenuItem {
  name: string
  desc: string
  /** 传给 yt-dlp -f 的格式选择器 */
  selector: string
}

/** 视频菜单: 最佳 + 各分辨率 (同分辨率取码率最高的流) */
export function videoMenu(info: VideoInfo): MenuItem[] {
  const menu: MenuItem[] = [{ name: "自动最佳", desc: "可用最高画质 + 音质 (推荐)", selector: "bv*+ba/b" }]
  const byHeight = new Map<number, VideoFormat>()
  for (const f of info.formats) {
    if (f.vcodec === "none" || !f.height) continue
    const cur = byHeight.get(f.height)
    if (!cur || (f.tbr ?? 0) > (cur.tbr ?? 0)) byHeight.set(f.height, f)
  }
  const heights = [...byHeight.keys()].sort((a, b) => b - a)
  for (const h of heights) {
    const f = byHeight.get(h)!
    const codec = codecShort(f.vcodec)
    const mb = f.filesize ? ` · ~${(f.filesize / 1048576).toFixed(0)}MB` : ""
    menu.push({
      name: `${h}P${f.fps && f.fps > 30 ? ` ${Math.round(f.fps)}帧` : ""}`,
      desc: `${codec} · ${f.ext}${mb} · 格式 ${f.id}`,
      selector: `bv*[height=${h}]+ba/b[height=${h}]`,
    })
  }
  if (heights.length === 0) menu.push({ name: "无视频流", desc: "该稿件可能只有音频", selector: "ba/b" })
  return menu
}

/** 音频菜单: 最佳 + 各音频流 (按码率去重) */
export function audioMenu(info: VideoInfo): MenuItem[] {
  const menu: MenuItem[] = [{ name: "自动最佳", desc: "码率最高的音频流 (推荐)", selector: "ba/b" }]
  const seenTbr = new Set<number>()
  const audios = info.formats
    .filter((f) => f.vcodec === "none" && f.acodec !== "none")
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))
  for (const f of audios) {
    const key = Math.round(f.tbr ?? -1)
    if (seenTbr.has(key)) continue
    seenTbr.add(key)
    const kbps = f.tbr ? ` ~${Math.round(f.tbr)}kbps` : ""
    const mb = f.filesize ? ` · ~${(f.filesize / 1048576).toFixed(0)}MB` : ""
    menu.push({ name: `${f.acodec.toUpperCase()}${kbps}`, desc: `${f.ext}${mb} · 格式 ${f.id}`, selector: f.id })
  }
  return menu
}

const CODEC_LABEL: Record<string, string> = {
  avc: "AVC",
  hev: "HEVC",
  hvc: "HEVC",
  av0: "AV1",
  vp9: "VP9",
}

function codecShort(v: string): string {
  if (!v || v === "none") return "—"
  return CODEC_LABEL[v.slice(0, 3)] || v
}

// ------------------------------------------------------------------
// 下载
// ------------------------------------------------------------------

export interface Progress {
  percent?: number
  totalText?: string
  speedText?: string
  etaText?: string
  status: string
  file?: string
}

export interface DownloadSpec {
  url: string
  outDir: string
  selector: string
  /** true = 作为列表整体下载 (多P/合集) */
  asPlaylist?: boolean
  /** yt-dlp --playlist-items 规格, 如 "1,3,5-8" */
  items?: string
  /** Netscape cookies 文件路径 */
  cookies?: string
}

export interface DownloadResult {
  ok: boolean
  error?: string
  files: string[]
}

const POSTPROC_LABEL: Record<string, string> = {
  ExtractAudio: "音频转换",
  Merger: "合并流",
  VideoConvert: "转码",
  FixupM4a: "整理容器",
  FixupStereo: "音频修正",
  MoveFiles: "归档",
}

export class DownloadJob {
  private proc: Subprocess | null = null
  private killed = false
  readonly done: Promise<DownloadResult>

  constructor(spec: DownloadSpec, onProgress: (p: Progress) => void, onLog: (line: string) => void) {
    const outTmpl = join(spec.outDir, "%(title).80s [%(id)s].%(ext)s")
    const args = [
      YTDLP,
      ...cookiesArgs(spec.cookies),
      "-f", spec.selector,
      "-o", outTmpl,
      "--newline",
      "--no-mtime",
      spec.asPlaylist ? "--yes-playlist" : "--no-playlist",
      ...(spec.items ? ["--playlist-items", spec.items] : []),
      "--", spec.url,
    ]
    this.done = this.run(args, onProgress, onLog)
  }

  private async run(args: string[], onProgress: (p: Progress) => void, onLog: (line: string) => void): Promise<DownloadResult> {
    const files = new Set<string>()
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    this.proc = proc
    const errPromise = new Response(proc.stderr).text()
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let pending = ""
    const feed = (line: string): void => {
      if (!line) return
      handleLine(line, files, onProgress, onLog)
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = pending.indexOf("\n")) >= 0) {
          feed(pending.slice(0, nl).replace(/\r$/, ""))
          pending = pending.slice(nl + 1)
        }
      }
      feed(pending.replace(/\r$/, ""))
    } finally {
      reader.releaseLock()
    }
    const code = await proc.exited
    const err = (await errPromise).trim()
    if (this.killed) return { ok: false, error: "已取消", files: [...files] }
    if (code !== 0) {
      return { ok: false, error: err.split("\n").filter(Boolean).slice(-3).join(" · ") || `退出码 ${code}`, files: [...files] }
    }
    return { ok: true, files: [...files] }
  }

  kill(): void {
    this.killed = true
    const p = this.proc
    if (!p) return
    p.kill("SIGINT")
    setTimeout(() => {
      try { p.kill("SIGKILL") } catch { /* 已退出 */ }
    }, 3000)
  }
}

function handleLine(line: string, files: Set<string>, onProgress: (p: Progress) => void, onLog: (line: string) => void): void {
  const dest = line.match(/\[download\] Destination: (.+)$/)
  if (dest) {
    files.add(dest[1])
    onProgress({ status: "下载中", file: dest[1] })
    onLog(line)
    return
  }
  // 合并流: 最终文件替换掉中间片段文件
  const merger = line.match(/\[Merger\] Merging formats into "(.+)"$/)
  if (merger) {
    const final = merger[1]
    for (const f of files) {
      if (/\.f\d+\.[a-z0-9]+$/i.test(f) && f.replace(/\.f\d+\./, ".") === final) files.delete(f)
    }
    files.add(final)
    onProgress({ status: `合并完成: ${final}`.slice(0, 120) })
    onLog(line)
    return
  }
  // 后处理删除的中间文件 (如 ExtractAudio 转换前下载的源文件)
  const del = line.match(/Deleting original file (.+?) \(pass -k to keep/)
  if (del) {
    files.delete(del[1])
    onLog(line)
    return
  }
  const prog = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%\ of ~?\s*([\d.,]+\s*[KMGTP]?i?B)(?:\s+at\s+([\d.,]+\s*[KMGTP]?i?B\/s))?(?:\s+ETA\s+(\S+))?/)
  if (prog) {
    onProgress({
      percent: Number(prog[1]),
      totalText: prog[2].trim(),
      speedText: prog[3]?.trim(),
      etaText: prog[4],
      status: "下载中",
    })
    return
  }
  if (/^\[download\] 100%/.test(line)) {
    onProgress({ percent: 100, status: "下载中" })
    onLog(line)
    return
  }
  const frac = line.match(/^\[download\]\s+fragment\s+(\d+)\s*\/\s*(\d+)/i)
  if (frac) {
    onProgress({ percent: (Number(frac[1]) / Number(frac[2])) * 100, status: "下载中" })
    return
  }
  const proc2 = line.match(/^\[(\w+)\]\s+(.+)$/)
  if (proc2) {
    const label = POSTPROC_LABEL[proc2[1]] || proc2[1]
    onProgress({ status: `${label}: ${proc2[2]}`.slice(0, 120) })
    onLog(line)
    return
  }
  if (/\[download\] (.+) has already been downloaded/.test(line)) {
    onProgress({ status: "文件已存在, 跳过" })
  }
  onLog(line)
}

