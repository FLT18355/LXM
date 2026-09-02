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
  type MouseEvent,
} from "@opentui/core"
import { Player, REPEAT_CYCLE } from "./player"
import { THEMES, THEME_ORDER, THEME_LABEL, parseThemeName, type Theme, type ThemeName } from "./theme"
import { saveConfig } from "./config"
import type { MpvEvent } from "./mpv"
import type { Playlist } from "./playlists"

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

  // 歌单 UI 状态
  // plMode: 歌单列表覆盖层 (P 键进入)
  // plDetailMode: 进入了某个歌单的详情
  // plPickerMode: 从主歌单或歌单详情按 a 触发的"加歌选歌"模式
  plMode = false
  plDetailMode = false
  plPickerMode = false
  plSel = 0
  plDetailSel = 0
  plCurrent: string | null = null  // 当前详情页的歌单名
  plLastFlash = ""  // tick 时只更新一次 title

  // 弹层输入态: "new" 新建 / "rename" 重命名 / null 不弹
  plDialogMode: "new" | "rename" | null = null
  plDialogValue = ""
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

  private fullLyricRows: TextRenderable[] = []
  private timeBox!: BoxRenderable
  private nowPlayBox!: BoxRenderable
  private lastProgW = -1
  private lastLyricRowH = -1
  private searchInput!: InputRenderable
  private helpOverlay!: BoxRenderable
  private fullOverlay!: BoxRenderable
  private fullTitle!: TextRenderable
  private fullProgress!: TextRenderable
  // 歌单相关节点
  private plListOverlay!: BoxRenderable
  private plListTitle!: TextRenderable
  private plListScroll!: ScrollBoxRenderable
  private plListRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private plDetailOverlay!: BoxRenderable
  private plDetailTitle!: TextRenderable
  private plDetailScroll!: ScrollBoxRenderable
  private plDetailRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private plDialogOverlay!: BoxRenderable
  private plDialogTitle!: TextRenderable
  private plDialogInput!: InputRenderable
  private plDialogHint!: TextRenderable
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
    this.timeBox.onMouseDown = (ev) => this.seekFromMouse(ev)
    this.timeBox.onMouseDrag = (ev) => this.seekFromMouse(ev)
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
      content: "空格 播放/暂停 · n/p 切歌 · P 歌单 · / 搜索 · M 静音 · h 帮助 · q 退出",
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
      ["倍速与音量", "r 减速(0.25x步长) · a 加速 · + 增音量 · - 减音量 · M/0 静音"],
      ["歌单", "P 歌单列表 · n 新建歌单 · r 重命名 · d 删除 · Enter 进入详情 · a 加歌 · x 移除"],
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

    // ── 歌单列表覆盖层 (P 键) ──
    this.plListOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: this.theme.base,
      title: " 歌单 ",
      titleColor: this.theme.pink,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      visible: false,
      zIndex: 150,
    })
    this.plListTitle = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      paddingBottom: 1,
    })
    this.plListOverlay.add(this.plListTitle)
    this.plListScroll = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      flexBasis: 0,
      scrollbarOptions: {
        trackOptions: { foregroundColor: this.theme.surface1, backgroundColor: this.theme.base },
      },
      rootOptions: { backgroundColor: this.theme.base },
      contentOptions: { backgroundColor: this.theme.base },
    })
    this.plListOverlay.add(this.plListScroll)
    this.plListOverlay.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.subtext)(" ↑↓/jk 选择 · Enter 进入 · n 新建 · r 重命名 · d 删除 · Esc 返回 ")}`,
        selectable: false,
      }),
    )
    root.add(this.plListOverlay)

    // ── 歌单详情覆盖层 ──
    this.plDetailOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: this.theme.base,
      title: " 歌单详情 ",
      titleColor: this.theme.sky,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      visible: false,
      zIndex: 160,
    })
    this.plDetailTitle = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      paddingBottom: 1,
    })
    this.plDetailOverlay.add(this.plDetailTitle)
    this.plDetailScroll = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      flexBasis: 0,
      scrollbarOptions: {
        trackOptions: { foregroundColor: this.theme.surface1, backgroundColor: this.theme.base },
      },
      rootOptions: { backgroundColor: this.theme.base },
      contentOptions: { backgroundColor: this.theme.base },
    })
    this.plDetailOverlay.add(this.plDetailScroll)
    this.plDetailOverlay.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.subtext)(" ↑↓/jk 选择 · Enter 播放 · a 加歌 · x 移除 · Esc 返回歌单列表 ")}`,
        selectable: false,
      }),
    )
    root.add(this.plDetailOverlay)

    // ── 命名/重命名居中弹层 ──
    this.plDialogOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: this.theme.crust,
      visible: false,
      zIndex: 300,
    })
    this.plDialogTitle = new TextRenderable(r, {
      content: "",
      fg: this.theme.text,
      selectable: false,
      paddingBottom: 1,
    })
    this.plDialogOverlay.add(this.plDialogTitle)
    this.plDialogInput = new InputRenderable(r, {
      width: 40,
      placeholder: "输入歌单名...",
      backgroundColor: this.theme.surface0,
      focusedBackgroundColor: this.theme.surface1,
      textColor: this.theme.text,
      cursorColor: this.theme.pink,
    })
    this.plDialogOverlay.add(this.plDialogInput)
    this.plDialogHint = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      paddingTop: 1,
    })
    this.plDialogOverlay.add(this.plDialogHint)
    root.add(this.plDialogOverlay)

    this.attachDialogEvents()

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

  /** 歌单命名/重命名弹层: 树重建后需重新挂 */
  private attachDialogEvents() {
    this.plDialogInput.on(InputRenderableEvents.ENTER, (value: string) => {
      this.commitPlDialog(value)
    })
    this.plDialogInput.on(InputRenderableEvents.CHANGE, (value: string) => {
      this.plDialogValue = value
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

    // 歌单命名/重命名弹层: 拦截所有按键, 由 input 自处理
    if (this.plDialogMode) {
      if (name === "escape") {
        this.closePlDialog()
        key.preventDefault()
      }
      return
    }

    // 歌单列表 / 详情 / 加歌选歌 (P 键进入)
    if (this.plMode || this.plDetailMode || this.plPickerMode) {
      if (name === "escape") {
        if (this.plPickerMode) this.plPickerExit()
        else if (this.plDetailMode) this.closePlDetail()
        else this.closePlList()
        key.preventDefault()
        return
      }
      if (name === "up" || seq === "k") {
        if (this.plPickerMode) {
          this.sel = Math.max(0, this.sel - 1)
          this.updatePlaylist()
        } else if (this.plDetailMode) {
          this.plDetailSel = Math.max(0, this.plDetailSel - 1)
          this.renderPlDetail()
        } else {
          this.plSel = Math.max(0, this.plSel - 1)
          this.renderPlList()
        }
        key.preventDefault()
        return
      }
      if (name === "down" || seq === "j") {
        if (this.plPickerMode) {
          const n = this.p.playlist.length
          if (n) {
            this.sel = Math.min(n - 1, this.sel + 1)
            this.updatePlaylist()
          }
        } else if (this.plDetailMode) {
          const n = this.p.playlistPaths(this.plCurrent || "").length
          if (n) {
            this.plDetailSel = Math.min(n - 1, this.plDetailSel + 1)
            this.renderPlDetail()
          }
        } else {
          const n = this.p.playlists.length
          if (n) {
            this.plSel = Math.min(n - 1, this.plSel + 1)
            this.renderPlList()
          }
        }
        key.preventDefault()
        return
      }
      // 加歌选歌模式: Enter 加入, 不退出
      if (this.plPickerMode) {
        if (name === "return" || name === "enter") {
          this.plPickerAdd()
          key.preventDefault()
          return
        }
        // 加歌模式下其它键都让播放器正常处理 (搜索等)
        // 不直接 return, 落入正常 switch
      } else {
        // 列表 / 详情
        if (name === "return" || name === "enter") {
          this.plEnter()
          key.preventDefault()
          return
        }
        if (seq === "n") {
          this.openPlDialog("new")
          key.preventDefault()
          return
        }
        if (seq === "r" && this.plMode) {
          const cur = this.p.playlists[this.plSel]
          if (cur) this.openPlDialog("rename", cur.name)
          key.preventDefault()
          return
        }
        if (seq === "d") {
          this.plDelete()
          key.preventDefault()
          return
        }
        if (seq === "a" && this.plDetailMode) {
          this.enterPlPicker()
          key.preventDefault()
          return
        }
        if (seq === "x" && this.plDetailMode) {
          this.plDelete()
          key.preventDefault()
          return
        }
        if (seq === "P" || seq === "p" && this.plMode) {
          // 列表下按 P 关闭
          this.closePlList()
          key.preventDefault()
          return
        }
      }
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
      case seq === "P":
        this.togglePlList()
        key.preventDefault()
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
      case seq === "M" || seq === "0":
        p.toggleMute().then(() => this.flash(p.muted ? "🔇 已静音喵~" : `音量 ${p.volume} 喵~`))
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

  /** 进度条点击/拖动定位: 把鼠标 x 映射到时间 */
  private seekFromMouse(ev: MouseEvent) {
    const p = this.p
    if (!p.playing || p.duration <= 0) return
    const barX = this.progressText.screenX
    const barW = this.progressText.width
    if (typeof barW !== "number" || barW <= 0) return
    const localX = Math.max(0, Math.min(barW, ev.x - barX))
    const target = (localX / barW) * p.duration
    p.seekTo(target)
    this.flash(`跳转到 ${fmt(target)} 喵~`)
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
    // 歌单状态
    const plMode = this.plMode
    const plDetail = this.plDetailMode
    const plCur = this.plCurrent
    const plSel = this.plSel
    const plDetailSel = this.plDetailSel

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
    // 恢复歌单
    this.plMode = plMode
    this.plDetailMode = plDetail
    this.plCurrent = plCur
    this.plSel = plSel
    this.plDetailSel = plDetailSel
    this.plListOverlay.visible = plMode && !plDetail
    this.plDetailOverlay.visible = plDetail
    if (plMode) this.renderPlList()
    if (plDetail) this.renderPlDetail()
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

  // =========================================================
  //  歌单
  // =========================================================

  /** 打开/关闭歌单列表覆盖层 (P 键) */
  togglePlList() {
    if (this.plMode) {
      this.closePlList()
    } else {
      this.openPlList()
    }
  }

  openPlList() {
    // 先退出其它模式, 避免互相串扰
    this.plDetailMode = false
    this.plDetailOverlay.visible = false
    this.plPickerMode = false
    this.plMode = true
    this.plListOverlay.visible = true
    if (this.plSel >= this.p.playlists.length) this.plSel = 0
    this.renderPlList()
  }

  closePlList() {
    this.plMode = false
    this.plListOverlay.visible = false
  }

  /** 歌单列表进入详情 */
  openPlDetail(name: string) {
    this.plCurrent = name
    this.plDetailMode = true
    this.plDetailSel = 0
    this.plDetailOverlay.visible = true
    // 进入详情后列表层不可见, plMode 必须清掉
    // 否则 plEnter 里 if(this.plMode) 先匹配, Enter 会走"打开详情"而非"播放选中"
    this.plMode = false
    this.plListOverlay.visible = false
    this.renderPlDetail()
  }

  closePlDetail() {
    this.plDetailMode = false
    this.plDetailOverlay.visible = false
    this.plCurrent = null
    // 回到歌单列表 (详情是在列表之上的二级页)
    this.plMode = true
    this.plListOverlay.visible = true
    this.renderPlList()
  }

  /** 弹出新建/重命名弹层 (mode 决定行为) */
  openPlDialog(mode: "new" | "rename", preset = "") {
    this.plDialogMode = mode
    this.plDialogValue = preset
    this.plDialogInput.value = preset
    this.plDialogTitle.content =
      mode === "new" ? t`${bold(fg(this.theme.sky)(" ✦ 新建歌单 "))}` : t`${bold(fg(this.theme.sky)(" ✎ 重命名歌单 "))}`
    this.plDialogHint.content = mode === "new" ? "输入名称 · Enter 确认 · Esc 取消" : `原名: ${preset}  ·  Enter 确认 · Esc 取消`
    this.plDialogOverlay.visible = true
    this.plDialogInput.focus()
  }

  closePlDialog() {
    this.plDialogMode = null
    this.plDialogValue = ""
    this.plDialogInput.value = ""
    this.plDialogOverlay.visible = false
    // 显式失焦, 否则 InputRenderable 的光标会留在屏幕中央
    this.plDialogInput.blur()
  }

  /** 弹层 Enter 提交 */
  commitPlDialog(value: string) {
    const v = value.trim()
    if (!v) {
      this.flash("歌单名不能为空喵~")
      this.closePlDialog()
      return
    }
    if (this.plDialogMode === "new") {
      const idx = this.p.createPlaylist(v)
      if (idx < 0) {
        this.flash(`已存在同名歌单喵~: ${v}`)
        this.closePlDialog()
        return
      }
      this.flash(`✦ 已创建歌单: ${v}`)
      this.plSel = idx
    } else if (this.plDialogMode === "rename") {
      // 列表页重命名时 plCurrent 为 null (closePlDetail 清掉了), 用选中行兜底
      const target = this.plCurrent ?? this.p.playlists[this.plSel]?.name ?? ""
      if (!target) {
        this.flash("重命名失败喵~ (找不到歌单)")
        this.closePlDialog()
        return
      }
      const ok = this.p.renamePlaylist(target, v)
      if (!ok) {
        this.flash("重命名失败喵~ (重名或为空)")
        this.closePlDialog()
        return
      }
      if (this.plCurrent === target) this.plCurrent = v
      this.flash(`✎ 已重命名为: ${v}`)
      // 重命名后, 选中原下标 (名称变了, 下标不变)
    }
    this.closePlDialog()
    this.renderPlList()
    if (this.plDetailMode) this.renderPlDetail()
  }

  /** 列表/详情按 Enter 时的动作 */
  plEnter() {
    if (this.plMode) {
      const list = this.p.playlists
      if (!list.length) {
        this.flash("还没有歌单喵~ 按 n 新建")
        return
      }
      const p = list[this.plSel]
      if (!p) return
      this.openPlDetail(p.name)
    } else if (this.plDetailMode && this.plCurrent) {
      const paths = this.p.playlistPaths(this.plCurrent)
      const path = paths[this.plDetailSel]
      if (!path) return
      // 把歌单映射成播放队列 (歌曲需在当前扫描目录中), 从选中处开始播
      const q = paths
        .map((p2) => this.p.playlist.indexOf(p2))
        .filter((i) => i !== -1)
      const realIdx = this.p.playlist.indexOf(path)
      if (realIdx === -1) {
        this.flash("歌曲不在当前目录喵~")
        return
      }
      this.p.queue = q
      this.p.playIndex(realIdx).then(() => {
        this.afterTrackChange()
        this.closePlDetail()
        this.closePlList()
        // 主视图下 sel 是 playlist 索引, 设成 realIdx 让高亮对齐实际播放
        this.sel = realIdx
        this.updatePlaylist()
      })
    }
  }

  /** 列表删除当前选中 (要二次确认) */
  plDelete() {
    if (this.plMode) {
      const list = this.p.playlists
      const p = list[this.plSel]
      if (!p) return
      if (!this.p.deletePlaylist(p.name)) return
      this.flash(`🗑 已删除歌单: ${p.name}`)
      if (this.plSel >= this.p.playlists.length) this.plSel = Math.max(0, this.p.playlists.length - 1)
      this.renderPlList()
    } else if (this.plDetailMode && this.plCurrent) {
      const paths = this.p.playlistPaths(this.plCurrent)
      const path = paths[this.plDetailSel]
      if (!path) return
      if (!this.p.removeTrackFromPlaylist(this.plCurrent, this.plDetailSel)) return
      this.flash(`已从歌单移除: ${path.split("/").pop()}`)
      if (this.plDetailSel >= this.p.playlistPaths(this.plCurrent).length) {
        this.plDetailSel = Math.max(0, this.p.playlistPaths(this.plCurrent).length - 1)
      }
      this.renderPlDetail()
    }
  }

  /** 详情页按 a: 进入"加歌选歌"模式. 复用 search 风格浏览, 但加歌而非替换 queue */
  enterPlPicker() {
    if (!this.plCurrent) return
    this.plPickerMode = true
    // 用 searchActive + queue 表示"过滤后的浏览" — 但这次 sel→path, 而非 sel→queue
    // 简化: 不走 queue, 直接用 sel 当 playlist 索引 (主播放列表是源)
    this.sel = 0
    // 隐藏详情/列表层, 但保留 plCurrent 供加歌与返回使用
    this.plDetailMode = false
    this.plDetailOverlay.visible = false
    this.plMode = false
    this.plListOverlay.visible = false
    this.flash("选歌模式: Enter 加入歌单 · Esc 取消")
  }

  /** 加歌选歌模式下按 Enter: 把当前选中的歌加进歌单, 不退出选歌模式 */
  plPickerAdd() {
    if (!this.plPickerMode || !this.plCurrent) return
    if (!this.p.playlist.length) return
    const idx = this.sel
    if (idx < 0 || idx >= this.p.playlist.length) return
    const path = this.p.playlist[idx]
    const added = this.p.addTrackToPlaylist(this.plCurrent, path)
    this.flash(added ? `✚ 已加入: ${path.split("/").pop()}` : `已在歌单中: ${path.split("/").pop()}`)
    // 下移一行, 方便连续加入
    this.sel = Math.min(this.p.playlist.length - 1, this.sel + 1)
    this.updatePlaylist()
  }

  /** 退出加歌选歌模式 (返回歌单详情) */
  plPickerExit() {
    this.plPickerMode = false
    if (this.plCurrent) this.openPlDetail(this.plCurrent)
  }

  /** 渲染歌单列表 */
  private renderPlList() {
    const list = this.p.playlists
    // 标题
    this.plListTitle.content = ` 共 ${list.length} 个歌单 `
    // 行
    if (this.plListRows.length !== list.length) {
      for (const r of this.plListRows) r.box.destroyRecursively()
      this.plListRows = []
      for (let i = 0; i < list.length; i++) {
        const box = new BoxRenderable(this.renderer, {
          id: `pll-${i}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 2,
          backgroundColor: this.theme.base,
        })
        const text = new TextRenderable(this.renderer, { content: "", selectable: false, width: "100%" })
        box.add(text)
        this.plListScroll.add(box)
        this.plListRows.push({ box, text })
      }
    }
    for (let i = 0; i < list.length; i++) {
      const row = this.plListRows[i]
      const pl = list[i]
      const marker = i === this.plSel ? "▶" : " "
      const line = `${marker} ${String(i + 1).padStart(2, " ")} ${pl.name}  (${pl.paths.length} 首)`
      if (i === this.plSel) {
        row.box.backgroundColor = this.theme.surface1
        row.text.content = t`${fg(this.theme.text)(bold(clipWidth(line, 200)))}`
      } else {
        row.box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.text)(clipWidth(line, 200))}`
      }
    }
    try { this.plListScroll.scrollChildIntoView(`pll-${this.plSel}`) } catch { /* ignore */ }
  }

  /** 渲染歌单详情 */
  private renderPlDetail() {
    if (!this.plCurrent) return
    const paths = this.p.playlistPaths(this.plCurrent)
    this.plDetailTitle.content = ` ${this.plCurrent} · ${paths.length} 首 `
    if (this.plDetailRows.length !== paths.length) {
      for (const r of this.plDetailRows) r.box.destroyRecursively()
      this.plDetailRows = []
      for (let i = 0; i < paths.length; i++) {
        const box = new BoxRenderable(this.renderer, {
          id: `pld-${i}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 2,
          backgroundColor: this.theme.base,
        })
        const text = new TextRenderable(this.renderer, { content: "", selectable: false, width: "100%" })
        box.add(text)
        this.plDetailScroll.add(box)
        this.plDetailRows.push({ box, text })
      }
    }
    for (let i = 0; i < paths.length; i++) {
      const row = this.plDetailRows[i]
      const name = paths[i].split("/").pop() || ""
      const marker = i === this.plDetailSel ? "▶" : " "
      const line = `${marker} ${String(i + 1).padStart(2, " ")} ${name}`
      if (i === this.plDetailSel) {
        row.box.backgroundColor = this.theme.surface1
        row.text.content = t`${fg(this.theme.text)(bold(clipWidth(line, 200)))}`
      } else {
        row.box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.text)(clipWidth(line, 200))}`
      }
    }
    try { this.plDetailScroll.scrollChildIntoView(`pld-${this.plDetailSel}`) } catch { /* ignore */ }
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
    const volStr = p.muted ? "🔇 静音" : `音量 ${p.volume}`
    this.headRightText.content =
      ` ${REPEAT_LABEL[p.repeat]} ┊ ${volStr}${p.speed !== 1 ? " ┊ ×" + p.speed.toFixed(2) : ""} `

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
          "空格 播放/暂停 · n/p 切歌 · f 收藏 · F 收藏模式 · P 歌单 · h 帮助 · s 随机 · m 循环 · t 主题 · / 搜索 · M 静音 · q 退出"
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