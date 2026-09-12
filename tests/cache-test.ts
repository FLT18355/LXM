// 回归测试: 缓存模块 — state.toml 读写、scan-cache mtime 校验、clearCache
import { join } from "path"
import { tmpdir } from "os"
import { rmSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs"

// 隔离: 把 LXM_CACHE_DIR 指向进程专属临时目录 (同 playlist-test-env 模式)
const TEST_CACHE_DIR = join(tmpdir(), `lxm-cache-test-${process.pid}`)
rmSync(TEST_CACHE_DIR, { force: true })
mkdirSync(TEST_CACHE_DIR, { recursive: true })
process.env["LXM_CACHE_DIR"] = TEST_CACHE_DIR

// 在设置 env 之后导入, CACHE_DIR 才指向临时路径
const { ensureCacheDir, saveState, loadState, saveScanCache, loadScanCache, clearCache, cacheSize, CACHE_DIR } =
  await import("../src/cache")

console.log("CACHE_DIR =", CACHE_DIR, "(期望临时目录)")
if (CACHE_DIR !== TEST_CACHE_DIR) { console.log("FAIL: CACHE_DIR 未隔离"); process.exit(1) }

// 1. state 读写 round-trip
saveState({ last_path: "/m/稻香.mp3", last_pos: 42.5 })
const st = loadState()
console.log("state:", JSON.stringify(st), "(期望 last_path + last_pos)")
if (st.last_path !== "/m/稻香.mp3" || st.last_pos !== 42.5) { console.log("FAIL: state 读写"); process.exit(1) }

// 2. state 合并: saveState 不覆盖未传键
saveState({ last_pos: 99.9 })
const st2 = loadState()
console.log("合并后:", JSON.stringify(st2), "(期望 last_path 保留, last_pos 更新)")
if (st2.last_path !== "/m/稻香.mp3" || st2.last_pos !== 99.9) { console.log("FAIL: state 合并"); process.exit(1) }

// 3. scan-cache mtime 校验
const scanDir = TEST_CACHE_DIR // 用临时目录自己当被扫描目录
saveScanCache(scanDir, ["a.mp3", "b.flac"])
const hit = loadScanCache(scanDir)
console.log("scan缓存命中:", JSON.stringify(hit), "(期望 [a.mp3, b.flac])")
if (!hit || hit.length !== 2) { console.log("FAIL: scan-cache 未命中"); process.exit(1) }

// 4. mtime 变化 → 缓存失效 (touch 目录)
const now = Date.now() / 1000
await new Promise<void>(r => setTimeout(r, 1100)) // 等 1s 让 mtime 可变
const sub = join(scanDir, "newfile.tmp")
writeFileSync(sub, "x")
const miss = loadScanCache(scanDir)
console.log("touch后命中:", JSON.stringify(miss), "(期望 null)")
if (miss !== null) { console.log("FAIL: mtime 未失效"); process.exit(1) }

// 5. clearCache
const before = cacheSize()
const n = clearCache()
const after = cacheSize()
console.log("清空前:", before, "清空:", n, "项, 清空后:", after, "(期望 after=0)")
if (after !== 0) { console.log("FAIL: clearCache 不彻底"); process.exit(1) }

// 6. ensureCacheDir 不抛
ensureCacheDir()
if (!existsSync(CACHE_DIR)) { console.log("FAIL: ensureCacheDir 未建目录"); process.exit(1) }

rmSync(TEST_CACHE_DIR, { force: true, recursive: true })
console.log("\nCACHE TEST PASS")