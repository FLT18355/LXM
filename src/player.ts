/**
 * 播放器状态与逻辑 — 移植自 lxm.py 的 Player
 */
import { baseName, titleOf, dirBase } from "./scanner"
import { findLrc, parseLrc, type LyricLine, type LyricTag } from "./lrc"
import { saveConfig } from "./config"
import { loadPlaylists, savePlaylists, type Playlist } from "./playlists"
import type { MpvClient } from "./mpv"

export type RepeatMode = "OFF" | "ALL" | "ONE"
export const REPEAT_CYCLE: RepeatMode[] = ["OFF", "ALL", "ONE"]

export class Player {
  playlist: string[] = []
  musicDir = ""
  idx = 0
  queue: number[] = []
  repeat: RepeatMode = "OFF"
  isShuffle = false

  playing = false
  paused = false
  currentPath: string | null = null

  lyrics: LyricLine[] = []
  lyricTags: LyricTag[] = []
  showLyrics = true

  volume = 100
  muted = false
  speed = 1.0
  favorites: string[] = []
  favMode = false

  // 歌单: 加载一次, 增删改时立刻写回 playlists.toml
  playlists: Playlist[] = []

  // 淡入淡出
  fadeState: "in" | "out" | null = null
  fadeVol = 100

  // 断点续播
  pendingSeek: number | null = null

  // 切歌中: 抑制旧文件的 end-file 事件, 避免多米诺切歌
  suppressEndFile = false
  private suppressTimer: ReturnType<typeof setTimeout> | null = null

  // UI 状态 (由 UI 每帧更新)
  timePos = 0
  duration = 0
  titleTag = ""
  artistTag = ""

  constructor(readonly mpv: MpvClient) {}

  // ---------- 列表逻辑 ----------

  nextIndex(step = 1): number | null {
    if (!this.queue.length) return null
    if (this.queue.length === 1) return this.queue[0]
    const pos = this.queue.indexOf(this.idx)
    const base = pos === -1 ? 0 : pos
    return this.queue[(base + step + this.queue.length) % this.queue.length]
  }

  // ---------- 播放控制 ----------

  async playIndex(i: number): Promise<void> {
    if (!this.playlist.length) return
    this.idx = ((i % this.playlist.length) + this.playlist.length) % this.playlist.length
    const path = this.playlist[this.idx]
    this.currentPath = path
    // 切歌中: 旧文件会触发 end-file(stop), 先抑制, 等新文件加载完成(file-loaded)再恢复
    this.suppressEndFile = true
    if (this.suppressTimer) clearTimeout(this.suppressTimer)
    // 兜底: 若 mpv 没发 file-loaded, 2 秒后自动恢复 (防止永远抑制)
    this.suppressTimer = setTimeout(() => {
      this.suppressEndFile = false
      this.suppressTimer = null
    }, 2000)
    await this.loadLyrics(path)
    const opts: Record<string, string | number> = {}
    if (this.repeat === "ONE") opts["loop-file"] = "inf"
    await this.mpv.loadfile(path, "replace", opts)
    await this.mpv.setProperty("speed", this.speed)
    this.playing = true
    this.paused = false
    this.timePos = 0
    this.duration = 0
    // 主动补拉时长: observe_property 事件可能延迟, 直接拉一次当前值
    this.mpv.getProperty<number>("duration").then((d) => {
      if (typeof d === "number" && Number.isFinite(d) && d > 0) this.duration = d
    })
    // 淡入: 新歌音量从低渐升
    this.fadeVol = 0
    this.fadeState = "in"
    await this.mpv.setProperty("volume", 0)
  }

