/**
 * 版本号 — 全项目唯一来源。
 *
 * index.ts (HELP / --version)、src/ui.ts (设置"版本"行 / 帮助标题) 都从这里 import,
 * 改版本只动这一处。package.json 的 `version` 字段仍需手动同步 (JSON 无法 import TS)。
 */
export const VERSION = "r-0.5"
