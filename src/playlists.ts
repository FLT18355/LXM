/**
 * 歌单持久化 — 独立 TOML 文件, 存于 ~/.config/lxmusic/playlists.toml
 *
 * 数据格式 (TOML 子表数组):
 *   [[playlist]]
 *   name = "睡前轻音乐"
 *   paths = ["/abs/path/a.mp3", "/abs/path/b.flac"]
 *
 *   [[playlist]]
 *   name = "通勤"
 *   paths = []
 *
 * 单独文件的好处:
 *   - 不污染主 config.toml (与 Python 版 lxm.py 兼容)
 *   - 不需要把 parseToml 升级成完整 TOML 解析器
 *   - 增删歌单写盘时只覆盖本文件
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { CONFIG_DIR } from "./config"

// 测试可用 LXM_PLAYLISTS_FILE 指向临时文件, 避免读写污染用户真实歌单
export const PLAYLISTS_FILE = process.env["LXM_PLAYLISTS_FILE"] || join(CONFIG_DIR, "playlists.toml")

export type Playlist = {
  /** 唯一名, 也作为显示标题; 重命名时直接改这个 */
  name: string
  /** 歌曲绝对路径列表 (去重) */
  paths: string[]
}

const HEADER = `# 歌单文件 — 由 lxm-tui 自动管理
# 格式: [[playlist]] 表示一个歌单, 下面跟 name / paths
`

/** 解析 [[playlist]] 子表数组. 失败/不存在返回 []. */
export function loadPlaylists(): Playlist[] {
  try {
    if (!existsSync(PLAYLISTS_FILE)) return []
    const src = readFileSync(PLAYLISTS_FILE, "utf-8")
    const out: Playlist[] = []
    let cur: Playlist | null = null
    for (const raw of src.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      // [[playlist]] 标记: 开始/切换到一个新歌单
      if (line.startsWith("[[") && line.endsWith("]]")) {
        if (cur) out.push(cur)
        cur = { name: "", paths: [] }
        continue
      }
      // 单 key=value
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
      if (!m || !cur) continue
      const key = m[1]
      const val = m[2].trim()
      if (key === "name" && val.startsWith('"')) {
        cur.name = val.replace(/^"|"$/g, "").replace(/\\"/g, '"')
      } else if (key === "paths" && val.startsWith("[")) {
        cur.paths = [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1])
      }
    }
    if (cur) out.push(cur)
    // 兜底: 过滤空名
    return out.filter((p) => p.name.length > 0)
  } catch {
    return []
  }
}

/** 整文件覆盖写回. */
export function savePlaylists(list: Playlist[]): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  const lines: string[] = [HEADER, ""]
  for (const p of list) {
    if (!p.name) continue
    lines.push("[[playlist]]")
    lines.push(`name = "${p.name.replace(/"/g, '\\"')}"`)
    const arr = p.paths.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(", ")
    lines.push(`paths = [${arr}]`)
    lines.push("")
  }
  try {
    writeFileSync(PLAYLISTS_FILE, lines.join("\n"))
  } catch {
    /* ignore */
  }
}
