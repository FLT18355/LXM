/**
 * Catppuccin 四口味主题 — Latte / Frappé / Macchiato / Mocha
 * 色值来源: ~/.config/opencode/skills/catppuccin-palette
 */

export type ThemeName = "latte" | "frappe" | "macchiato" | "mocha"

export type Theme = {
  base: string
  mantle: string
  crust: string
  surface0: string
  surface1: string
  surface2: string
  overlay: string
  subtext: string
  text: string
  sky: string
  green: string
  yellow: string
  pink: string
  lavender: string
  blue: string
  peach: string
  red: string
  white: string
}

/** Latte — 浅色, 明亮背景 */
const latte: Theme = {
  base: "#eff1f5",
  mantle: "#e6e9ef",
  crust: "#dce0e8",
  surface0: "#ccd0da",
  surface1: "#bcc0cc",
  surface2: "#acb0be",
  overlay: "#9ca0b0",
  subtext: "#6c6f85",
  text: "#4c4f69",
  sky: "#04a5e5",
  green: "#40a02b",
  yellow: "#df8e1d",
  pink: "#ea76cb",
  lavender: "#7287fd",
  blue: "#1e66f5",
  peach: "#fe640b",
  red: "#d20f39",
  white: "#ffffff",
}

/** Frappé — 深色中对比度最低、最柔和 */
const frappe: Theme = {
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634",
  surface0: "#414559",
  surface1: "#51576d",
  surface2: "#626880",
  overlay: "#737994",
  subtext: "#a5adce",
  text: "#c6d0f5",
  sky: "#99d1db",
  green: "#a6d189",
  yellow: "#e5c890",
  pink: "#f4b8e4",
  lavender: "#babbf1",
  blue: "#8caaee",
  peach: "#ef9f76",
  red: "#e78284",
  white: "#ffffff",
}

/** Macchiato — 对比度中等, 色调柔和 */
const macchiato: Theme = {
  base: "#24273a",
  mantle: "#1e2030",
  crust: "#181926",
  surface0: "#363a4f",
  surface1: "#494d64",
  surface2: "#5b6078",
  overlay: "#6e738d",
  subtext: "#a5adcb",
  text: "#cad3f5",
  sky: "#91d7e3",
  green: "#a6da95",
  yellow: "#eed49f",
  pink: "#f5bde6",
  lavender: "#b7bdf8",
  blue: "#8aadf4",
  peach: "#f5a97f",
  red: "#ed8796",
  white: "#ffffff",
}

/** Mocha — 原版, 最深、色彩最丰富 */
const mocha: Theme = {
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  overlay: "#6c7086",
  subtext: "#a6adc8",
  text: "#cdd6f4",
  sky: "#89dceb",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  pink: "#f5c2e7",
  lavender: "#b4befe",
  blue: "#89b4fa",
  peach: "#fab387",
  red: "#f38ba8",
  white: "#ffffff",
}

export const THEMES: Record<ThemeName, Theme> = { latte, frappe, macchiato, mocha }

export const THEME_ORDER: ThemeName[] = ["latte", "frappe", "macchiato", "mocha"]

export const THEME_LABEL: Record<ThemeName, string> = {
  latte: "Latte 拿铁",
  frappe: "Frappé 冰沙",
  macchiato: "Macchiato 玛奇朵",
  mocha: "Mocha 摩卡",
}

/** 从配置字符串解析主题名, 无效回退 latte */
export function parseThemeName(raw: unknown): ThemeName {
  const s = String(raw ?? "").trim().toLowerCase()
  return (THEME_ORDER as string[]).includes(s) ? (s as ThemeName) : "latte"
}