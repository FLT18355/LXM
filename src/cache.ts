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
  /** r-1.0: 支持多音乐目录 (旧版单目录 dir 字段仍兼容读取) */
  dirs: string[]
  mtimes: number[]
  files: string[]
}

function dirMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** 归一化目录入参 (单个字符串或数组) */
function normDirs(input: string | string[]): string[] {
  const arr = Array.isArray(input) ? input : [input]
  return arr.filter((d): d is string => typeof d === "string" && d.length > 0)
}

/** 读取原始扫描缓存; 兼容旧版单目录格式 (dir: string + mtime: number) */
function readScanCacheRaw(): ScanCache | null {
  const raw = readTomlFile(SCAN_CACHE_FILE)
  let dirs: string[] = []
  if (Array.isArray(raw["dirs"])) {
    dirs = (raw["dirs"] as unknown[]).filter((x): x is string => typeof x === "string")
  } else if (typeof raw["dir"] === "string") {
    dirs = [raw["dir"] as string]
  }
  if (!dirs.length) return null
  let mtimes: number[] = []
  if (Array.isArray(raw["mtimes"])) {
    mtimes = (raw["mtimes"] as unknown[]).map((x) => {
      const n = Number(x)
      return Number.isFinite(n) ? n : 0
    })
  } else if (typeof raw["mtime"] === "number") {
    mtimes = [raw["mtime"] as number]
  }
  const files = Array.isArray(raw["files"])
    ? (raw["files"] as unknown[]).filter((x): x is string => typeof x === "string")
    : []
  return { dirs, mtimes, files }
}

/** 目录未变时返回缓存文件列表, 否则 null (触发重扫)
 *  容差 500ms: 吸收"缓存文件本身写在被扫描目录内"时写入引起的目录 mtime 抖动
 *  (正常场景音乐目录 ≠ 缓存目录, 无偏差; 真实文件变化通常远超 500ms)
 *  多目录时要求目录列表完全一致且每个目录 mtime 均未变。 */
export function loadScanCache(input: string | string[]): string[] | null {
  const want = normDirs(input)
  if (!want.length) return null
  const raw = readScanCacheRaw()
  if (!raw) return null
  if (raw.dirs.length !== want.length) return null
  for (let i = 0; i < want.length; i++) {
    if (raw.dirs[i] !== want[i]) return null
    const m = raw.mtimes[i]
    if (typeof m !== "number" || Math.abs(m - dirMtime(want[i])) > 500) return null
  }
  return raw.files.length ? raw.files : null
}

