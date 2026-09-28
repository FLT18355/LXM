/**
 * UI 排版工具 — CJK 显示宽度截断 · chip · keycap · 渐变条
 * 独立于 App 状态机, 纯函数 + StyledText 工厂
 */
import { t, bold, fg, bg, StyledText, type TextChunk } from "@opentui/core"
import type { Theme } from "./theme"

// ---------------------------------------------------------------- Nerd Font 图标

/**
 * Nerd Font 图标 (Font Awesome 私有区, 全部占 1 列)。
 * 需要终端字体已打 Nerd Font 补丁; 未打补丁时显示为豆腐块。
 */
export const ICON = {
  /** nf-fa-folder */
  folder: "\uf07b",
  /** nf-fa-clock_o */
  clock: "\uf017",
  /** nf-fa-music */
  music: "\uf001",
  /** nf-fa-video_camera */
  video: "\uf03d",
  /** nf-fa-search */
  search: "\uf002",
  /** nf-fa-tint (水滴) */
  tint: "\uf043",
} as const

// ---------------------------------------------------------------- CJK 显示宽度

/**
 * 估算字符串在终端的显示宽度。
 * CJK / 全角字符算 2 列, 其余按 1 列, ANSI 控制符不计。
 * 与真实 wcwidth 不完全一致但足够用于截断对齐。
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20) continue // 控制符
    // 零宽
    if (c === 0x200d || c === 0xfe0f) continue
    // CJK 统一表意 + 扩展 + 日韩补充 + 全角标点
    if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3040 && c <= 0x33bf) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f9ff)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

/** 按显示宽度截断; 尾部加省略号占 1 列 */
export function truncateW(s: string, n: number): string {
  if (displayWidth(s) <= n) return s
  let w = 0
  let out = ""
  for (const ch of s) {
    const cw = displayWidth(ch)
    if (w + cw > n - 1) break
    out += ch
    w += cw
  }
  return out + "…"
}

// ---------------------------------------------------------------- chip / keycap

/** 胶囊标签: 返回单块 TextChunk, 可直接嵌入 t`` 模板 */
export function chip(label: string, th: Theme, opts?: { fg?: string; bg?: string; bold?: boolean }): TextChunk {
  const fgColor = opts?.fg ?? th.text
  const bgColor = opts?.bg ?? th.surface0
  const body = opts?.bold ? bold(fg(fgColor)(` ${label} `)) : fg(fgColor)(` ${label} `)
  return bg(bgColor)(body)
}

/** 键帽: 返回单块 TextChunk */
export function keycap(key: string, th: Theme, opts?: { fg?: string; bg?: string }): TextChunk {
  const fgColor = opts?.fg ?? th.yellow
  const bgColor = opts?.bg ?? th.surface0
  return bg(bgColor)(fg(fgColor)(` ${key} `))
}

/** 形如  K ┊ K  label  的键→说明行, 多键用 ┊ 分隔 */
export function keyHint(keys: string[], desc: string, th: Theme, opts?: { fg?: string; bg?: string }): StyledText {
  // 直接构建 chunks 数组, 避免 t`` 嵌套 StyledText
  const chunks: TextChunk[] = []
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) chunks.push(fg(th.overlay)("┊"))
    chunks.push(keycap(keys[i], th, opts))
  }
  chunks.push(fg(th.overlay)("  "))
  chunks.push(fg(th.subtext)(desc))
  return new StyledText(chunks)
}

// ---------------------------------------------------------------- 渐变进度条

const BAR_CHARS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]

/**
 * 渐变进度条: 按百分比从 green → cyan → blue 分段着色, 尾部显示百分比。
 * 宽度自适应终端宽度。
 */
export function progressBar(pct: number, th: Theme, maxW?: number): StyledText {
  const w = Math.max(20, Math.min(72, (maxW ?? 72)))
  const p = Math.max(0, Math.min(100, pct))
  const total = w - 8 // 留给百分比文字
  const filledF = (p / 100) * total
  const filled = Math.floor(filledF)
  const rem = filledF - filled
  const remChar = rem > 0 ? BAR_CHARS[Math.round(rem * (BAR_CHARS.length - 1))] : ""
  const empty = "─".repeat(Math.max(0, total - filled - (remChar ? 1 : 0)))

  // 分三段着色
  const seg1 = Math.ceil(filled * 0.33)
  const seg2 = Math.ceil(filled * 0.66)
  const s1 = "█".repeat(Math.max(0, seg1))
  const s2 = "█".repeat(Math.max(0, seg2 - seg1))
  const s3 = "█".repeat(Math.max(0, filled - seg2))

  const pctText = ` ${p.toFixed(1)}%`
  return t`${fg(th.green)(s1)}${fg(th.cyan)(s2)}${fg(th.blue)(s3)}${fg(th.lavender)(remChar)}${fg(th.surface1)(empty)}${fg(th.subtext)(pctText)}`
}

// ---------------------------------------------------------------- 辅助: pad/center

/** 用空格填充到指定显示宽度 */
export function padEndW(s: string, n: number): string {
  const d = displayWidth(s)
  return d >= n ? s : s + " ".repeat(n - d)
}

/** 用空格左侧填充到指定显示宽度 */
export function padStartW(s: string, n: number): string {
  const d = displayWidth(s)
  return d >= n ? s : " ".repeat(n - d) + s
}

/** 居中到指定宽度 */
export function centerW(s: string, n: number): string {
  const d = displayWidth(s)
  if (d >= n) return s
  const left = Math.floor((n - d) / 2)
  return " ".repeat(left) + s + " ".repeat(n - d - left)
}
