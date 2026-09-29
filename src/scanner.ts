/**
 * 音乐目录扫描 + 文件名工具
 */
import { readdir } from "fs/promises"
import type { Dirent } from "fs"
import { extname, join, basename, dirname, sep } from "path"
import { loadScanCache, saveScanCache } from "./cache"

export const AUDIO_EXTS = new Set([
  ".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aac",
  ".opus", ".wma", ".ape", ".alac", ".oga", ".webm", ".aiff",
])

/** 递归扫描目录, 返回排序后的音频文件绝对路径列表 */
export async function scanDirectory(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (AUDIO_EXTS.has(extname(ent.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  await walk(root)
  out.sort()
  return out
}

export function baseName(p: string): string {
  return basename(p)
}

/** 带缓存的目录扫描: 目录 mtime 未变时直接复用缓存, 否则全量扫描并更新缓存 */
export async function scanDirectoryCached(root: string): Promise<string[]> {
  return scanDirectoriesCached([root])
}

/** 扫描多个音乐目录, 合并去重后排序 (r-1.0 多目录) */
export async function scanDirectories(dirs: string[]): Promise<string[]> {
  const set = new Set<string>()
  for (const d of dirs) {
    for (const f of await scanDirectory(d)) set.add(f)
  }
  return [...set].sort()
}

/** 多目录带缓存扫描: 所有目录 mtime 均未变则复用缓存, 否则全量重扫 */
export async function scanDirectoriesCached(dirs: string[]): Promise<string[]> {
  const cached = loadScanCache(dirs)
  if (cached) return cached
  const files = await scanDirectories(dirs)
  saveScanCache(dirs, files)
  return files
}

/** 去掉扩展名的名字 (用作默认歌名) */
export function titleOf(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf(".")
  return i > 0 ? b.slice(0, i) : b
}

export function dirBase(p: string): string {
  return basename(dirname(p))
}

export function isAudio(p: string): boolean {
  return AUDIO_EXTS.has(extname(p).toLowerCase())
}

export { sep }