// 测试数据隔离副作用模块 — 必须作为测试文件的【第一条 import】求值。
// 把 LXM_CACHE_DIR 指向进程专属临时目录, 后续 import 的 cache(saveState/bumpPlay/
// loadPlays) 全部读写它, 绝不碰用户真实的 ~/.cache/lxmusic/。
import { join } from "path"
import { tmpdir } from "os"
import { rmSync, mkdirSync } from "fs"

export const TEST_CACHE_DIR = join(tmpdir(), `lxm-feat-cache-${process.pid}`)
rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
mkdirSync(TEST_CACHE_DIR, { recursive: true })
process.env["LXM_CACHE_DIR"] = TEST_CACHE_DIR