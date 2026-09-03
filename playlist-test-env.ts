// 测试数据隔离副作用模块 — 必须作为测试文件的【第一条 import】求值。
// ESM 按 import 声明顺序执行: 本模块把 LXM_PLAYLISTS_FILE 指向进程专属临时路径后,
// 后续的 ./src/player → ./src/playlists 链才会读取到它, 从而彻底不碰用户真实歌单。
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"

export const TEST_PLAYLISTS_FILE = join(tmpdir(), `lxm-pl-test-${process.pid}.toml`)
rmSync(TEST_PLAYLISTS_FILE, { force: true })
process.env["LXM_PLAYLISTS_FILE"] = TEST_PLAYLISTS_FILE
