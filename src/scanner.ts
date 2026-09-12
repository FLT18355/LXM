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
  const cached = loadScanCache(root)
  if (cached) return cached
  const files = await scanDirectory(root)
  saveScanCache(root, files)
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