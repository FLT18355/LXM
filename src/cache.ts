/**
 * 缓存目录 — ~/.cache/lxmusic/ (XDG 风格)
 *
 * 存放不适合进配置文件的东西:
 *   - state.toml      断点续播 (last_path/last_pos) — 运行时状态, 不属于配置
 *   - scan-cache.toml 音乐目录扫描缓存 (dir + mtime + files) — 启动加速, 可随时重建
 *
 * 环境变量 LXM_CACHE_DIR 可重定向 (测试隔离, 同 LXM_PLAYLISTS_FILE 模式)
 */
import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync } from "fs"
import { parseToml, tomlValue } from "./config"

export const CACHE_DIR = process.env["LXM_CACHE_DIR"] || join(homedir(), ".cache", "lxmusic")
export const STATE_FILE = join(CACHE_DIR, "state.toml")
export const SCAN_CACHE_FILE = join(CACHE_DIR, "scan-cache.toml")
export const PLAYS_FILE = join(CACHE_DIR, "plays.toml")
export const DURATIONS_FILE = join(CACHE_DIR, "durations.toml")

export type StateFile = {
  last_path?: string
  last_pos?: number
}

/** 确保缓存目录存在 */
export function ensureCacheDir(): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
}

function readTomlFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    return parseToml(readFileSync(path, "utf-8"))
  } catch {
    return {}
  }
}

function writeTomlFile(path: string, data: Record<string, unknown>): void {
  ensureCacheDir()
  try {
    const lines = Object.entries(data).map(([k, v]) => `${k} = ${tomlValue(v)}`)
    writeFileSync(path, lines.join("\n") + "\n")
  } catch {
    /* ignore */
  }
}

// ---------- 断点续播状态 ----------

export function loadState(): StateFile {
  const raw = readTomlFile(STATE_FILE)
  return {
    last_path: typeof raw["last_path"] === "string" ? (raw["last_path"] as string) : undefined,
    last_pos: typeof raw["last_pos"] === "number" ? (raw["last_pos"] as number) : undefined,
  }
}

export function saveState(patch: StateFile): void {
  writeTomlFile(STATE_FILE, { ...loadState(), ...patch })
}

// ---------- 扫描缓存 ----------

export type ScanCache = {
  dir: string
  mtime: number
  files: string[]
}

function dirMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** 目录未变时返回缓存文件列表, 否则 null (触发重扫)
 *  容差 500ms: 吸收"缓存文件本身写在被扫描目录内"时写入引起的目录 mtime 抖动
 *  (正常场景音乐目录 ≠ 缓存目录, 无偏差; 真实文件变化通常远超 500ms) */
export function loadScanCache(dir: string): string[] | null {
  const raw = readTomlFile(SCAN_CACHE_FILE)
  if (raw["dir"] !== dir) return null
  if (typeof raw["mtime"] !== "number" || Math.abs(raw["mtime"] - dirMtime(dir)) > 500) return null
  if (!Array.isArray(raw["files"])) return null
  const files = raw["files"].filter((x): x is string => typeof x === "string")
  return files.length ? files : null
}

export function saveScanCache(dir: string, files: string[]): void {
  const cache: ScanCache = { dir, mtime: dirMtime(dir), files }
  writeTomlFile(SCAN_CACHE_FILE, cache)
}

