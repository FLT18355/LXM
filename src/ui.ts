/**
 * OpenTUI 界面 — Catppuccin Latte 主题音乐播放器
 */
import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  t,
  bold,
  fg,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import { Player, REPEAT_CYCLE } from "./player"
import { THEMES, THEME_ORDER, THEME_LABEL, parseThemeName, type Theme, type ThemeName } from "./theme"
import { saveConfig } from "./config"
import type { MpvEvent } from "./mpv"

const REPEAT_LABEL: Record<string, string> = {
  OFF: "不循环",
  ALL: "列表循环",
  ONE: "单曲循环",
}

const EQ_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆"]

/** 按显示宽度截断 (CJK 宽字符计 2 列) */
function clipWidth(text: string, maxw: number): string {
  if (maxw <= 0) return ""
  let width = 0
  let out = ""
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    const cw = code > 0x2e7f && (code <= 0xa4cf || code >= 0xac00) ? 2 : 1
    if (width + cw > maxw) break
    out += ch
    width += cw
  }
  return out
}

function fmt(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`
}

export class PlayerUI {
  // ---------- 状态 ----------
  sel = 0
  msg = ""
  msgUntil = 0
  searchMode = false
  searchActive = false
  searchQuery = ""
  showHelp = false
  fullLyrics = false
  private tickCount = 0
  private lastLyricIdx = -1
  private lastPlTitle = ""

  // ---------- 节点引用 ----------
  private eqText!: TextRenderable
  private headModeText!: TextRenderable
  private headRightText!: TextRenderable
  private nowStatusText!: TextRenderable
  private nowTitleText!: TextRenderable
  private progressText!: TextRenderable
  private timeText!: TextRenderable
  private lyricRows: TextRenderable[] = []
  private lyricBoxHeight = 4
  private plTitle!: TextRenderable
  private plRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private scrollbox!: ScrollBoxRenderable
  private statusLeft!: TextRenderable
  private statusRight!: TextRenderable
  private searchInput!: InputRenderable
  private helpOverlay!: BoxRenderable
  private fullOverlay!: BoxRenderable
  private fullTitle!: TextRenderable
  private fullProgress!: TextRenderable
  private fullLyricRows: TextRenderable[] = []
  private timeBox!: BoxRenderable
  private nowPlayBox!: BoxRenderable
  private lastProgW = -1
  private lastLyricRowH = -1
  private theme: Theme = THEMES.latte
  private themeName: ThemeName = "latte"

  constructor(
    private renderer: CliRenderer,
    readonly p: Player,
    themeName: ThemeName = "latte",
  ) {
    this.themeName = themeName
    this.theme = THEMES[themeName] ?? THEMES.latte
    this.buildTree()
    this.attachGlobalKeys()
    this.attachMpvEvents()
    this.updatePlaylist()
  }

  // =========================================================
  //  构建组件树
  // =========================================================
  private buildTree() {
    const r = this.renderer
    const root = new BoxRenderable(r, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: this.theme.base,
      padding: 0,
    })

    // ── 顶部横幅 ──
    const header = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.theme.mantle,
    })
    const headLeft = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1, flexShrink: 1 })
    headLeft.add(new TextRenderable(r, { content: t`${bold(fg(this.theme.sky)("♬ 蓝汐音乐"))}`, selectable: false }))
    this.eqText = new TextRenderable(r, { content: "▁ ▁ ▁ ▁ ▁ ▁", fg: this.theme.lavender, selectable: false })
    headLeft.add(this.eqText)
    this.headModeText = new TextRenderable(r, { content: "", fg: this.theme.subtext, selectable: false, wrapMode: "none" })
    headLeft.add(this.headModeText)
    header.add(headLeft)
    this.headRightText = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      flexShrink: 1,
      wrapMode: "none",
    })
    header.add(this.headRightText)
    root.add(header)

    // ── 正在播放卡片 ──
    this.nowPlayBox = new BoxRenderable(r, {
      flexDirection: "column",
      backgroundColor: this.theme.crust,
      borderStyle: "double",
      borderColor: this.theme.surface1,
      title: " 正在播放 ",
      titleColor: this.theme.sky,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      gap: 1,
    })
    const nowRow1 = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1 })
    this.nowStatusText = new TextRenderable(r, { content: "⏹ 待机", fg: this.theme.subtext, selectable: false })
    nowRow1.add(this.nowStatusText)
    this.nowTitleText = new TextRenderable(r, {
      content: "—",
      fg: this.theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      flexShrink: 1,
    })
    nowRow1.add(this.nowTitleText)
    this.nowPlayBox.add(nowRow1)

    this.timeBox = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1 })
    this.progressText = new TextRenderable(r, { content: "", selectable: false, flexGrow: 1 })
    this.timeBox.add(this.progressText)
    this.timeText = new TextRenderable(r, { content: "00:00 / 00:00  0%", fg: this.theme.subtext, selectable: false })
    this.timeBox.add(this.timeText)
    this.nowPlayBox.add(this.timeBox)
    root.add(this.nowPlayBox)

    // ── 歌词区 ──
    const lyricsBox = new BoxRenderable(r, {
      id: "lyricsBox",
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 3,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      backgroundColor: this.theme.base,
      borderStyle: "single",
      borderColor: this.theme.surface1,
      title: " 歌词 ",
      titleColor: this.theme.lavender,
      padding: 0,
    })
    const lyricInner = new BoxRenderable(r, { flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2 })
    lyricsBox.add(lyricInner)
    this.lyricInner = lyricInner
    root.add(lyricsBox)

    // ── 播放列表 ──
    const plBox = new BoxRenderable(r, {
      id: "plBox",
      flexDirection: "column",
      flexGrow: 2,
      flexBasis: 0,
      minHeight: 3,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      backgroundColor: this.theme.base,
      borderStyle: "single",
      borderColor: this.theme.surface1,
      title: " 播放列表 ",
      titleColor: this.theme.sky,
    })
    this.plTitle = new TextRenderable(r, { content: "", fg: this.theme.subtext, selectable: false, paddingLeft: 1 })
    plBox.add(this.plTitle)
    this.scrollbox = new ScrollBoxRenderable(r, {
      id: "scrollbox",
      flexGrow: 1,
      flexBasis: 0,
      scrollbarOptions: {
        trackOptions: { foregroundColor: this.theme.surface1, backgroundColor: this.theme.base },
      },
      rootOptions: { backgroundColor: this.theme.base },
      contentOptions: { backgroundColor: this.theme.base },
    })
    plBox.add(this.scrollbox)
    root.add(plBox)

    // ── 底部状态栏 ──
    const statusBar = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.theme.mantle,
    })
    this.statusLeft = new TextRenderable(r, {
      content: "空格 播放/暂停 · n/p 切歌 · / 搜索 · h 帮助 · q 退出",
      fg: this.theme.subtext,
      selectable: false,
      wrapMode: "none",
    })
    statusBar.add(this.statusLeft)
    this.statusRight = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      wrapMode: "none",
    })
    statusBar.add(this.statusRight)
    this.searchInput = new InputRenderable(r, {
      flexGrow: 1,
      placeholder: "搜索歌曲… (Enter 确认 · Esc 取消)",
      backgroundColor: this.theme.surface0,
      focusedBackgroundColor: this.theme.surface1,
      textColor: this.theme.text,
      cursorColor: this.theme.sky,
      visible: false,
    })
    statusBar.add(this.searchInput)
    this.attachInputEvents()
    root.add(statusBar)

    // ── 帮助覆盖层 ──
    this.helpOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: this.theme.base,
      title: " 帮助 · 本地音乐播放器 ",
      titleColor: this.theme.sky,
      paddingLeft: 4,
      paddingRight: 4,
      paddingTop: 2,
      paddingBottom: 1,
      flexDirection: "column",
      gap: 0,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      marginBottom: 1,
      visible: false,
      zIndex: 100,
    })
    const helpLines = [
      ["播放控制", "空格/Enter 播放|暂停|播放选中 · n/p 下一首/上一首 · . 手动下一首"],
      ["快进快退", "←/→ ±5秒 · [/] ±10秒"],
      ["列表操作", "↑↓/jk 选择曲目 · 点击行直接播放"],
      ["随机与循环", "s 随机播放开关 · m 循环模式(不循环→列表→单曲)"],
      ["歌词与全屏", "l 歌词显示开关 · L 全屏 KTV 歌词"],
      ["收藏与模式", "f 收藏当前歌曲 · F 收藏模式"],
      ["倍速与音量", "r 减速(0.25x步长) · a 加速 · + 增音量 · - 减音量"],
      ["搜索与重扫", "/ 搜索(支持中文) · Enter 确认 · Esc 取消 · d 重新扫描目录"],
      ["主题与帮助", "t 切换 Catppuccin 四口味(Latte/Frappé/Macchiato/Mocha) · h 帮助"],
      ["退出", "q / Esc 退出播放器"],
      ["贴心功能", "断点续播(退出记位置) · 切歌淡入淡出"],
    ]
    for (const [k, v] of helpLines) {
      this.helpOverlay.add(
        new TextRenderable(r, { content: t`${bold(fg(this.theme.sky)(` ${k} `))}${fg(this.theme.overlay)("┊ ")}${v}`, selectable: false }),
      )
    }
    this.helpOverlay.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.pink)(" 按任意键返回喵~ ")}`,
        selectable: false,
        attributes: TextAttributes.BOLD,
      }),
    )
    root.add(this.helpOverlay)


    // ── 全屏歌词覆盖层 ──
    this.fullOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: this.theme.base,
      paddingLeft: 3,
      paddingRight: 3,
      visible: false,
      zIndex: 200,
    })
    this.fullTitle = new TextRenderable(r, {
      content: "",
      fg: this.theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      paddingTop: 1,
    })
    this.fullOverlay.add(this.fullTitle)
    this.fullProgress = new TextRenderable(r, { content: "", fg: this.theme.lavender, selectable: false })
    this.fullOverlay.add(this.fullProgress)
    // 歌词主体: 固定 7 行 (前 3 后 3 + 当前句), 每行独立 Text 便于独立样式
    const lyricArea = new BoxRenderable(r, {
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "stretch",
    })
    this.fullOverlay.add(lyricArea)
    for (let i = 0; i < 7; i++) {
      const row = new TextRenderable(r, {
        content: "",
        selectable: false,
        height: 1,
        justifyContent: "center",
      })
      lyricArea.add(row)
      this.fullLyricRows.push(row)
    }
    this.fullOverlay.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.subtext)(" L/Esc 退出全屏 · 空格 暂停 · n/p 切歌 ")}`,
        selectable: false,
      }),
    )
    root.add(this.fullOverlay)

    r.root.add(root)
  }
  private lyricInner!: BoxRenderable

  // =========================================================
  //  事件挂接
  // =========================================================

  /** 全局按键: 只挂一次 (重建树时不得重复挂) */
  private attachGlobalKeys() {
    this.renderer.keyInput.on("keypress", (key) => this.handleKey(key))
  }

  /** 搜索输入框事件: 树重建后需重新挂载 */
  private attachInputEvents() {
    this.searchInput.on(InputRenderableEvents.ENTER, (value: string) => {
      this.doSearch(value)
    })
    this.searchInput.on(InputRenderableEvents.CHANGE, (value: string) => {
      this.searchQuery = value
    })
  }

  private attachMpvEvents() {
    const p = this.p
    // 属性观察: time-pos / duration / pause / eof-reached
    p.mpv.observeProperty(1, "time-pos")
    p.mpv.observeProperty(2, "duration")
    p.mpv.observeProperty(3, "pause")
    p.mpv.observeProperty(4, "eof-reached")
    p.mpv.onEvent((ev: MpvEvent) => {
      const name = ev.event
      if (name === "property-change") {
        const prop = ev.name as string
        const data = ev.data as unknown
        if (prop === "time-pos" && typeof data === "number" && Number.isFinite(data)) {
          p.timePos = data
          // 断点续播: 文件加载后跳转一次
          if (p.pendingSeek !== null && data > 0.2) {
            p.mpv.seek(p.pendingSeek, true)
            p.pendingSeek = null
          }
        } else if (prop === "duration" && typeof data === "number" && Number.isFinite(data)) {
          p.duration = data
        } else if (prop === "pause") {
          p.paused = data === true
        }
      } else if (name === "file-loaded") {
        // 新文件就位: 恢复 end-file 处理 (解除切歌抑制)
        p.onFileLoaded()
      } else if (name === "end-file") {
        const reason = ev.reason as string
        if ((reason === "eof" || reason === "stop") && !p.suppressEndFile) {
          p.maybeAdvance().then(() => this.afterTrackChange())
        }
      }
    })
  }

  // =========================================================
  //  按键处理
  // =========================================================
  private handleKey(key: KeyEvent): void {
    const p = this.p
    const name = key.name
    const seq = key.sequence

    // 帮助界面: 任意键关闭
    if (this.showHelp) {
      this.showHelp = false
      this.helpOverlay.visible = false
      key.preventDefault()
      return
    }
    // 全屏歌词模式
    if (this.fullLyrics) {
      if (name === "escape" || seq === "q" || seq === "Q" || seq === "l" || seq === "L") {
        this.setFullLyrics(false)
      } else if (name === "space") {
        p.togglePause(this)
      } else if (seq === "n") {
        p.advance(1).then(() => this.afterTrackChange())
      } else if (seq === "p") {
        p.advance(-1).then(() => this.afterTrackChange())
      }
      key.preventDefault()
      return
    }
    // 搜索浏览态不再单独拦截按键: 所有正常快捷键可用, sel 自动映射到队列
    // 搜索输入模式: Esc 取消, 其余按键交给输入框
    if (this.searchMode) {
      if (key.name === "escape") {
        this.exitSearch(false)
        key.preventDefault()
      }
      return
    }

    // ---- 正常模式 ----
    switch (true) {
      case name === "up" || seq === "k":
        this.moveSel(-1)
        break
      case name === "down" || seq === "j":
        this.moveSel(1)
        break
      case name === "left":
        this.seek(-5)
        break
      case name === "right":
        this.seek(5)
        break
      case name === "space":
        if (!p.playing) {
          if (p.playlist.length) this.playSel()
        } else {
          p.togglePause(this)
        }
        break
      case name === "return" || name === "enter":
        this.playSel()
        break
      case seq === "n":
        p.advance(1).then(() => this.afterTrackChange())
        break
      case seq === "p":
        p.advance(-1).then(() => this.afterTrackChange())
        break
      case seq === "[":
        this.seek(-10)
        break
      case seq === "]":
        this.seek(10)
        break
      case seq === "/":
        this.enterSearch()
        key.preventDefault()
        break
      case seq === ".":
        p.advance(1).then(() => this.afterTrackChange())
        break
      case seq === "s":
        p.toggleShuffle()
        this.flash(p.isShuffle ? "🔀 随机播放已开启" : "🎵 顺序播放已开启")
        break
      case seq === "m":
        p.cycleRepeat()
        this.flash("循环模式: " + REPEAT_LABEL[p.repeat])
        break
      case seq === "l":
        p.showLyrics = !p.showLyrics
        this.flash(`歌词显示: ${p.showLyrics ? "开" : "关"}`)
        break
      case seq === "L":
        this.setFullLyrics(true)
        break
      case seq === "f":
        this.favCurrent()
        break
      case seq === "F":
        this.toggleFavMode()
        break
      case seq === "h":
        this.showHelp = true
        this.helpOverlay.visible = true
        break
      case seq === "+" || seq === "=":
        p.setVolume(p.volume + 5)
        this.flash(`音量 ${p.volume}`)
        break
      case seq === "-" || seq === "_":
        p.setVolume(p.volume - 5)
        this.flash(`音量 ${p.volume}`)
        break
      case seq === "r":
        p.setSpeed(p.speed - 0.25)
        this.flash(`倍速 ${p.speed.toFixed(2)}x`)
        break
      case seq === "a":
        p.setSpeed(p.speed + 0.25)
        this.flash(`倍速 ${p.speed.toFixed(2)}x`)
        break
      case seq === "d":
        this.refreshDir()
        break
      case seq === "t":
        this.cycleTheme()
        break
      case seq === "q" || seq === "Q" || name === "escape":
        if (name === "escape" && this.searchActive) {
          // Esc: 先退出搜索浏览, 再按一次才退出
          this.exitSearch(true)
        } else {
          this.quit()
        }
        break
    }
  }

  // =========================================================
  //  动作
  // =========================================================
  flash(text: string, seconds = 1.6) {
    this.msg = text
    this.msgUntil = Date.now() + seconds * 1000
  }

  moveSel(delta: number) {
    const n = this.searchActive || this.p.favMode ? this.p.queue.length : this.p.playlist.length
    if (!n) return
    this.sel = Math.max(0, Math.min(n - 1, this.sel + delta))
    this.updatePlaylist()
  }

  playSel() {
    const p = this.p
    if (!p.playlist.length) return
    // 搜索/收藏模式: sel 是过滤后队列中的位置, 需映射到真实索引
    const realIdx = p.selToPlaylistIdx(this.sel, this.searchActive || p.favMode)
    p.playIndex(realIdx).then(() => {
      this.afterTrackChange()
      // 选中同步到当前播放
      if (p.queue.includes(realIdx)) this.sel = p.queue.indexOf(realIdx)
      else this.sel = realIdx
    })
  }

  playIndex(realIdx: number) {
    this.p.playIndex(realIdx).then(() => this.afterTrackChange())
  }

  afterTrackChange() {
    this.updateNowPlaying()
    this.updatePlaylist()
  }

  seek(sec: number) {
    this.p.seek(sec)
    this.flash(sec > 0 ? `快进 ${sec} 秒喵~` : `快退 ${-sec} 秒喵~`)
  }

  favCurrent() {
    const p = this.p
    if (!p.playlist.length) return
    const realIdx = p.selToPlaylistIdx(this.sel, this.searchActive || p.favMode)
    const added = p.toggleFavorite(realIdx)
    this.flash(`${added ? "♥ 已收藏" : "已取消收藏"}: ${p.playlist[realIdx].split("/").pop()}`)
    this.updatePlaylist()
  }

  toggleFavMode() {
    const p = this.p
    if (p.favMode) {
      p.toggleFavMode()
      this.sel = p.idx
      this.flash("已退出收藏模式")
      this.updatePlaylist()
    } else {
      if (p.favorites.length) {
        p.toggleFavMode()
        this.sel = 0
        this.flash(`♥ 收藏模式: ${p.queue.length} 首`)
        this.updatePlaylist()
      } else {
        this.flash("还没有收藏喵~ 按 f 收藏歌曲")
      }
    }
  }

  enterSearch() {
    this.searchMode = true
    this.searchInput.visible = true
    this.searchInput.value = ""
    this.searchInput.focus()
    this.searchActive = false
    this.searchQuery = ""
    this.statusLeft.visible = false
    this.statusRight.visible = false
  }

  doSearch(query: string) {
    const p = this.p
    this.searchMode = false
    this.searchInput.visible = false
    this.statusLeft.visible = true
    this.statusRight.visible = true
    const q = query.trim().toLowerCase()
    if (q) {
      const results = p.playlist
        .map((path, i) => ({ i, base: path.split("/").pop()!.toLowerCase() }))
        .filter((x) => x.base.includes(q))
        .map((x) => x.i)
      if (results.length) {
        p.queue = results
        this.sel = 0
        this.searchActive = true
        this.flash(`搜索到 ${results.length} 首喵~ 关键词: ${query}`)
      } else {
        p.queue = []
        this.sel = 0
        this.searchActive = true
        this.flash(`没有找到 '${query}' 喵~`)
      }
    } else {
      p.queue = Array.from({ length: p.playlist.length }, (_, i) => i)
      this.searchActive = false
      this.flash("已清空搜索喵~")
    }
    this.updatePlaylist()
  }

  exitSearch(restoreAll: boolean) {
    const p = this.p
    this.searchMode = false
    this.searchInput.visible = false
    this.statusLeft.visible = true
    this.statusRight.visible = true
    if (restoreAll) {
      this.searchActive = false
      this.searchQuery = ""
      p.queue = Array.from({ length: p.playlist.length }, (_, i) => i)
      this.sel = p.idx
      this.flash("已退出搜索喵~")
      this.updatePlaylist()
    } else {
      // 取消输入但保留浏览态
      if (this.searchActive) {
        this.searchQuery = ""
        this.flash("已退出搜索喵~")
      } else {
        this.searchActive = false
        p.queue = Array.from({ length: p.playlist.length }, (_, i) => i)
        this.sel = p.idx
        this.updatePlaylist()
      }
    }
  }

  refreshDir() {
    this.p.refreshDir().then((n) => {
      this.flash(`扫描完成喵~ 共 ${n} 首`)
      this.sel = this.p.idx
      this.updatePlaylist()
    })
  }

  // =========================================================
  //  主题
  // =========================================================

  /** 切换主题: 重建组件树并恢复界面状态 */
  applyTheme(name: ThemeName) {
    const next = THEMES[name]
    if (!next) return
    const prevName = this.themeName
    if (prevName === name) return
    // 备份界面状态
    const help = this.showHelp
    const full = this.fullLyrics
    const search = this.searchMode
    const searchA = this.searchActive
    const searchQ = this.searchQuery
    const msg = this.msg
    const msgUntil = this.msgUntil

    for (const ch of this.renderer.root.getChildren()) {
      ch.destroyRecursively()
    }
    this.themeName = name
    this.theme = next
    this.plRows = []
    this.lyricRows = []
    this.fullLyricRows = []
    this.buildTree()

    // 恢复状态
    this.showHelp = help
    this.fullLyrics = full
    this.helpOverlay.visible = help
    this.fullOverlay.visible = full
    this.searchMode = search
    this.searchActive = searchA
    this.searchQuery = searchQ
    this.msg = msg
    this.msgUntil = msgUntil
    if (search) {
      this.searchInput.value = searchQ
      this.searchInput.visible = true
      this.searchInput.focus()
      this.statusLeft.visible = false
      this.statusRight.visible = false
    }
    this.updatePlaylist()
    this.updateNowPlaying()
    if (full) this.updateFullLyrics()
  }

  /** 循环切换主题 (t 键) */
  cycleTheme() {
    const cur = THEME_ORDER.indexOf(this.themeName)
    const next = THEME_ORDER[(cur + 1) % THEME_ORDER.length]
    this.applyTheme(next)
    saveConfig({ theme: next })
    this.flash(`🎨 主题: ${THEME_LABEL[next]}`, 2.2)
  }

  quit() {
    // 由 index.ts 的 onQuit 回调执行清理
    this.onQuit?.()
  }
  onQuit: (() => void) | null = null

  setFullLyrics(on: boolean) {
    this.fullLyrics = on
    this.fullOverlay.visible = on
    if (on) this.updateFullLyrics()
  }

  // =========================================================
  //  主菜单 (四选项入口)
  // =========================================================

  // =========================================================
  //  播放列表
  // =========================================================
  private rebuildPlaylistRows(count: number) {
    // 销毁旧的
    for (const row of this.plRows) {
      row.box.destroyRecursively()
    }
    this.plRows = []
    for (let i = 0; i < count; i++) {
      const box = new BoxRenderable(this.renderer, {
        id: `pl-${i}`,
        width: "100%",
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 2,
        backgroundColor: this.theme.base,
        onMouseDown: () => {
          const p = this.p
          if (this.searchActive || p.favMode) {
            const real = p.queue[i]
            if (real !== undefined) {
              this.sel = i
              this.updatePlaylist()
              this.playIndex(real)
            }
          } else if (i < p.playlist.length) {
            this.sel = i
            this.updatePlaylist()
            this.playIndex(i)
          }
        },
      })
      const text = new TextRenderable(this.renderer, {
        content: "",
        selectable: false,
        width: "100%",
      })
      box.add(text)
      this.scrollbox.add(box)
      this.plRows.push({ box, text })
    }
  }

  updatePlaylist() {
    const p = this.p
    const isFav = p.favMode && !this.searchActive
    const isSearch = this.searchActive
    const shown = isFav || isSearch ? p.queue : Array.from({ length: p.playlist.length }, (_, i) => i)
    const n = shown.length
    if (this.plRows.length !== n) this.rebuildPlaylistRows(n)
    for (let i = 0; i < n; i++) {
      const orig = shown[i]
      const row = this.plRows[i]
      const path = p.playlist[orig]
      const name = path.split("/").pop() || ""
      const isPlaying = orig === p.idx
      const isSel = i === this.sel
      const fav = p.favorites.includes(path)
      const marker = isPlaying ? "▶" : " "
      const line = `${marker} ${String(i + 1).padStart(2, " ")} ${name}${fav ? " ♥" : ""}`
      const box = row.box
      if (isSel) {
        box.backgroundColor = this.theme.surface1
        row.text.content = t`${fg(this.theme.text)(bold(clipWidth(line, 200)))}`
      } else if (isPlaying) {
        box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.green)(bold(clipWidth(line, 200)))}`
      } else {
        box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.text)(clipWidth(line, 200))}`
      }
    }
    // 滚动到选中项
    try {
      this.scrollbox.scrollChildIntoView(`pl-${this.sel}`)
    } catch {
      /* ignore */
    }
  }

  playlistTitle(): string {
    const p = this.p
    if (this.searchActive) return ` 搜索结果 ${p.queue.length} 首 `
    if (p.favMode) return ` ♥ 收藏 ${p.queue.length} 首 · F退出 `
    if (this.searchMode) return ` 播放列表 ${p.playlist.length} 首 · 输入中 `
    return ` 播放列表 ${p.playlist.length} 首 `
  }

  // =========================================================
  //  每帧刷新 (setInterval 调用)
  // =========================================================
  tick() {
    const p = this.p
    this.tickCount++

    if (this.searchMode && !this.searchInput.focused) {
      this.searchInput.focus()
    }

    // 等化器动画
    if (p.playing && !p.paused) {
      const tc = this.tickCount
      const bars = EQ_CHARS.map((c, i) => {
        const v = Math.abs(Math.sin(tc * 0.35 + i * 1.7) * Math.cos(tc * 0.18 + i * 0.9))
        const h = Math.min(EQ_CHARS.length - 1, Math.floor(v * EQ_CHARS.length))
        return EQ_CHARS[h]
      })
      const parts = [
        fg(this.theme.sky)(bars[0]),
        fg(this.theme.lavender)(bars[1]),
        fg(this.theme.pink)(bars[2]),
        fg(this.theme.peach)(bars[3]),
        fg(this.theme.yellow)(bars[4]),
        fg(this.theme.sky)(bars[5]),
      ]
      this.eqText.content = t`${parts[0]}${parts[1]}${parts[2]}${parts[3]}${parts[4]}${parts[5]}`
    } else {
      this.eqText.content = t`${fg(this.theme.overlay)("▁ ▁ ▁ ▁ ▁ ▁")}`
    }

    // 头部信息
    const mode =
      p.isShuffle ? "🔀 随机" :
      this.searchActive ? "🔍 搜索" :
      p.favMode ? "♥ 收藏" : "🎵 列表"
    this.headModeText.content = ` ${mode} `
    this.headRightText.content =
      ` ${REPEAT_LABEL[p.repeat]} ┊ 音量 ${p.volume}${p.speed !== 1 ? " ┊ ×" + p.speed.toFixed(2) : ""} `

    // 正在播放 + 进度条
    this.updateNowPlaying()

    // 歌词区
    this.updateLyrics()

    // 播放列表标题
    const ttl = this.playlistTitle()
    if (this.lastPlTitle !== ttl) {
      this.plTitle.content = ttl
      this.lastPlTitle = ttl
    }

    // 底部状态
    if (!this.searchMode) {
      if (Date.now() < this.msgUntil) {
        this.statusLeft.content = this.msg
        this.statusLeft.fg = this.theme.pink
      } else {
        this.statusLeft.content =
          "空格 播放/暂停 · n/p 切歌 · f 收藏 · F 收藏模式 · h 帮助 · s 随机 · m 循环 · t 主题 · / 搜索 · q 退出"
        this.statusLeft.fg = this.theme.subtext
      }
    }
    this.statusRight.content = p.playing
      ? ` ${p.currentBase()} · ${String(p.idx + 1)}/${p.playlist.length} `
      : ` 共 ${p.playlist.length} 首 `

    // 淡入淡出
    p.updateFade()

    // duration 兜底: 播放中但仍未知时长时, 每 1 秒主动补拉一次
    if (p.playing && p.duration <= 0 && this.tickCount % 10 === 0) {
      p.mpv.getProperty<number>("duration").then((d) => {
        if (typeof d === "number" && Number.isFinite(d) && d > 0) p.duration = d
      })
    }

    // 全屏歌词刷新
    if (this.fullLyrics) this.updateFullLyrics()
  }

  /** 更新"正在播放"卡片与进度条 */
  updateNowPlaying() {
    const p = this.p
    const status = p.playing ? (p.paused ? "⏸ 已暂停" : "▶ 播放中") : "⏹ 待机"
    this.nowStatusText.content = status
    this.nowStatusText.fg = p.playing ? (p.paused ? this.theme.yellow : this.theme.green) : this.theme.subtext
    let title = p.currentTitle()
    const artist = p.currentArtist()
    if (artist) title += ` ┊ ${artist}`
    this.nowTitleText.content = title

    // 渐变进度条
    const innerW = (this.timeBox.width || 20) - (this.timeText.width || 18) - 2
    const barw = Math.max(6, Math.min(60, innerW))
    const dur = p.duration
    const tpos = p.timePos
    const pct = dur > 0 ? Math.max(0, Math.min(1, tpos / dur)) : 0
    const filled = Math.round(barw * pct)
    const seg = Math.max(1, Math.floor(barw / 3))
    const f1 = Math.min(filled, seg)
    const f2 = Math.min(Math.max(filled - seg, 0), seg)
    const f3 = Math.max(filled - seg - seg, 0)
    const rest = Math.max(barw - filled, 0)
    this.progressText.content = t`${fg(this.theme.sky)("█".repeat(f1))}${fg(this.theme.lavender)("█".repeat(f2))}${fg(this.theme.pink)("█".repeat(f3))}${fg(this.theme.surface1)("░".repeat(rest))}`
    // 时长未知时显示 --:-- 而非 0:00, 避免误导
    const durText = dur > 0 ? fmt(dur) : "--:--"
    const pctText = dur > 0 ? String(Math.round(pct * 100)).padStart(3) : "---"
    this.timeText.content = ` ${fmt(tpos)} / ${durText}  ${pctText}% `
  }

  /** 更新歌词区 (当前句高亮居中) */
  private updateLyrics() {
    const p = this.p
    const shown = p.showLyrics && p.lyrics.length > 0
    const H = this.lyricInner.height
    if (H < 1 || H > 20) return
    if (!shown) {
      if (this.lyricRows.length !== H) {
        this.buildLyricRows(H)
      }
      const hint = p.showLyrics ? "(无歌词文件喵~ 同名 .lrc)" : "歌词已关闭"
      for (let i = 0; i < H; i++) {
        this.lyricRows[i].content = i === Math.floor(H / 2) ? t`${fg(this.theme.overlay)(hint)}` : ""
      }
      return
    }
    // 当前句
    let cur = -1
    for (let i = 0; i < p.lyrics.length; i++) {
      if (p.lyrics[i].time <= p.timePos) cur = i
      else break
    }
    if (cur < 0) cur = 0
    if (this.lyricRows.length !== H) this.buildLyricRows(H)
    const center = Math.floor(H / 2)
    for (let r = 0; r < H; r++) {
      const lineIdx = cur + (r - center)
      const row = this.lyricRows[r]
      if (lineIdx >= 0 && lineIdx < p.lyrics.length) {
        const txt = clipWidth(p.lyrics[lineIdx].text, (this.lyricInner.width || 40) - 4)
        if (r === center) {
          row.content = t`${fg(this.theme.sky)(bold("♪ " + txt))}`
        } else {
          const dist = Math.abs(r - center)
          const col = dist <= 1 ? this.theme.subtext : this.theme.overlay
          row.content = t`${fg(col)("   " + txt)}`
        }
      } else {
        row.content = ""
      }
    }
    this.lastLyricIdx = cur
  }

  private buildLyricRows(height: number) {
    for (const row of this.lyricRows) row.destroy()
    this.lyricRows = []
    for (let i = 0; i < height; i++) {
      const row = new TextRenderable(this.renderer, {
        content: "",
        selectable: false,
        width: "100%",
        height: 1,
      })
      this.lyricInner.add(row)
      this.lyricRows.push(row)
    }
  }

  /** 全屏歌词 */
  private updateFullLyrics() {
    const p = this.p
    const title = p.currentTitle()
    this.fullTitle.content = ` ${p.playing ? (p.paused ? "❚❚" : "▶") : "⏹"} ${title} `
    // 进度
    const dur = p.duration
    const tpos = p.timePos
    const pct = dur > 0 ? Math.max(0, Math.min(1, tpos / dur)) : 0
    const barw = Math.max(10, (this.fullOverlay.width || 40) - 24)
    const filled = Math.round(barw * pct)
    const durText = dur > 0 ? fmt(dur) : "--:--"
    this.fullProgress.content = t`${fg(this.theme.lavender)("█".repeat(filled))}${fg(this.theme.surface1)("░".repeat(barw - filled))} ${fmt(tpos)} / ${durText}`
    if (!p.lyrics.length) {
      for (let i = 0; i < this.fullLyricRows.length; i++) {
        this.fullLyricRows[i].content =
          i === Math.floor(this.fullLyricRows.length / 2)
            ? t`${fg(this.theme.overlay)("(无歌词文件喵~ 同名 .lrc)")}`
            : ""
      }
      return
    }
    let cur = -1
    for (let i = 0; i < p.lyrics.length; i++) {
      if (p.lyrics[i].time <= tpos) cur = i
      else break
    }
    if (cur < 0) cur = 0
    const MID = Math.floor(this.fullLyricRows.length / 2) // 3 (7 行)
    for (let r = 0; r < this.fullLyricRows.length; r++) {
      const offset = r - MID
      const idx = cur + offset
      const row = this.fullLyricRows[r]
      if (offset === 0) {
        // 当前句: 放大加粗 + 亮色
        row.content = t`${fg(this.theme.sky)(bold("♪     " + p.lyrics[cur].text))}`
      } else if (idx >= 0 && idx < p.lyrics.length) {
        const col = Math.abs(offset) <= 1 ? this.theme.subtext : this.theme.overlay
        row.content = t`${fg(col)("      " + p.lyrics[idx].text)}`
      } else {
        row.content = ""
      }
    }
  }
}