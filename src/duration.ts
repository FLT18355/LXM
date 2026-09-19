/**
 * 后台批量探测歌曲时长 — 独立 mpv 实例逐首 loadfile 拿 duration
 *
 * 主播放器一次只报当前曲的时长; 要让列表右侧显示每首时长, 起一个
 * --idle 的探测实例, 逐首 loadfile → 等 file-loaded → 轮询 duration → 下一首。
 * 串行且带间隔, 每秒约 3~5 首, 数百首会在后台几分钟内渐进填满 (UI 逐首刷新)。
 * 探测失败/无 mpv 时静默退出, 不影响主程序。
 */
import { tmpdir } from "os"
import { join } from "path"
import { rmSync } from "fs"
import { MpvClient, waitForSocket } from "./mpv"

const POLL_MAX = 20 // file-loaded 后最多等 20 × 100ms = 2s
const POLL_GAP = 100
const BETWEEN = 60 // 相邻探测间隔, 降低瞬时负载

/**
 * 逐首探测 duration 并回调 onOne(path, seconds); 全部结束回调 onDone。
 * 返回的 Promise 在探测进程退出/失败时 resolve (不抛错)。
 */
export async function probeDurations(
  paths: string[],
  onOne: (path: string, dur: number) => void,
  onDone?: () => void,
  onProc?: (proc: Bun.Subprocess) => void,
): Promise<void> {
  if (!paths.length) return
  const socket = join(tmpdir(), `lanxi_probe_${process.pid}.sock`)
  try {
    rmSync(socket, { force: true })
  } catch {
    /* ignore */
  }
  let proc: Bun.Subprocess | null = null
  try {
    proc = Bun.spawn(
      ["mpv", "--idle=yes", "--no-video", `--input-ipc-server=${socket}`, "--terminal=no", "--quiet", "--no-config"],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    )
    onProc?.(proc)
    if (!(await waitForSocket(socket, 5000))) {
      proc.kill()
      return
    }
    const c = new MpvClient()
    await c.connect(socket, 40, 100)
    const remaining = [...paths]
    let busy = false

    const next = async () => {
      if (busy) return
      if (!remaining.length) {
        c.close()
        proc?.kill()
        onDone?.()
        return
      }
      busy = true
      const path = remaining.shift()!
      await c.loadfile(path, "replace")
      // file-loaded 后轮询 duration (首次可能未就绪)
      let dur = 0
      for (let i = 0; i < POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, POLL_GAP))
        const d = await c.getProperty<number>("duration")
        if (typeof d === "number" && Number.isFinite(d) && d > 0) {
          dur = d
          break
        }
      }
      if (dur > 0) onOne(path, dur)
      await new Promise((r) => setTimeout(r, BETWEEN))
      busy = false
      void next()
    }
    void next()
  } catch {
    try {
      proc?.kill()
    } catch {
      /* ignore */
    }
  }
}