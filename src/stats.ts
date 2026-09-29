/**
 * 音乐库统计 (r-1.0) — 统计面板的数据来源
 *
 * 纯计算, 无副作用 (除读 plays.toml)。UI 只负责渲染成条形图。
 * 数据来源: playlist / durations 内存缓存 / plays.toml (含 last 时间戳)。
 */
import { extname } from "path"
import { titleOf, dirBase } from "./scanner"
import { recentPlays, type PlayCount } from "./cache"
import type { Player } from "./player"

export type StatsBucket = {
  /** 主标签 (格式名 / 歌名) */
  label: string
  /** 数值 (数量 / 次数) */
  value: number
  /** 附加说明 (目录 / 相对时间等) */
  extra?: string
}

export type LibraryStats = {
  tracks: number
  /** 已知时长合计 (秒); 未探测的曲目不计入 */
  knownDurSec: number
  /** 已探测时长的曲目数 (用于标注覆盖度) */
  knownDurCount: number
  totalPlays: number
  favorites: number
  playlists: number
  dirs: number
  /** 格式分布 (按数量降序) */
  formats: StatsBucket[]
  /** 播放次数 Top (按次数降序, 只含播过的) */
  topPlays: StatsBucket[]
  /** 最近播放 (按 last 时间倒序) */
  recent: StatsBucket[]
}

const RECENT_LIMIT = 4
const TOP_LIMIT = 5
const FORMAT_LIMIT = 5

function normExt(p: string): string {
  const e = extname(p).toLowerCase()
  return e.length > 1 ? e.slice(1) : "?"
}

/** 计算当前音乐库统计快照 */
export function computeStats(p: Player, now = Date.now()): LibraryStats {
  let knownDurSec = 0
  let knownDurCount = 0
  const fmt = new Map<string, number>()
  const dirs = new Map<string, number>()
  for (const path of p.playlist) {
    const d = p.durationOf(path)
    if (d > 0) {
      knownDurSec += d
      knownDurCount++
    }
    const e = normExt(path)
    fmt.set(e, (fmt.get(e) ?? 0) + 1)
    const dr = dirBase(path)
    dirs.set(dr, (dirs.get(dr) ?? 0) + 1)
  }

  const formats: StatsBucket[] = [...fmt.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, FORMAT_LIMIT)

  // 播放次数 Top: 用内存计数 (playCountOf) 交叉音乐库, 只算仍在库中的曲目
  const topPlays: StatsBucket[] = []
  for (const path of p.playlist) {
    const c = p.playCountOf(path)
    if (c > 0) topPlays.push({ label: titleOf(path), value: c, extra: dirBase(path) })
  }
  topPlays.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))

  const recent: StatsBucket[] = recentPlays(64)
    .map((x: PlayCount) => ({ label: titleOf(x.path), value: x.last ?? 0, extra: x.path }))
    .filter((x) => x.value > 0)
    .slice(0, RECENT_LIMIT)

  return {
    tracks: p.playlist.length,
    knownDurSec,
    knownDurCount,
    totalPlays: p.totalPlayCount,
    favorites: p.favorites.length,
    playlists: p.playlists.length,
    dirs: p.scanRoots().length,
    formats,
    topPlays: topPlays.slice(0, TOP_LIMIT),
    recent,
  }
}

/** 秒 → "Xh Ym" / "Ym" 精简时长 */
export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** epoch ms → "刚刚 / N 分钟前 / N 小时前 / N 天前" */
export function fmtAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  const min = Math.floor(d / 60000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