export function saveScanCache(input: string | string[], files: string[]): void {
  const dirs = normDirs(input)
  if (!dirs.length) return
  const mtimes = dirs.map(dirMtime)
  // mtimes 以字符串数组存 (parseToml 的数组解析只认引号字符串)
  const data: Record<string, unknown> = { dirs, mtimes: mtimes.map(String), files }
  // 单目录时额外写旧格式字段, 便于降级/人工查看
  if (dirs.length === 1) {
    data["dir"] = dirs[0]
    data["mtime"] = mtimes[0]
  }
  writeTomlFile(SCAN_CACHE_FILE, data)
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

export type PlayCount = {
  path: string
  count: number
  /** r-1.0: 最近一次播放时间 (epoch ms); 旧缓存无此字段 */
  last?: number
}

/** 整表写回 plays.toml (保留 [[plays]] 子表数组格式) */
function writePlays(all: PlayCount[]): void {
  ensureCacheDir()
  const lines = ["# 播放次数统计 — 由 lxm-tui 自动维护", ""]
  for (const p of all) {
    lines.push("[[plays]]")
    lines.push(`path = "${p.path.replace(/"/g, '\\"')}"`)
    lines.push(`count = ${p.count}`)
    if (typeof p.last === "number" && Number.isFinite(p.last)) lines.push(`last = ${Math.round(p.last)}`)
    lines.push("")
  }
  try {
    writeFileSync(PLAYS_FILE, lines.join("\n"))
  } catch {
    /* ignore */
  }
}

/** 读取全部播放次数 (无则空数组) */
export function loadPlays(): PlayCount[] {
  try {
    if (!existsSync(PLAYS_FILE)) return []
    const src = readFileSync(PLAYS_FILE, "utf-8")
    const out: PlayCount[] = []
    let path = ""
    let count = 0
    let last: number | undefined
    const flush = () => {
      if (path) out.push(last === undefined ? { path, count } : { path, count, last })
    }
    for (const raw of src.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      if (line.startsWith("[[") && line.endsWith("]]")) {
        flush()
        path = ""
        count = 0
        last = undefined
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
      } else if (key === "last") {
        const n = Number(val)
        if (Number.isFinite(n)) last = n
      }
    }
    flush()
    return out
  } catch {
    return []
  }
}

/** 单曲播放次数 +1 并写回 (同时记录最近播放时间); 返回新次数 */
export function bumpPlay(path: string, now = Date.now()): number {
  const all = loadPlays()
  const hit = all.find((x) => x.path === path)
  const n = (hit ? hit.count : 0) + 1
  if (hit) {
    hit.count = n
    hit.last = now
  } else {
    all.push({ path, count: n, last: now })
  }
  writePlays(all)
  return n
}

/** 最近播放的若干条 (按 last 倒序; 无时间戳的旧条目排最后) */
export function recentPlays(limit = 20): PlayCount[] {
  return loadPlays()
    .filter((x) => x.count > 0)
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    .slice(0, limit)
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

/** 整表写回 durations.toml (保留 [[durations]] 子表数组格式) */
function writeDurations(all: DurationEntry[]): void {
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
  writeDurations(all)
}

// ---------- 歌曲改名/删除后的缓存同步 ----------
// plays.toml / durations.toml 以绝对路径为键: 歌曲改文件名或删除后必须同步,
// 否则计数与时长挂在已不存在的路径上 (新路径从零重算 / 幽灵条目常驻)。

/** 把 plays/durations 缓存里的 oldPath 改名为 newPath (目标已有条目则合并: 次数相加, 时长保留原值) */
export function renameTrackData(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return
  const plays = loadPlays()
  const hit = plays.find((x) => x.path === oldPath)
  if (hit) {
    const exist = plays.find((x) => x.path === newPath)
    if (exist) {
      exist.count += hit.count
      const mergedLast = Math.max(exist.last ?? 0, hit.last ?? 0)
      if (mergedLast > 0) exist.last = mergedLast
      plays.splice(plays.indexOf(hit), 1)
    } else {
      hit.path = newPath
    }
    writePlays(plays)
  }
  const durs = loadDurations()
  const hitDur = durs.find((x) => x.path === oldPath)
  if (hitDur) {
    const exist = durs.find((x) => x.path === newPath)
    if (exist) durs.splice(durs.indexOf(hitDur), 1)
    else hitDur.path = newPath
    writeDurations(durs)
  }
}

/** 删除 plays/durations 缓存里的 path 条目 (歌曲文件删除后调用) */
export function dropTrackData(path: string): void {
  if (!path) return
  const plays = loadPlays()
  const keptPlays = plays.filter((x) => x.path !== path)
  if (keptPlays.length !== plays.length) writePlays(keptPlays)
  const durs = loadDurations()
  const keptDurs = durs.filter((x) => x.path !== path)
  if (keptDurs.length !== durs.length) writeDurations(keptDurs)
}

/** 读取扫描缓存里的文件列表; dirs 不匹配/无缓存返回 null */
function scanCacheFiles(input: string | string[]): { dirs: string[]; files: string[] } | null {
  const want = normDirs(input)
  const raw = readScanCacheRaw()
  if (!raw) return null
  if (want.length) {
    if (raw.dirs.length !== want.length) return null
    for (let i = 0; i < want.length; i++) if (raw.dirs[i] !== want[i]) return null
  }
  return { dirs: raw.dirs, files: raw.files }
}

/** 目录内文件改名后同步扫描缓存。
 *  子目录里的文件改名不会改变音乐目录根的 mtime (loadScanCache 只看根), 不手动同步的话
 *  下次启动会复用旧路径列表 → 列表出现幽灵条目、新名丢失。 */
export function renameInScanCache(input: string | string[], oldPath: string, newPath: string): void {
  const cache = scanCacheFiles(input)
  if (!cache) return
  const i = cache.files.indexOf(oldPath)
  if (i === -1) return
  cache.files[i] = newPath
  saveScanCache(cache.dirs, cache.files.sort())
}

/** 目录内文件删除后同步扫描缓存 (理由同 renameInScanCache) */
export function dropFromScanCache(input: string | string[], path: string): void {
  const cache = scanCacheFiles(input)
  if (!cache) return
  const i = cache.files.indexOf(path)
  if (i === -1) return
  cache.files.splice(i, 1)
  saveScanCache(cache.dirs, cache.files)
}