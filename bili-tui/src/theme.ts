/**
 * Catppuccin 主题 — Latte (浅色) / Mocha (深色)
 * 色值来源: catppuccin-palette
 */

export type ThemeName = "mocha" | "latte"

export type Theme = {
  base: string
  mantle: string
  crust: string
  surface0: string
  surface1: string
  overlay: string
  subtext: string
  text: string
  blue: string
  sapphire: string
  lavender: string
  green: string
  yellow: string
  peach: string
  red: string
  mauve: string
  cyan: string
}

/** Mocha — 深色, 原版默认 */
const mocha: Theme = {
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  overlay: "#6c7086",
  subtext: "#a6adc8",
  text: "#cdd6f4",
  blue: "#89b4fa",
  sapphire: "#74c7ec",
  lavender: "#b4befe",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  red: "#f38ba8",
  mauve: "#cba6f7",
  cyan: "#89dceb",
}

/** Latte — 浅色, 明亮背景 */
const latte: Theme = {
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
  surface0: "#ccd0da",
  surface1: "#bcc0cc",
  overlay: "#9ca0b0",
  subtext: "#6c6f85",
  text: "#4c4f69",
  blue: "#1e66f5",
  sapphire: "#209fb5",
  lavender: "#7287fd",
  green: "#40a02b",
  yellow: "#df8e1d",
  peach: "#fe640b",
  red: "#d20f39",
  mauve: "#8839ef",
  cyan: "#04a5e5",
}

export const THEMES: Record<ThemeName, Theme> = { mocha, latte }

export const THEME_ORDER: ThemeName[] = ["mocha", "latte"]

export const THEME_LABEL: Record<ThemeName, string> = {
  mocha: "Mocha 摩卡",
  latte: "Latte 拿铁",
}

/** 从配置字符串解析主题名, 无效回退 mocha */
export function parseThemeName(raw: unknown): ThemeName {
  const s = String(raw ?? "").trim().toLowerCase()
  return (THEME_ORDER as string[]).includes(s) ? (s as ThemeName) : "mocha"
}
