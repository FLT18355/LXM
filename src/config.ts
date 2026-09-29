/**
 * 配置读写 — 兼容 Python 版的 ~/.config/lxmusic/config.toml
 */
import { homedir } from "os"
import { join, resolve } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"

export const CONFIG_DIR = join(homedir(), ".config", "lxmusic")
// 测试可用 LXM_CONFIG_FILE 指向临时文件, 避免读写污染用户真实配置 (同 LXM_PLAYLISTS_FILE 模式)
export const CONFIG_FILE = process.env["LXM_CONFIG_FILE"] || join(CONFIG_DIR, "config.toml")

export type PlayerConfig = {
  music_directory?: string
  /** r-1.0: 多音乐目录 (旧版单目录 music_directory 仍兼容并作为主目录) */
  music_directories?: string[]
  favorites?: string[]
  last_path?: string
  last_pos?: number
  [key: string]: unknown
}

/**
 * 从配置解析音乐目录列表 (r-1.0 多目录).
 * 兼容旧版单目录 `music_directory`; 去重、绝对化、保持顺序。
 * 主目录 (index 0) 同时回写为 `music_directory`, 与 Python 版 lxm.py 保持兼容。
 */
export function musicDirsFromConfig(cfg: Record<string, unknown>, fallback?: string): string[] {
  const raw: string[] = []
  const arr = cfg["music_directories"]
  if (Array.isArray(arr)) {
    for (const x of arr) if (typeof x === "string" && x.trim()) raw.push(x)
  }
  const single = cfg["music_directory"]
  if (typeof single === "string" && single.trim()) raw.push(single)
  if (fallback && fallback.trim()) raw.push(fallback)
  const out: string[] = []
  const seen = new Set<string>()
  for (const d of raw) {
    let abs = d
    try {
      abs = resolve(d)
    } catch {
      /* 非法路径原样保留, 后续 existsSync 会过滤 */
    }
    if (!seen.has(abs)) {
      seen.add(abs)
      out.push(abs)
    }
  }
  return out
}

/** 持久化音乐目录列表 (同时维护主目录 music_directory 以兼容旧版) */
export function saveMusicDirs(dirs: string[]): void {
  const clean = dirs.filter((d) => !!d).map((d) => {
    try {
      return resolve(d)
    } catch {
      return d
    }
  })
  saveConfig({ music_directories: clean, music_directory: clean[0] ?? "" })
}

const DEFAULT_HEADER = `# 本地音乐播放器配置文件
# 修改音乐目录: bun index.ts config --music-directory /xxx/xx
`

/** 解析这个程序用到的 TOML 子集 (key = "string" / [..] / number / bool) */
export function parseToml(src: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  for (const raw of src.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const val = m[2].trim()
    if (val.startsWith('"')) {
      cfg[key] = val.replace(/^"|"$/g, "").replace(/\\"/g, '"')
    } else if (val.startsWith("[")) {
      const items = [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1])
      cfg[key] = items
    } else if (val === "true" || val === "false") {
      cfg[key] = val === "true"
    } else {
      const n = Number(val)
      if (!Number.isNaN(n)) cfg[key] = n
    }
  }
  return cfg
}

/** 读取配置文件, 不存在或损坏时返回 {} */
export function loadConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_FILE)) return {}
    return parseToml(readFileSync(CONFIG_FILE, "utf-8"))
  } catch {
    return {}
  }
}

export function tomlValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return String(v)
  if (Array.isArray(v))
    return "[" + v.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(", ") + "]"
  return `"${String(v).replace(/"/g, '\\"')}"`
}

/** 整份覆盖写配置 (含固定头), 供 saveConfig 与迁移清理复用 */
export function writeConfig(data: Record<string, unknown>): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  const lines = [DEFAULT_HEADER, ""]
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k} = ${tomlValue(v)}`)
  }
  try {
    writeFileSync(CONFIG_FILE, lines.join("\n") + "\n")
  } catch {
    /* ignore */
  }
}

/** 将配置写入文件 (与现有配置合并) */
export function saveConfig(patch: Record<string, unknown>): void {
  writeConfig({ ...loadConfig(), ...patch })
}