/**
 * mpv JSON IPC 客户端 — 通过 unix socket 与 mpv 通信
 *
 * 协议: 发送 {"command": [...], "request_id": N}\n, 接收按 \n 分隔的 JSON 行.
 * - 含 request_id 的行是命令响应
 * - 含 event 的行是 mpv 事件 (property-change / end-file / ...)
 */
import { existsSync } from "fs"

export type MpvEvent = Record<string, unknown> & { event: string }
export type MpvResponse = { request_id: number; error?: string; data?: unknown }

type EventHandler = (ev: MpvEvent) => void

const REQ_TIMEOUT = 4000

export class MpvClient {
  private sock: any = null
  private reqId = 0
  private pending = new Map<number, { resolve: (r: MpvResponse | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private buf = ""
  private handlers = new Set<EventHandler>()
  private closed = false
  connected = false

  /** 等待 socket 就绪并连接 (自动重试) */
  async connect(socketPath: string, retries = 40, delayMs = 100): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.tryConnect(socketPath)
        return
      } catch {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw new Error("无法连接 mpv IPC socket")
  }

  private tryConnect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      Bun.connect({
        unix: socketPath,
        socket: {
          open: (socket: any) => {
            this.sock = socket
            this.connected = true
            resolve()
          },
          data: (_socket: any, data: Uint8Array) => {
            this.onData(Buffer.from(data).toString("utf-8"))
          },
          close: (_socket: any) => {
            this.connected = false
            this.sock = null
            if (!this.closed) this.flushPending()
          },
          error: (_socket: any, err: Error) => {
            this.connected = false
            this.sock = null
            reject(err)
          },
        },
      }).catch(reject)
    })
  }

  private onData(chunk: string) {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const rec = obj as Record<string, unknown>
      if (typeof rec.request_id === "number") {
        const p = this.pending.get(rec.request_id)
        if (p) {
          this.pending.delete(rec.request_id)
          clearTimeout(p.timer)
          p.resolve(rec as MpvResponse)
        }
      }
      if (typeof rec.event === "string") {
        const ev = rec as MpvEvent
        for (const h of this.handlers) {
          try {
            h(ev)
          } catch {
            /* handler error 不中断 */
          }
        }
      }
    }
  }

  private flushPending() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(null)
    }
    this.pending.clear()
  }

  /** 发送命令并等待响应; 超时/断线返回 null */
  command(name: string, ...args: unknown[]): Promise<MpvResponse | null> {
    const id = ++this.reqId
    const payload = JSON.stringify({ command: [name, ...args], request_id: id })
    return new Promise((resolve) => {
      if (!this.sock || !this.connected) {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, REQ_TIMEOUT)
      this.pending.set(id, { resolve, timer })
      try {
        this.sock.write(payload + "\n")
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  /** 订阅 mpv 事件, 返回取消函数 */
  onEvent(h: EventHandler): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  // ---------- 便捷封装 ----------

  loadfile(path: string, mode: "replace" | "append" = "replace", opts: Record<string, string | number> = {}) {
    const extra = Object.entries(opts)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `--${k}=${v}`)
    return this.command("loadfile", path, mode, ...(extra as unknown[]))
  }

  setProperty(name: string, value: unknown) {
    return this.command("set_property", name, value)
  }

  async getProperty<T = unknown>(name: string): Promise<T | undefined> {
    const r = await this.command("get_property", name)
    return r?.data as T | undefined
  }

  observeProperty(id: number, name: string) {
    return this.command("observe_property", id, name)
  }

  pause(v: boolean) {
    return this.setProperty("pause", v)
  }

  seek(seconds: number, absolute = false) {
    if (absolute) return this.command("seek", seconds, "absolute")
    return this.command("seek", seconds, "relative")
  }

  /** 触发 mpv 优雅退出 (空 idle 时用 quit) */
  quit() {
    return this.command("quit")
  }

  /** 关闭 socket (不通知 mpv) */
  close() {
    this.closed = true
    this.flushPending()
    try {
      this.sock?.close?.()
    } catch {
      /* ignore */
    }
    this.sock = null
    this.connected = false
  }
}

/** 等待 unix socket 文件出现 (mpv 启动建立) */
export async function waitForSocket(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (existsSync(path)) return true
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return existsSync(path)
}