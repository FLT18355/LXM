/**
 * UI 绘图基础函数 — 纯函数, 不持有状态。
 *
 * 约定:
 * - 宽度一律按终端显示列算 (CJK / 全角计 2 列), 截断与补齐都走这里,
 *   否则中文歌名会把右列时间挤出屏幕。
 * - 渐变只在这里产出 hex; 上层只传主题色。
 */
import type { TextChunk } from "@opentui/core"
import { fg } from "@opentui/core"

// ── 颜色 ─────────────────────────────────────────────────────

/** 线性混色 (支持 #rgb / #rrggbb); t=0 → a, t=1 → b */
export function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a
  if (t >= 1) return b
  const pick = (s: string, i: number) =>
    Number.parseInt(s.length === 4 ? s[1 + i] + s[1 + i] : s.slice(1 + i * 2, 3 + i * 2), 16) || 0
  let out = "#"
  for (let i = 0; i < 3; i++) {
    const ca = pick(a, i)
    const cb = pick(b, i)
    out += Math.round(ca + (cb - ca) * t).toString(16).padStart(2, "0")
  }
  return out
}

/** 循环色板采样: u 取模后相邻色插值 → 无级渐变 */
export function paletteAt(pal: readonly string[], u: number): string {
  const n = pal.length
  if (!n) return "#ffffff"
  const x = (((u % 1) + 1) % 1) * n
  const i = Math.floor(x)
  return mixHex(pal[i % n], pal[(i + 1) % n], x - i)
}

/** 0..1 圆滑脉冲 (周期 periodMs, 相位 0 取 0) */
export function pulse(now: number, periodMs: number): number {
  return 0.5 - 0.5 * Math.cos((now / periodMs) * Math.PI * 2)
}

// ── 宽度 / 截断 / 跑马灯 ─────────────────────────────────────

/** 单字符显示宽度 (CJK、全角标点、假名、韩文、emoji 计 2) */
export function charWidth(cp: number): number {
  if (cp === 0x200b || cp === 0xfeff) return 0
  if (cp < 0x1100) return 1
  if (cp <= 0x115f) return 2
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2
  if (cp >= 0xf900 && cp <= 0xfaff) return 2
  if (cp >= 0xfe30 && cp <= 0xfe6f) return 2
  if (cp >= 0xff00 && cp <= 0xff60) return 2
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2
  if (cp >= 0x20000 && cp <= 0x3fffd) return 2
  return 1
}

/** 显示宽度 (列) */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 按显示列截断 (超出部分丢弃, 不加省略号) */
export function clipWidth(text: string, maxw: number): string {
  if (maxw <= 0) return ""
  let w = 0
  let out = ""
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > maxw) break
    out += ch
    w += cw
  }
  return out
}

/** 按显示列截断并补空格到恰好 width 列 (不足则右侧空格) */
export function fitWidth(text: string, width: number): string {
  const t = clipWidth(text, width)
  return t + " ".repeat(Math.max(0, width - displayWidth(t)))
}

/**
 * 超长文本行内滚动 (跑马灯): 未超宽原样返回; 超宽时每秒 10 步来回滚动, 两端停 4 步。
 * phase 由调用方传 (以选中变化为锚点重新计数, 避免切行时文字跳位)。
 */
export function scrollText(text: string, maxw: number, phase: number): string {
  if (maxw <= 0) return ""
  const full = displayWidth(text)
  if (full <= maxw) return text
  // 步数按"列"而不是字符算, 中文才不会滚过头
  const steps = Math.max(1, full - maxw)
  const period = steps + 8
  const p = ((phase % (period * 2)) + period * 2) % (period * 2)
  const off = p < period ? Math.min(steps, Math.max(0, p - 4)) : Math.min(steps, Math.max(0, steps - (p - period - 4)))
  // 从第 off 列开始截取
  let w = 0
  let out = ""
  let skipping = true
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (skipping) {
      if (w + cw <= off) {
        w += cw
        continue
      }
      skipping = false
    }
    out += ch
    w += cw
    if (w >= off + maxw) break
  }
  return clipWidth(out, maxw)
}

// ── 数值格式 ─────────────────────────────────────────────────

/** 秒 → mm:ss (超过 1 小时显示 h:mm:ss) */
export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
}

/** 秒 → 紧凑时长 ("3:45"), 列表右列用 */
export function fmtShort(sec: number): string {
  if (!(sec > 0)) return "--:--"
  return fmt(sec)
}

// ── 进度条 / 频谱块 ──────────────────────────────────────────

/** 8 分块字符: 索引 0..7 对应 1/8..8/8 格 */
export const FRACTION_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]
/** 1..8 级竖条 (频谱用) */
export const LEVEL_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/**
 * 渐变进度条。width 列中按 ratio 填充, 用 1/8 块平滑;
 * 未播放段用 track 色; shine 为 0..1 的高光位置 (-1 关闭)。
 */
export function progressBar(opts: {
  width: number
  ratio: number
  palette: string[]
  track: string
  flow?: number
  shine?: number
  dim?: number
}): TextChunk[] {
  const width = Math.max(1, Math.floor(opts.width))
  const ratio = Math.max(0, Math.min(1, Number.isFinite(opts.ratio) ? opts.ratio : 0))
  const units = Math.round(width * 8 * ratio)
  const full = Math.floor(units / 8)
  const rem = units % 8
  const flow = opts.flow ?? 0
  const shine = opts.shine ?? -1
  const parts: TextChunk[] = []
  for (let i = 0; i < full; i++) {
    const u = i / Math.max(1, full)
    let col = paletteAt(opts.palette, u + flow)
    if (shine >= 0 && Math.abs(u - shine) < 0.08) col = mixHex(col, "#ffffff", 0.55)
    if (opts.dim) col = mixHex(col, opts.track, opts.dim)
    parts.push(fg(col)("█"))
  }
  if (rem > 0) {
    let col = paletteAt(opts.palette, (full + 0.5) / Math.max(1, full) + flow)
    if (opts.dim) col = mixHex(col, opts.track, opts.dim)
    parts.push(fg(col)(FRACTION_BLOCKS[rem - 1]))
  }
  const rest = width - full - (rem > 0 ? 1 : 0)
  if (rest > 0) parts.push(fg(opts.track)("─".repeat(rest)))
  return parts
}

/** 水平渐变细线, 两端向 edge 色淡出 (卡片顶/底装饰) */
export function gradientLine(width: number, palette: string[], edge: string, flow = 0, fade = 0.2): TextChunk[] {
  const w = Math.max(1, Math.floor(width))
  const parts: TextChunk[] = []
  for (let i = 0; i < w; i++) {
    let col = paletteAt(palette, i / Math.max(1, w - 1) + flow)
    const e = Math.min(i, w - 1 - i) / Math.max(1, (w - 1) * fade)
    if (e < 1) col = mixHex(edge, col, e)
    parts.push(fg(col)("─"))
  }
  return parts
}

/** 0..1 数值 → 8 级块字符 */
export function levelChar(v: number): string {
  const i = Math.max(0, Math.min(LEVEL_BLOCKS.length - 1, Math.round(v * (LEVEL_BLOCKS.length - 1))))
  return LEVEL_BLOCKS[i]
}