/**
 * 配置读写 — ~/.config/bili-tui/config.toml (TOML 子集)
 */
import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"

export const CONFIG_DIR = join(homedir(), ".config", "bili-tui")
export const CONFIG_FILE = join(CONFIG_DIR, "config.toml")

export interface Config {
  download_dir?: string
  quality_id?: string
  audio_quality_id?: string
  /** yt-dlp --cookies 的 Netscape cookies 文件路径; 不存在则忽略 */
  cookies_file?: string
  /** 主题名: mocha | latte */
  theme?: string
  [key: string]: unknown
}

export function defaultDownloadDir(): string {
  return join(homedir(), "Downloads", "bili")
}

export function defaultCookiesFile(): string {
  return join(homedir(), "cookies.txt")
}

/** 解析本程序用到的 TOML 子集 (key = "string" / number / bool) */
export function parseToml(src: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  for (const raw of src.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    const val = m[2].trim()
    if (val.startsWith('"')) {
      cfg[m[1]] = val.replace(/^"|"$/g, "").replace(/\\"/g, '"')
    } else if (val === "true" || val === "false") {
      cfg[m[1]] = val === "true"
    } else {
      const n = Number(val)
      if (!Number.isNaN(n)) cfg[m[1]] = n
    }
  }
  return cfg
}

export function loadConfig(): Config {
  try {
    if (!existsSync(CONFIG_FILE)) return {}
    return parseToml(readFileSync(CONFIG_FILE, "utf-8")) as Config
  } catch {
    return {}
  }
}

function tomlValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return String(v)
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return ""
}

/** 合并写回配置 (保留未知键) */
export function saveConfig(patch: Partial<Config>): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  const cfg: Config = { ...loadConfig(), ...patch }
  const lines: string[] = ["# bili-tui 配置文件"]
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined) continue
    const t = tomlValue(v)
    if (t) lines.push(`${k} = ${t}`)
  }
  writeFileSync(CONFIG_FILE, lines.join("\n") + "\n")
}
