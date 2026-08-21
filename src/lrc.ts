/**
 * LRC 歌词解析 + 同名 .lrc 查找
 */
import { existsSync, readFileSync } from "fs"
import { extname } from "path"

export type LyricLine = { time: number; text: string }
export type LyricTag = [string, string]

/** 查找与音频同名的 .lrc 文件 */
export async function findLrc(path: string): Promise<string | null> {
  const root = path.slice(0, path.length - extname(path).length)
  for (const cand of [root + ".lrc", root + ".LRC"]) {
    try {
      if (existsSync(cand)) return cand
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 解析 'mm:ss.xx' 返回秒数, 失败返回 null */
function parseTime(s: string): number | null {
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

const SKIP_KEYS = new Set(["ti", "ar", "al", "by", "re", "ve", "length"])

/**
 * 解析 LRC 文件.
 * 返回 { lines: [(time, text)...], tags: [[key, val]...] }, 按时间排序.
 */
export async function parseLrc(path: string): Promise<{ lines: LyricLine[]; tags: LyricTag[] }> {
  const tags: LyricTag[] = []
  const raw: Array<[number | string, string]> = []
  let src: string
  try {
    src = readFileSync(path, "utf-8")
  } catch {
    return { lines: [], tags }
  }
  for (const rawline of src.split("\n")) {
    const line = rawline.trim()
    if (!line) continue
    let rest = line
    // 头部标签 [ti:歌名] 等 (仅当整行就是一个标签时)
    if (line.startsWith("[") && line.endsWith("]")) {
      const inner = line.slice(1, -1)
      const idx = inner.indexOf(":")
      if (idx !== -1 && inner.indexOf(":", idx + 1) === -1) {
        const key = inner.slice(0, idx).trim().toLowerCase()
        const val = inner.slice(idx + 1).trim()
        if (key === "offset") {
          raw.push(["offset", val])
          continue
        }
        if (SKIP_KEYS.has(key)) {
          tags.push([key, val])
          continue
        }
      }
    }
    // 普通歌词行: 可能含多个时间戳 [mm:ss.xx][mm:ss.xx]文本
    const matches: number[] = []
    let text = line
    while (text.startsWith("[")) {
      const end = text.indexOf("]")
      if (end === -1) break
      const inner = text.slice(1, end)
      text = text.slice(end + 1)
      const t = parseTime(inner)
      if (t !== null) matches.push(t)
    }
    text = text.trim()
    for (const t of matches) raw.push([t, text])
  }

  // 应用 offset (毫秒, 正数提前)
  let offset = 0
  const lines: LyricLine[] = []
  for (const [ts, text] of raw) {
    if (typeof ts === "string") {
      const n = Number(text)
      if (!Number.isNaN(n)) offset = n
      continue
    }
    lines.push({ time: ts - offset / 1000, text })
  }
  lines.sort((a, b) => a.time - b.time)
  return { lines, tags }
}