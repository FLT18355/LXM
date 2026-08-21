/**
 * 配置读写 — 兼容 Python 版的 ~/.config/lxmusic/config.toml
 */
import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"

export const CONFIG_DIR = join(homedir(), ".config", "lxmusic")
export const CONFIG_FILE = join(CONFIG_DIR, "config.toml")

export type PlayerConfig = {
  music_directory?: string
  favorites?: string[]
  last_path?: string
  last_pos?: number
  [key: string]: unknown
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

function tomlValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return String(v)
  if (Array.isArray(v))
    return "[" + v.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(", ") + "]"
  return `"${String(v).replace(/"/g, '\\"')}"`
}

/** 将配置写入文件 (与现有配置合并) */
export function saveConfig(patch: Record<string, unknown>): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  const merged = { ...loadConfig(), ...patch }
  const lines = [DEFAULT_HEADER, ""]
  for (const [k, v] of Object.entries(merged)) {
    lines.push(`${k} = ${tomlValue(v)}`)
  }
  try {
    writeFileSync(CONFIG_FILE, lines.join("\n") + "\n")
  } catch {
    /* ignore */
  }
}