  /** 新文件加载完成: 恢复 end-file 处理, 并补拉时长 */  onFileLoaded(): void {
    this.suppressEndFile = false
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer)
      this.suppressTimer = null
    }
    this.mpv.getProperty<number>("duration").then((d) => {
      if (typeof d === "number" && Number.isFinite(d) && d > 0) this.duration = d
    })
  }

  async loadLyrics(path: string): Promise<void> {
    const lrc = await findLrc(path)
    if (lrc) {
      const r = await parseLrc(lrc)
      this.lyrics = r.lines
      this.lyricTags = r.tags
      this.titleTag = r.tags.find(([k]) => k === "ti")?.[1] ?? ""
      this.artistTag = r.tags.find(([k]) => k === "ar")?.[1] ?? ""
    } else {
      this.lyrics = []
      this.lyricTags = []
      this.titleTag = ""
      this.artistTag = ""
    }
  }

  async togglePause(playerUi?: { flash: (msg: string) => void }): Promise<void> {
    if (!this.playing) return
    this.paused = !this.paused
    await this.mpv.pause(this.paused)
    playerUi?.flash(this.paused ? "已暂停喵~" : "继续播放~")
  }

  async advance(step = 1): Promise<void> {
    if (!this.queue.length) return
    const cur = this.idx
    const pos = this.queue.indexOf(cur)
    const base = pos === -1 ? 0 : pos
    let np = base + step
    if (this.repeat === "OFF") {
      if (np < 0 || np >= this.queue.length) return
    }
    np = ((np % this.queue.length) + this.queue.length) % this.queue.length
    await this.playIndex(this.queue[np])
  }

  /** mpv end-file 时调用 */
  async maybeAdvance(): Promise<void> {
    if (this.repeat === "ONE") {
      await this.playIndex(this.idx)
      return
    }
    await this.advance(1)
  }

  // ---------- 模式切换 ----------

  toggleShuffle(): void {
    this.isShuffle = !this.isShuffle
    if (this.isShuffle) {
      const rest = Array.from({ length: this.playlist.length }, (_, i) => i).filter((i) => i !== this.idx)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j], rest[i]]
      }
      this.queue = [this.idx, ...rest]
    } else {
      this.queue = Array.from({ length: this.playlist.length }, (_, i) => i)
    }
  }

  cycleRepeat(): void {
    const i = REPEAT_CYCLE.indexOf(this.repeat)
    this.repeat = REPEAT_CYCLE[(i + 1) % REPEAT_CYCLE.length]
  }

  // ---------- 收藏 ----------

  toggleFavorite(targetIdx: number): boolean {
    const target = this.playlist[targetIdx]
    const inFav = this.favorites.includes(target)
    if (inFav) this.favorites = this.favorites.filter((x) => x !== target)
    else this.favorites.push(target)
    saveConfig({ favorites: [...this.favorites] })
    return !inFav
  }

  /** 从选中位置映射到真实播放列表索引 (搜索/收藏等过滤模式: sel 是队列内位置) */
  selToPlaylistIdx(sel: number, isFiltered: boolean): number {
    if (isFiltered && this.queue.length) {
      return this.queue[((sel % this.queue.length) + this.queue.length) % this.queue.length]
    }
    return Math.max(0, Math.min(this.playlist.length - 1, sel))
  }

  toggleFavMode(): boolean {
    if (this.favMode) {
      this.favMode = false
      this.queue = Array.from({ length: this.playlist.length }, (_, i) => i)
    } else {
      if (!this.favorites.length) return false
      const favIdx = this.playlist.map((x, i) => (this.favorites.includes(x) ? i : -1)).filter((i) => i >= 0)
      if (!favIdx.length) return false
      this.favMode = true
      this.queue = favIdx
    }
    return this.favMode
  }

  // ---------- 音量 / 倍速 / 跳转 ----------

  async setVolume(v: number): Promise<void> {
    this.volume = Math.max(0, Math.min(150, v))
    await this.mpv.setProperty("volume", this.volume)
  }

  async toggleMute(): Promise<void> {
    this.muted = !this.muted
    await this.mpv.setProperty("mute", this.muted)
  }

  async setSpeed(s: number): Promise<void> {
    this.speed = Math.max(0.25, Math.min(4.0, Math.round(s * 100) / 100))
    await this.mpv.setProperty("speed", this.speed)
  }

  async seek(sec: number): Promise<void> {
    if (this.playing) await this.mpv.seek(sec)
  }

  /** 绝对定位跳转 (进度条点击/拖动) */
  async seekTo(sec: number): Promise<void> {
    if (this.playing) await this.mpv.seek(sec, true)
  }

  /** 每帧调用: 处理淡入淡出 */
  async updateFade(): Promise<void> {
    const STEP = this.paused ? 0 : this.volume / 8
    if (this.fadeState === "in" && !this.paused) {
      this.fadeVol += STEP
      if (this.fadeVol >= this.volume) {
        this.fadeVol = this.volume
        this.fadeState = null
      }
      await this.mpv.setProperty("volume", Math.round(this.fadeVol))
      return
    }
    // 淡出: 接近结尾 (排除单曲循环)
    if (this.fadeState === null && !this.paused && this.repeat !== "ONE"
        && this.duration > 2.0 && this.timePos > this.duration - 2.0) {
      this.fadeState = "out"
      this.fadeVol = this.volume
    }
    if (this.fadeState === "out") {
      this.fadeVol -= STEP
      if (this.fadeVol <= 0) this.fadeVol = 0
      await this.mpv.setProperty("volume", Math.round(this.fadeVol))
    }
  }

  // ---------- 目录刷新 ----------

  async refreshDir(): Promise<number> {
    const { scanDirectory } = await import("./scanner")
    const fresh = await scanDirectory(this.musicDir)
    const oldReal = this.playlist[this.idx]
    // 保留当前播放位置
    let newIdx = this.idx
    if (oldReal) {
      const found = fresh.findIndex((x) => x === oldReal)
      if (found !== -1) newIdx = found
      else newIdx = 0
    }
    this.playlist = fresh
    if (this.isShuffle) {
      this.idx = newIdx
      this.toggleShuffle()
      this.toggleShuffle()
    } else {
      this.idx = newIdx
      this.queue = Array.from({ length: fresh.length }, (_, i) => i)
    }
    return fresh.length
  }

  // ---------- 状态保存 ----------

  saveState(): void {
    const patch: Record<string, unknown> = {}
    if (this.currentPath) {
      patch["last_path"] = this.currentPath
      patch["last_pos"] = this.playing ? Math.round(this.timePos * 10) / 10 : 0
    }
    saveConfig(patch)
  }

  // ---------- 显示信息 ----------

  currentTitle(): string {
    if (!this.currentPath) return "—"
    return this.titleTag || titleOf(this.currentPath)
  }

  currentArtist(): string {
    if (!this.currentPath) return ""
    return this.artistTag || dirBase(this.currentPath)
  }

  currentBase(): string {
    return this.currentPath ? baseName(this.currentPath) : "—"
  }
  // ---------- 歌单数据操作 ----------
  // 加载歌单 (启动时由 index.ts 调一次)
  loadPlaylists(): void {
    this.playlists = loadPlaylists()
  }

  /** 按名字查找歌单下标; -1 表示没有 */
  findPlaylist(name: string): number {
    return this.playlists.findIndex((p) => p.name === name)
  }

  /** 新建空歌单; 重名返回 -1, 成功返回新下标 */
  createPlaylist(name: string): number {
    name = name.trim()
    if (!name) return -1
    if (this.findPlaylist(name) !== -1) return -1
    this.playlists.push({ name, paths: [] })
    savePlaylists(this.playlists)
    return this.playlists.length - 1
  }

  /** 删除歌单; 不存在返回 false */
  deletePlaylist(name: string): boolean {
    const i = this.findPlaylist(name)
    if (i === -1) return false
    this.playlists.splice(i, 1)
    savePlaylists(this.playlists)
    return true
  }

  /** 重命名; 新名空/重名返回 false */
  renamePlaylist(oldName: string, newName: string): boolean {
    newName = newName.trim()
    if (!newName) return false
    const i = this.findPlaylist(oldName)
    if (i === -1) return false
    if (oldName === newName) return true
    if (this.findPlaylist(newName) !== -1) return false
    this.playlists[i].name = newName
    savePlaylists(this.playlists)
    return true
  }

  /** 把歌曲加入歌单; 已在里面则 no-op. 返回是否新增 */
  addTrackToPlaylist(name: string, path: string): boolean {
    const i = this.findPlaylist(name)
    if (i === -1) return false
    const p = this.playlists[i]
    if (p.paths.includes(path)) return false
    p.paths.push(path)
    savePlaylists(this.playlists)
    return true
  }

  /** 从歌单移除一首歌; 返回是否真删了 */
  removeTrackFromPlaylist(name: string, idx: number): boolean {
    const i = this.findPlaylist(name)
    if (i === -1) return false
    const p = this.playlists[i]
    if (idx < 0 || idx >= p.paths.length) return false
    p.paths.splice(idx, 1)
    savePlaylists(this.playlists)
    return true
  }

  /** 取歌单路径列表 (浅拷贝, 防止外部乱改) */
  playlistPaths(name: string): string[] {
    const p = this.playlists.find((x) => x.name === name)
    return p ? [...p.paths] : []
  }
}