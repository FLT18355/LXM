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