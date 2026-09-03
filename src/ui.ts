/**
 * OpenTUI 界面 — Catppuccin 四口味主题音乐播放器
 *
 * 列表区四视图 tab: 播放列表 / 收藏 / 歌单 / 设置 (1/2/3/4 或鼠标点击切换)
 * 歌单 tab 内二级: 歌单列表 → 某歌单详情 (Enter 进入, Esc 返回)
 * 歌单详情内 a 进入"加歌选歌"模式 (Enter 加入, Esc 返回)
 * 设置 tab: 主题 (←/→ 或 Enter 循环) / 音量 (←/→ ±5, 持久化) / 音乐目录 (Enter 弹层输入路径)
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
import { existsSync } from "fs"
import { resolve } from "path"
import { Player, REPEAT_CYCLE } from "./player"
import { THEMES, THEME_ORDER, THEME_LABEL, parseThemeName, type Theme, type ThemeName } from "./theme"
import { loadConfig, saveConfig } from "./config"
import type { MpvEvent } from "./mpv"

const REPEAT_LABEL: Record<string, string> = {
  OFF: "不循环",
  ALL: "列表循环",
  ONE: "单曲循环",
}

// 四视图 tab: 顺序即快捷键 1/2/3/4
const TAB_KEYS: Array<"list" | "fav" | "pl" | "settings"> = ["list", "fav", "pl", "settings"]
const TAB_LABELS = [" \uF03A 播放列表 ", " \uF004 收藏 ", " \uF1C5 歌单 ", " \uF013 设置 "]

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

  // 列表区四视图 tab: 播放列表 / 收藏 / 歌单 / 设置
  view: "list" | "fav" | "pl" | "settings" = "list"
  plLevel: "list" | "detail" = "list" // 歌单 tab 内: 歌单列表 / 某歌单详情
  plPickerMode = false // 歌单详情 a 触发的"加歌选歌"
  plCurrent: string | null = null // 详情/选歌模式的当前歌单名
  private savedListSel = 0 // 进歌单前列表游标, 返回时恢复
  private savedFavSel = 0 // 进设置前收藏游标, 返回时恢复
  private dirInput = "" // 设置: 改目录弹层输入缓冲

  // 弹层输入态: "new" 新建 / "rename" 重命名 / "set-dir" 改音乐目录 / null 不弹
  plDialogMode: "new" | "rename" | "set-dir" | null = null
  plDialogValue = ""

  // ---------- 节点引用 ----------
  private eqText!: TextRenderable
  private headModeText!: TextRenderable
  private headRightText!: TextRenderable
  private nowStatusText!: TextRenderable
  private nowTitleText!: TextRenderable
  private progressText!: TextRenderable
  private timeText!: TextRenderable
  private lyricInner!: BoxRenderable
  private lyricRows: TextRenderable[] = []
  private plTitle!: TextRenderable
  private plRows: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private scrollbox!: ScrollBoxRenderable
  private statusLeft!: TextRenderable
  private statusRight!: TextRenderable

  private fullLyricRows: TextRenderable[] = []
  private timeBox!: BoxRenderable
  private nowPlayBox!: BoxRenderable
  private searchInput!: InputRenderable
  private helpOverlay!: BoxRenderable
  private fullOverlay!: BoxRenderable
  private fullTitle!: TextRenderable
  private fullProgress!: TextRenderable
  // 歌单命名/重命名弹层 (保留: 是输入框, 非列表视图)
  private plDialogOverlay!: BoxRenderable
  private plDialogTitle!: TextRenderable
  private plDialogInput!: InputRenderable
  private plDialogHint!: TextRenderable
  // tab 栏 (播放列表 / 收藏 / 歌单)
  private tabBar!: BoxRenderable
  private tabBtns: BoxRenderable[] = []
  private tabTexts: TextRenderable[] = []
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
    headLeft.add(new TextRenderable(r, { content: t`${bold(fg(this.theme.sky)("\uF025 蓝汐音乐"))}`, selectable: false }))
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
    this.nowStatusText = new TextRenderable(r, { content: "\uF04D 待机", fg: this.theme.subtext, selectable: false })
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
    this.timeBox.onMouseDown = (ev: MouseEvent) => this.seekFromMouse(ev)
    this.timeBox.onMouseDrag = (ev: MouseEvent) => this.seekFromMouse(ev)
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

    // ── 视图切换 tab (播放列表 / 收藏 / 歌单) ──
    this.tabBar = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      gap: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      backgroundColor: this.theme.mantle,
      paddingLeft: 1,
    })
    this.tabBtns = []
    this.tabTexts = []
    for (let i = 0; i < TAB_LABELS.length; i++) {
      const btn = new BoxRenderable(r, {
        id: `tab-${i}`,
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: this.theme.surface0,
        onMouseDown: () => this.setView(TAB_KEYS[i]),
      })
      const txt = new TextRenderable(r, { content: TAB_LABELS[i], selectable: false })
      btn.add(txt)
      this.tabBar.add(btn)
      this.tabBtns.push(btn)
      this.tabTexts.push(txt)
    }
    root.add(this.tabBar)
    this.updateTabBar()

    // ── 播放列表 (三视图共享此区) ──
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
    const helpLines: [string, string][] = [
      ["播放控制", "空格/Enter 播放|暂停|播放选中 · n/p 下一首/上一首 · . 手动下一首"],
      ["快进快退", "←/→ ±5秒 · [/] ±10秒"],
      ["列表操作", "↑↓/jk 选择曲目 · 点击行直接播放 · 1/2/3/4 切换 列表/收藏/歌单/设置"],
      ["随机与循环", "s 随机播放开关 · m 循环模式(不循环→列表→单曲)"],
      ["歌词与全屏", "l 歌词显示开关 · L 全屏 KTV 歌词"],
      ["收藏与模式", "f 收藏当前歌曲 · 2 收藏视图 · F 收藏模式(快捷)"],
      ["倍速与音量", "r 减速(0.25x步长) · a 加速 · + 增音量 · - 减音量 · M/0 静音"],
      ["歌单", "3 歌单 · n 新建 · r 重命名 · d 删除 · Enter 进入详情 · a 加歌 · x 移除"],
      ["搜索与重扫", "/ 搜索(支持中文) · Enter 确认 · Esc 取消 · d 重新扫描目录"],
      ["设置", "4 进入 \uF013 设置 · 主题(Catppuccin 四口味) / 音量(自动保存) / 音乐目录 · h 帮助"],
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

    // 视图内导航: j/k/up/down 由各视图处理 (统一用 sel + 视图感知计数)
    if (name === "up" || seq === "k") {
      this.moveSel(-1)
      key.preventDefault()
      return
    }
    if (name === "down" || seq === "j") {
      this.moveSel(1)
      key.preventDefault()
      return
    }

    // 设置视图 (view==="settings") 特有按键: Esc 返回, ←/→ 调整当前项, Enter 触发
    if (this.view === "settings") {
      if (name === "escape") {
        this.setView("list")
        key.preventDefault()
        return
      }
      if (name === "left") {
        this.settingAdjust(-1)
        key.preventDefault()
        return
      }
      if (name === "right") {
        this.settingAdjust(1)
        key.preventDefault()
        return
      }
      if (name === "return" || name === "enter") {
        this.settingEnter()
        key.preventDefault()
        return
      }
      // +/- 音量 / 1..4 切视图 / h 帮助 / q 退出 仍走下方 switch
    }

    // 歌单视图 (view==="pl") 的特有按键
    if (this.view === "pl") {
      if (name === "escape") {
        if (this.plPickerMode) this.plPickerExit()
        else if (this.plLevel === "detail") this.closePlDetail()
        else this.setView("list")
        key.preventDefault()
        return
      }
      if (this.plPickerMode) {
        // 加歌选歌模式: Enter 加入, 不退出; 其它键落入正常 switch
        if (name === "return" || name === "enter") {
          this.plPickerAdd()
          key.preventDefault()
          return
        }
        // 加歌模式下 P 切回列表 (跳过歌单特有路由)
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
        if (seq === "r" && this.plLevel === "list") {
          const cur = this.p.playlists[this.sel]
          if (cur) this.openPlDialog("rename", cur.name)
          key.preventDefault()
          return
        }
        if (seq === "d") {
          this.plDelete()
          key.preventDefault()
          return
        }
        if (seq === "a" && this.plLevel === "detail") {
          this.enterPlPicker()
          key.preventDefault()
          return
        }
        if (seq === "x" && this.plLevel === "detail") {
          this.plDelete()
          key.preventDefault()
          return
        }
        if (seq === "P") {
          this.setView("list")
          key.preventDefault()
          return
        }
      }
    }

    // ---- 正常模式 ----
    switch (true) {
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
        this.flash(p.isShuffle ? "\uF074 随机播放已开启" : "\uF001 顺序播放已开启")
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
        this.setView("fav")
        key.preventDefault()
        break
      case seq === "1":
        this.setView("list")
        key.preventDefault()
        break
      case seq === "2":
        this.setView("fav")
        key.preventDefault()
        break
      case seq === "3":
        this.setView("pl")
        key.preventDefault()
        break
      case seq === "4":
        this.setView("settings")
        key.preventDefault()
        break
      case seq === "P":
        this.setView("pl")
        key.preventDefault()
        break
      case seq === "h":
        this.showHelp = true
        this.helpOverlay.visible = true
        break
      case seq === "+" || seq === "=":
        p.setVolume(p.volume + 5)
        saveConfig({ volume: p.volume })
        this.flash(`音量 ${p.volume} (已保存)`)
        this.updatePlaylist()
        break
      case seq === "-" || seq === "_":
        p.setVolume(p.volume - 5)
        saveConfig({ volume: p.volume })
        this.flash(`音量 ${p.volume} (已保存)`)
        this.updatePlaylist()
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
        p.toggleMute().then(() => {
          this.flash(p.muted ? "\uF026 已静音喵~" : `音量 ${p.volume} 喵~`)
          this.updatePlaylist()
        })
        break
      case seq === "t":
        this.flash("主题请在 \uF013 设置 里调整喵~ (4 进入)")
        break
      case seq === "q" || seq === "Q" || name === "escape":
        if (name === "escape" && this.searchActive) {
          this.exitSearch(true)
        } else {
          this.quit()
        }
        break
    }
  }

  // =========================================================
  //  视图切换 (tab)
  // =========================================================

  /** 切换列表区视图: list / fav / pl / settings */
  setView(v: "list" | "fav" | "pl" | "settings") {
    if (this.view === v) {
      // 再按一次歌单 tab: 若在详情则返回列表
      if (v === "pl" && this.plLevel === "detail") this.closePlDetail()
      return
    }
    const p = this.p
    // 离开前保存各视图游标
    if (this.view === "list") this.savedListSel = this.sel
    else if (this.view === "fav") this.savedFavSel = this.sel
    // 从歌单离开: 若在详情/选歌, 先回列表级
    if (this.view === "pl") {
      this.plPickerMode = false
      if (this.plLevel === "detail") this.plLevel = "list"
      this.plCurrent = null
    }
    if (v === "fav") {
      if (!p.favorites.length) {
        this.flash("还没有收藏喵~ 按 f 收藏歌曲")
        return
      }
      if (!p.favMode) p.toggleFavMode()
      this.sel = Math.max(0, Math.min(p.queue.length - 1, this.savedFavSel))
    } else {
      // favMode 严格跟随 view: 离开收藏即恢复全量 queue
      if (p.favMode) p.toggleFavMode()
      if (v === "pl") {
        this.plLevel = "list"
        this.sel = 0
      } else if (v === "settings") {
        this.sel = 0
      } else {
        this.sel = Math.max(0, Math.min(Math.max(0, p.playlist.length - 1), this.savedListSel))
      }
    }
    this.view = v
    this.searchActive = false
    this.searchQuery = ""
    this.updateTabBar()
    this.updatePlaylist()
  }

  /** 刷新 tab 栏高亮 (仅 view 变化时调用) */
  private updateTabBar() {
    const curIdx = TAB_KEYS.indexOf(this.view)
    for (let i = 0; i < this.tabBtns.length; i++) {
      const active = i === curIdx
      this.tabBtns[i].backgroundColor = active ? this.theme.surface2 : this.theme.surface0
      this.tabTexts[i].content = active
        ? t`${bold(fg(this.theme.sky)(TAB_LABELS[i]))}`
        : t`${fg(this.theme.subtext)(TAB_LABELS[i])}`
    }
  }

  // =========================================================
  //  动作
  // =========================================================
  flash(text: string, seconds = 1.6) {
    this.msg = text
    this.msgUntil = Date.now() + seconds * 1000
  }

  /** 当前视图的行数 */
  private listCount(): number {
    const p = this.p
    if (this.view === "settings") return 3
    if (this.view === "pl") {
      if (this.plLevel === "list") return p.playlists.length
      // detail: plCurrent 的歌曲; picker: 全库
      if (this.plPickerMode) return p.playlist.length
      return this.plCurrent ? p.playlistPaths(this.plCurrent).length : 0
    }
    // list / fav: 搜索/收藏时用 queue, 否则全列表
    if (this.searchActive || (this.view === "fav" && !this.searchActive) || (this.view === "list" && p.favMode)) {
      return p.queue.length
    }
    return p.playlist.length
  }

  moveSel(delta: number) {
    const n = this.listCount()
    if (!n) return
    this.sel = Math.max(0, Math.min(n - 1, this.sel + delta))
    this.updatePlaylist()
  }

  /** Enter / 空格播放: 根据视图分发 */
  playSel() {
    const p = this.p
    if (this.view === "pl") {
      this.plEnter()
      return
    }
    if (this.view === "settings") {
      this.settingEnter()
      return
    }
    if (!p.playlist.length) return
    // list / fav: sel 是 queue 中的位置 (搜索/收藏/favMode) 或 playlist 索引
    const useQueue = this.searchActive || this.view === "fav" || p.favMode
    const realIdx = useQueue
      ? p.selToPlaylistIdx(this.sel, true)
      : this.sel
    p.playIndex(realIdx).then(() => {
      this.afterTrackChange()
      if (p.queue.includes(realIdx)) this.sel = p.queue.indexOf(realIdx)
      else this.sel = realIdx
      this.updatePlaylist()
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
    if (this.view === "settings" || this.view === "pl") return
    if (!p.playlist.length) return
    const useQueue = this.searchActive || this.view === "fav" || p.favMode
    const realIdx = useQueue
      ? p.selToPlaylistIdx(this.sel, true)
      : this.sel
    const added = p.toggleFavorite(realIdx)
    this.flash(`${added ? "\uF004 已收藏" : "已取消收藏"}: ${p.playlist[realIdx].split("/").pop()}`)
    this.updatePlaylist()
  }

  // ---------- 设置视图 ----------

  /** 设置项 Enter: 0 主题循环 / 2 改目录弹层 */
  settingEnter() {
    if (this.sel === 0) this.cycleTheme()
    else if (this.sel === 2) this.openPlDialog("set-dir", this.p.musicDir)
    else this.flash("用 ←/→ 或 +/- 调整音量喵~ (自动保存)")
  }

  /** 设置项 ←/→: 主题=前/后切换, 音量=∓5 (持久化) */
  settingAdjust(dir: number) {
    const p = this.p
    if (this.sel === 0) {
      const cur = THEME_ORDER.indexOf(this.themeName)
      const n = THEME_ORDER.length
      const next = THEME_ORDER[((cur + dir) % n + n) % n]
      this.applyTheme(next)
      saveConfig({ theme: next })
      this.flash(`\uF1FC 主题: ${THEME_LABEL[next]} (已保存)`, 2.2)
    } else if (this.sel === 1) {
      p.setVolume(p.volume + dir * 5)
      saveConfig({ volume: p.volume })
      this.flash(`音量 ${p.volume} (已保存)`)
      this.updatePlaylist()
    }
  }

  /** 改音乐目录: 校验 + 持久化 + 重扫 */
  applyMusicDir(dir: string) {
    const p = this.p
    let abs = dir
    try {
      abs = resolve(dir)
    } catch {
      /* ignore */
    }
    if (!existsSync(abs)) {
      this.flash(`目录不存在喵~: ${dir}`)
      return
    }
    saveConfig({ music_directory: abs })
    p.musicDir = abs
    p.refreshDir().then((n) => {
      this.sel = p.idx
      this.updatePlaylist()
      this.flash(`\uF07C 已切换音乐目录: ${abs} (${n} 首)`, 2.5)
    })
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
      if (this.view === "fav" || p.favMode) {
        // 收藏视图退出搜索: 重建收藏 queue
        p.queue = p.favorites
          .map((f) => p.playlist.indexOf(f))
          .filter((i) => i !== -1)
      } else {
        p.queue = Array.from({ length: p.playlist.length }, (_, i) => i)
      }
      this.sel = p.idx
      this.flash("已退出搜索喵~")
      this.updatePlaylist()
    } else {
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

  applyTheme(name: ThemeName) {
    const next = THEMES[name]
    if (!next) return
    const prevName = this.themeName
    if (prevName === name) return
    const help = this.showHelp
    const full = this.fullLyrics
    const search = this.searchMode
    const searchA = this.searchActive
    const searchQ = this.searchQuery
    const msg = this.msg
    const msgUntil = this.msgUntil
    const view = this.view
    const plLevel = this.plLevel
    const plCur = this.plCurrent
    const plPicker = this.plPickerMode
    const savedSel = this.savedListSel
    const sel = this.sel

    for (const ch of this.renderer.root.getChildren()) {
      ch.destroyRecursively()
    }
    this.themeName = name
    this.theme = next
    this.plRows = []
    this.lyricRows = []
    this.fullLyricRows = []
    this.buildTree()

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
    this.view = view
    this.plLevel = plLevel
    this.plCurrent = plCur
    this.plPickerMode = plPicker
    this.savedListSel = savedSel
    this.sel = sel
    this.lastPlTitle = "" // 标题节点已重建, 缓存作废, 让 tick 重写
    this.updateTabBar()
    this.updatePlaylist()
    this.updateNowPlaying()
    if (full) this.updateFullLyrics()
  }

  cycleTheme() {
    const cur = THEME_ORDER.indexOf(this.themeName)
    const next = THEME_ORDER[(cur + 1) % THEME_ORDER.length]
    this.applyTheme(next)
    saveConfig({ theme: next })
    this.flash(`\uF1FC 主题: ${THEME_LABEL[next]}`, 2.2)
  }

  quit() {
    this.onQuit?.()
  }

  // =========================================================
  //  歌单
  // =========================================================

  /** 歌单列表 → 详情 */
  openPlDetail(name: string) {
    this.plCurrent = name
    this.plLevel = "detail"
    this.sel = 0
    this.updatePlaylist()
  }

  /** 详情 → 歌单列表 */
  closePlDetail() {
    this.plLevel = "list"
    this.plCurrent = null
    this.sel = Math.min(this.sel, Math.max(0, this.p.playlists.length - 1))
    this.updatePlaylist()
  }

  /** 弹出输入弹层: 新建/重命名歌单 / 修改音乐目录 */
  openPlDialog(mode: "new" | "rename" | "set-dir", preset = "") {
    this.plDialogMode = mode
    this.plDialogValue = preset
    this.plDialogInput.value = preset
    this.plDialogInput.width = mode === "set-dir" ? 70 : 40
    this.plDialogTitle.content =
      mode === "new"
        ? t`${bold(fg(this.theme.sky)(" \uF067 新建歌单 "))}`
        : mode === "rename"
          ? t`${bold(fg(this.theme.sky)(" \uF044 重命名歌单 "))}`
          : t`${bold(fg(this.theme.sky)(" \uF07B 修改音乐目录 "))}`
    this.plDialogHint.content =
      mode === "new"
        ? "输入名称 · Enter 确认 · Esc 取消"
        : mode === "rename"
          ? `原名: ${preset}  ·  Enter 确认 · Esc 取消`
          : `当前: ${preset}  ·  输入完整路径 · Enter 确认重扫 · Esc 取消`
    this.plDialogOverlay.visible = true
    this.plDialogInput.focus()
  }

  closePlDialog() {
    const wasDir = this.plDialogMode === "set-dir"
    this.plDialogMode = null
    this.plDialogValue = ""
    this.plDialogInput.value = ""
    this.plDialogInput.width = 40
    this.plDialogOverlay.visible = false
    this.plDialogInput.blur()
    if (wasDir && this.view === "settings") this.updatePlaylist()
  }

  commitPlDialog(value: string) {
    const v = value.trim()
    if (this.plDialogMode === "set-dir") {
      this.closePlDialog()
      if (v) this.applyMusicDir(v)
      return
    }
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
      this.flash(`\uF067 已创建歌单: ${v}`)
      this.sel = idx
    } else if (this.plDialogMode === "rename") {
      const target = this.plCurrent ?? this.p.playlists[this.sel]?.name ?? ""
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
      this.flash(`\uF044 已重命名为: ${v}`)
    }
    this.closePlDialog()
    this.updatePlaylist()
  }

  /** 歌单视图 Enter: 列表→进详情, 详情→播放选中 */
  plEnter() {
    const p = this.p
    if (this.plLevel === "list") {
      const list = p.playlists
      if (!list.length) {
        this.flash("还没有歌单喵~ 按 n 新建")
        return
      }
      const pl = list[this.sel]
      if (!pl) return
      this.openPlDetail(pl.name)
    } else if (this.plLevel === "detail" && this.plCurrent) {
      const paths = p.playlistPaths(this.plCurrent)
      const path = paths[this.sel]
      if (!path) return
      const q = paths
        .map((p2) => p.playlist.indexOf(p2))
        .filter((i) => i !== -1)
      const realIdx = p.playlist.indexOf(path)
      if (realIdx === -1) {
        this.flash("歌曲不在当前目录喵~")
        return
      }
      p.queue = q
      p.playIndex(realIdx).then(() => {
        this.afterTrackChange()
        // 播放后切回列表视图, sel 对齐实际播放
        this.setView("list")
        this.sel = realIdx
        this.updatePlaylist()
      })
    }
  }

  /** 删除: 列表删歌单 / 详情删歌曲 */
  plDelete() {
    const p = this.p
    if (this.plLevel === "list") {
      const list = p.playlists
      const pl = list[this.sel]
      if (!pl) return
      if (!p.deletePlaylist(pl.name)) return
      this.flash(`\uF1F8 已删除歌单: ${pl.name}`)
      if (this.sel >= p.playlists.length) this.sel = Math.max(0, p.playlists.length - 1)
      this.updatePlaylist()
    } else if (this.plLevel === "detail" && this.plCurrent) {
      const paths = p.playlistPaths(this.plCurrent)
      const path = paths[this.sel]
      if (!path) return
      if (!p.removeTrackFromPlaylist(this.plCurrent, this.sel)) return
      this.flash(`已从歌单移除: ${path.split("/").pop()}`)
      const newLen = p.playlistPaths(this.plCurrent).length
      if (this.sel >= newLen) this.sel = Math.max(0, newLen - 1)
      this.updatePlaylist()
    }
  }

  /** 详情页 a: 加歌选歌模式 */
  enterPlPicker() {
    if (!this.plCurrent) return
    this.plPickerMode = true
    this.sel = 0
    this.flash("选歌模式: Enter 加入歌单 · Esc 取消")
    this.updatePlaylist()
  }

  /** 加歌模式下 Enter: 加入歌单, 不退出 */
  plPickerAdd() {
    if (!this.plPickerMode || !this.plCurrent) return
    const p = this.p
    if (!p.playlist.length) return
    const idx = this.sel
    if (idx < 0 || idx >= p.playlist.length) return
    const path = p.playlist[idx]
    const added = p.addTrackToPlaylist(this.plCurrent, path)
    this.flash(added ? `\uF055 已加入: ${path.split("/").pop()}` : `已在歌单中: ${path.split("/").pop()}`)
    this.sel = Math.min(p.playlist.length - 1, this.sel + 1)
    this.updatePlaylist()
  }

  /** 退出加歌选歌 → 返回歌单详情 */
  plPickerExit() {
    this.plPickerMode = false
    this.sel = 0
    this.updatePlaylist()
  }

  onQuit: (() => void) | null = null
  setFullLyrics(on: boolean) {
    this.fullLyrics = on
    this.fullOverlay.visible = on
    if (on) this.updateFullLyrics()
  }

  // =========================================================
  //  播放列表渲染 (按 view 分发)
  // =========================================================
  private rebuildPlaylistRows(count: number) {
    for (const row of this.plRows) {
      row.box.destroyRecursively()
    }
    this.plRows = []
    for (let i = 0; i < count; i++) {
      const rowIdx = i
      const box = new BoxRenderable(this.renderer, {
        id: `pl-${i}`,
        width: "100%",
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 2,
        backgroundColor: this.theme.base,
        onMouseDown: () => {
          this.onRowClick(rowIdx)
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

  /** 行点击: 根据视图行为不同 */
  private onRowClick(i: number) {
    const p = this.p
    if (this.view === "settings") {
      this.sel = i
      this.updatePlaylist()
      this.settingEnter()
      return
    }
    if (this.view === "pl") {
      if (this.plLevel === "list") {
        this.sel = i
        this.updatePlaylist()
        this.plEnter()
      } else if (this.plPickerMode) {
        this.sel = i
        this.updatePlaylist()
        this.plPickerAdd()
      } else {
        // 详情: 点击播放 播放
        this.sel = i
        this.updatePlaylist()
        this.plEnter()
      }
    } else {
      // list / fav
      this.sel = i
      this.updatePlaylist()
      const useQueue = this.searchActive || this.view === "fav" || p.favMode
      const real = useQueue ? p.queue[i] : i
      if (real !== undefined) this.playIndex(real)
    }
  }

  /** 当前视图每行数据: 返回 [marker, text, isPlaying] */
  private rowAt(i: number): { marker: string; text: string; playing: boolean } {
    const p = this.p
    if (this.view === "settings") {
      const vol = p.volume
      const filled = Math.round((vol / 150) * 20)
      const bar = "█".repeat(filled) + "░".repeat(20 - filled)
      const mute = p.muted ? " \uF026" : ""
      const rows = [
        `主题        ${THEME_LABEL[this.themeName]}  (${THEME_ORDER.length} 种, ←/→ 或 Enter 切换)`,
        `音量        ${bar} ${vol}${mute}  (←/→ 或 +/- 调整, 自动保存)`,
        `音乐目录    ${clipWidth(p.musicDir, 100)}  (Enter 修改)`,
      ]
      return { marker: " ", text: rows[i] || "", playing: false }
    }
    if (this.view === "pl") {
      if (this.plLevel === "list") {
        const list = p.playlists
        const pl = list[i]
        if (!pl) return { marker: " ", text: "", playing: false }
        return { marker: " ", text: `${String(i + 1).padStart(2, " ")} ${pl.name}  (${pl.paths.length} 首)`, playing: false }
      }
      if (this.plPickerMode) {
        const path = p.playlist[i]
        if (!path) return { marker: " ", text: "", playing: false }
        const name = path.split("/").pop() || ""
        const inPl = this.plCurrent ? p.playlistPaths(this.plCurrent).includes(path) : false
        return { marker: inPl ? "\uF067" : " ", text: `${String(i + 1).padStart(2, " ")} ${name}`, playing: i === p.idx }
      }
      // detail
      if (!this.plCurrent) return { marker: " ", text: "", playing: false }
      const paths = p.playlistPaths(this.plCurrent)
      const path = paths[i]
      if (!path) return { marker: " ", text: "", playing: false }
      const name = path.split("/").pop() || ""
      const realIdx = p.playlist.indexOf(path)
      return { marker: " ", text: `${String(i + 1).padStart(2, " ")} ${name}`, playing: realIdx === p.idx }
    }
    // list / fav
    const useQueue = this.searchActive || this.view === "fav" || p.favMode
    const orig = useQueue ? p.queue[i] : i
    if (orig === undefined || !p.playlist[orig]) return { marker: " ", text: "", playing: false }
    const path = p.playlist[orig]
    const name = path.split("/").pop() || ""
    const fav = p.favorites.includes(path)
    return {
      marker: orig === p.idx ? "\uF04B" : " ",
      text: `${String(i + 1).padStart(2, " ")} ${name}${fav ? " \uF004" : ""}`,
      playing: orig === p.idx,
    }
  }

  updatePlaylist() {
    const p = this.p
    const n = this.listCount()
    if (this.plRows.length !== n) this.rebuildPlaylistRows(n)
    for (let i = 0; i < n; i++) {
      const row = this.plRows[i]
      const { marker, text, playing } = this.rowAt(i)
      const isSel = i === this.sel
      const line = `${marker} ${text}`
      const box = row.box
      if (isSel) {
        box.backgroundColor = this.theme.surface1
        row.text.content = t`${fg(this.theme.text)(bold(clipWidth(line, 200)))}`
      } else if (playing) {
        box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.green)(bold(clipWidth(line, 200)))}`
      } else {
        box.backgroundColor = this.theme.base
        row.text.content = t`${fg(this.theme.text)(clipWidth(line, 200))}`
      }
    }
    try {
      this.scrollbox.scrollChildIntoView(`pl-${this.sel}`)
    } catch {
      /* ignore */
    }
  }

  playlistTitle(): string {
    const p = this.p
    if (this.view === "settings") return ` \uF013 设置 · ↑↓ 选择 · Enter/←→ 调整 · Esc 返回 `
    if (this.view === "pl") {
      if (this.plPickerMode && this.plCurrent) return ` 加歌 → ${this.plCurrent} · Enter 加入 · Esc 返回 `
      if (this.plLevel === "detail" && this.plCurrent) {
        const c = p.playlistPaths(this.plCurrent).length
        return ` ${this.plCurrent} · ${c} 首 · Esc 返回 `
      }
      return ` 歌单 · 共 ${p.playlists.length} 个 · n 新建 · Enter 进入 `
    }
    if (this.searchActive) return ` 搜索结果 ${p.queue.length} 首 `
    if (this.view === "fav") return ` \uF004 收藏 ${p.queue.length} 首 · 1 列表 `
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

    // 头部信息: 视图 + 模式
    const mode =
      this.view === "settings" ? "\uF013 设置" :
      p.isShuffle ? "\uF074 随机" :
      this.searchActive ? "\uF002 搜索" :
      this.view === "fav" ? "\uF004 收藏" :
      this.view === "pl" ? "\uF1C5 歌单" : "\uF001 列表"
    this.headModeText.content = ` ${mode} `
    const volStr = p.muted ? "\uF026 静音" : `音量 ${p.volume}`
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
          "空格 播放/暂停 · n/p 切歌 · f 收藏 · 1/2/3/4 列表/收藏/歌单/设置 · / 搜索 · M 静音 · +/- 音量 · h 帮助 · q 退出"
        this.statusLeft.fg = this.theme.subtext
      }
    }
    this.statusRight.content = p.playing
      ? ` ${p.currentBase()} · ${String(p.idx + 1)}/${p.playlist.length} `
      : ` 共 ${p.playlist.length} 首 `

    // 淡入淡出
    p.updateFade()

    // duration 兜底
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
    const status = p.playing ? (p.paused ? "\uF04C 已暂停" : "\uF04B 播放中") : "\uF04D 待机"
    this.nowStatusText.content = status
    this.nowStatusText.fg = p.playing ? (p.paused ? this.theme.yellow : this.theme.green) : this.theme.subtext
    let title = p.currentTitle()
    const artist = p.currentArtist()
    if (artist) title += ` ┊ ${artist}`
    this.nowTitleText.content = title

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
          row.content = t`${fg(this.theme.sky)(bold("\uF001 " + txt))}`
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
    this.fullTitle.content = ` ${p.playing ? (p.paused ? "\uF04C" : "\uF04B") : "⏹"} ${title} `
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
    const MID = Math.floor(this.fullLyricRows.length / 2)
    for (let r = 0; r < this.fullLyricRows.length; r++) {
      const offset = r - MID
      const idx = cur + offset
      const row = this.fullLyricRows[r]
      if (offset === 0) {
        row.content = t`${fg(this.theme.sky)(bold("\uF001     " + p.lyrics[cur].text))}`
      } else if (idx >= 0 && idx < p.lyrics.length) {
        const col = Math.abs(offset) <= 1 ? this.theme.subtext : this.theme.overlay
        row.content = t`${fg(col)("      " + p.lyrics[idx].text)}`
      } else {
        row.content = ""
      }
    }
  }
}