/** 清空缓存目录所有文件; 返回删除的文件数 */
export function clearCache(): number {
  let n = 0
  try {
    if (!existsSync(CACHE_DIR)) return 0
    for (const ent of readdirSync(CACHE_DIR)) {
      try {
        rmSync(join(CACHE_DIR, ent), { recursive: true, force: true })
        n++
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return n
}

/** 缓存目录总字节数 */
export function cacheSize(): number {
  let total = 0
  try {
    if (!existsSync(CACHE_DIR)) return 0
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, ent.name)
        if (ent.isDirectory()) walk(full)
        else {
          try {
            total += statSync(full).size
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(CACHE_DIR)
  } catch {
    /* ignore */
  }
  return total
}

// ---------- 播放次数统计 (plays.toml) ----------
// 格式: [[plays]] 子表数组 — 与 playlists.toml 同一 TOML 子集风格
//   [[plays]]
//   path = "/abs/path/a.mp3"
//   count = 12

export type PlayCount = { path: string; count: number }

/** 读取全部播放次数 (无则空数组) */
export function loadPlays(): PlayCount[] {
  try {
    if (!existsSync(PLAYS_FILE)) return []
    const src = readFileSync(PLAYS_FILE, "utf-8")
    const out: PlayCount[] = []
    let path = ""
    let count = 0
    for (const raw of src.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      if (line.startsWith("[[") && line.endsWith("]]")) {
        if (path) out.push({ path, count })
        path = ""
        count = 0
        continue
      }
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (!m) continue
      const key = m[1]
      const val = m[2].trim()
      if (key === "path" && val.startsWith('"')) {
        path = val.replace(/^"|"$/g, "").replace(/\\"/g, '"')
      } else if (key === "count") {
        const n = Number(val)
        if (!Number.isNaN(n)) count = n
      }
    }
    if (path) out.push({ path, count })
    return out
  } catch {
    return []
  }
}

/** 单曲播放次数 +1 并写回; 返回新次数 */
export function bumpPlay(path: string): number {
  const all = loadPlays()
  const hit = all.find((x) => x.path === path)
  const n = (hit ? hit.count : 0) + 1
  if (hit) hit.count = n
  else all.push({ path, count: n })
  // 写回: 保留 [[plays]] 子表数组格式
  ensureCacheDir()
  const lines = ["# 播放次数统计 — 由 lxm-tui 自动维护", ""]
  for (const p of all) {
    lines.push("[[plays]]")
    lines.push(`path = "${p.path.replace(/"/g, '\\"')}"`)
    lines.push(`count = ${p.count}`)
    lines.push("")
  }
  try {
    writeFileSync(PLAYS_FILE, lines.join("\n"))
  } catch {
    /* ignore */
  }
  return n
}

/** 某首歌的播放次数 (没播过返回 0) */
export function playCountOf(path: string): number {
  return loadPlays().find((x) => x.path === path)?.count ?? 0
}

/** 累计播放次数 (导航栏"总播放"用) */
export function totalPlays(): number {
  return loadPlays().reduce((s, x) => s + x.count, 0)
}

// ---------- 歌曲时长缓存 (durations.toml) ----------
// 格式: [[durations]] 子表数组 — 存整数秒, 避免每次启动重新探测
//   [[durations]]
//   path = "/abs/path/a.mp3"
//   dur = 231

export type DurationEntry = { path: string; dur: number }

/** 读取全部已缓存时长 (无则空数组) */
export function loadDurations(): DurationEntry[] {
  try {
    if (!existsSync(DURATIONS_FILE)) return []
    const src = readFileSync(DURATIONS_FILE, "utf-8")
    const out: DurationEntry[] = []
    let path = ""
    let dur = 0
    for (const raw of src.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      if (line.startsWith("[[") && line.endsWith("]]")) {
        if (path) out.push({ path, dur })
        path = ""
        dur = 0
        continue
      }
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (!m) continue
      if (m[1] === "path" && m[2].trim().startsWith('"')) {
        path = m[2].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"')
      } else if (m[1] === "dur") {
        const n = Number(m[2].trim())
        if (!Number.isNaN(n)) dur = n
      }
    }
    if (path) out.push({ path, dur })
    return out
  } catch {
    return []
  }
}

/** 写入/更新单曲时长 (秒, 取整) 到缓存; 值未变则跳过写盘 */
export function saveDuration(path: string, dur: number): void {
  const sec = Math.round(dur)
  if (!path || !(sec > 0)) return
  const all = loadDurations()
  const hit = all.find((x) => x.path === path)
  if (hit) {
    if (hit.dur === sec) return
    hit.dur = sec
  } else {
    all.push({ path, dur: sec })
  }
  ensureCacheDir()
  const lines = ["# 歌曲时长缓存 — 由 lxm-tui 自动维护 (秒)", ""]
  for (const d of all) {
    lines.push("[[durations]]")
    lines.push(`path = "${d.path.replace(/"/g, '\\"')}"`)
    lines.push(`dur = ${d.dur}`)
    lines.push("")
  }
  try {
    writeFileSync(DURATIONS_FILE, lines.join("\n"))
  } catch {
    /* ignore */
  }
}