// 测试数据隔离副作用模块 — 必须作为测试文件的【第一条 import】求值。
// 本测试真的会改名/删除磁盘文件, 所以缓存目录、歌单文件、配置文件、音乐目录
// 全部指向进程专属临时路径, 绝不碰主人的真实音乐库与 ~/.config/lxmusic/。
import { join } from "path"
import { tmpdir } from "os"
import { rmSync, mkdirSync, writeFileSync } from "fs"

export const TEST_ROOT = join(tmpdir(), `lxm-track-ops-${process.pid}`)
export const TEST_CACHE_DIR = join(TEST_ROOT, "cache")
export const TEST_PLAYLISTS_FILE = join(TEST_ROOT, "playlists.toml")
export const TEST_CONFIG_FILE = join(TEST_ROOT, "config.toml")
export const TEST_MUSIC_DIR = join(TEST_ROOT, "music")
/** 子目录: 里面的文件改名/删除不会改变根目录 mtime — 扫描缓存必须靠手动同步 */
export const TEST_SUB_DIR = join(TEST_MUSIC_DIR, "sub")

rmSync(TEST_ROOT, { recursive: true, force: true })
mkdirSync(TEST_SUB_DIR, { recursive: true })
// 预置音频文件 (内容无所谓, 只验证文件系统语义与数据同步)
writeFileSync(join(TEST_MUSIC_DIR, "稻香.mp3"), "dummy")
writeFileSync(join(TEST_MUSIC_DIR, "雾里.flac"), "dummy")
writeFileSync(join(TEST_SUB_DIR, "平凡之路.ogg"), "dummy")
writeFileSync(join(TEST_MUSIC_DIR, "稻香.lrc"), "[00:01.00]躺在你学校的操场")

process.env["LXM_CACHE_DIR"] = TEST_CACHE_DIR
process.env["LXM_PLAYLISTS_FILE"] = TEST_PLAYLISTS_FILE
process.env["LXM_CONFIG_FILE"] = TEST_CONFIG_FILE