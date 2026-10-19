/**
 * OpenTUI 界面 — 蓝汐音乐
 *
 * 布局 (宽终端 ≥ 100 列):
 *   ┌ 顶栏 ────────────────────────────────────────────────┐
 *   │ 蓝汐音乐  [视图]           睡眠 · 循环 · 音量 · 倍速 │
 *   ├ 侧栏 (40 列) ─────────┬ 主区 ───────────────────────┤
 *   │ 正在播放卡片          │ 标签栏 + 指示条             │
 *   │ 歌词 (自动增高)       │ 列表 / 设置 / 歌单 / 队列   │
 *   │ 接下来 3 首           │                             │
 *   └───────────────────────┴─────────────────────────────┘
 *   ┌ 状态栏 ──────────────────────────────────────────────┐
 *
 * 窄终端 (< 100 列) 自动改为单列堆叠, 歌词区在无歌词时收起。
 *
 * ── 维护约定 ──
 * - 颜色一律从 this.theme 取, 主题切换 = 整树重建 (applyTheme)。
 * - 动效只碰装饰节点 (logo/频谱/进度条/指示条/通知); 列表行内容由
 *   updatePlaylist 独占写入, 避免两份真相源互踩导致闪烁。
 * - 所有文本宽度用 gfx 的 displayWidth/clipWidth/fitWidth (CJK 计 2 列)。
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  StyledText,
  bold,
  fg,
  t,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"
import { existsSync } from "fs"
import { homedir } from "os"
import { resolve } from "path"
import { Player, SORT_MODES, SORT_LABEL } from "./player"
import { titleOf } from "./scanner"
import { THEMES, THEME_ORDER, THEME_LABEL, type Theme, type ThemeName } from "./theme"
import { saveConfig, saveMusicDirs } from "./config"
import { CACHE_DIR, clearCache, ensureCacheDir } from "./cache"
import { computeStats, fmtDuration, fmtAgo } from "./stats"
import type { MpvEvent } from "./mpv"
import { VERSION } from "./version"
import {
  mixHex,
  paletteAt,
  pulse,
  displayWidth,
  clipWidth,
  fitWidth,
  scrollText,
  fmt,
  fmtShort,
  progressBar,
  gradientLine,
  levelChar,
  LEVEL_BLOCKS,
} from "./ui/gfx"
import {
  buildHeader,
  buildPlayer,
  buildLyrics,
  buildTabs,
  buildList,
  buildRow,
  buildStatus,
  buildOverlay,
  panel,
  type HeaderNodes,
  type PlayerNodes,
  type LyricNodes,
  type TabNodes,
  type ListNodes,
  type RowNodes,
  type StatusNodes,
  type CardNodes,
} from "./ui/widgets"

const REPEAT_LABEL: Record<string, string> = {
  OFF: "不循环",
  ALL: "列表循环",
  ONE: "单曲循环",
}
const REPEAT_ICON: Record<string, string> = { OFF: "→", ALL: "↻", ONE: "↻¹" }

export type ViewName = "list" | "fav" | "pl" | "settings" | "queue"
const TAB_KEYS: ViewName[] = ["list", "fav", "pl", "settings", "queue"]
const TAB_LABELS = ["播放列表", "收藏", "歌单", "设置", "队列"]
const TAB_ICONS = ["♪", "♥", "❏", "⚙", "≡"]

const SETTING_ROW_COUNT = 9
const TOAST_MAX = 3
const TOAST_MS = 2400
const ANIM_FAST_MS = 33
const ANIM_IDLE_MS = 180
/** 宽终端切换阈值 (列) */
const WIDE_COLS = 100
/** 侧栏宽度 (列) */
const SIDEBAR_W = 40
/** 提示条: 底部最多显示多少列 */
const HINT_MAX = 120

/** 视图标签每帧的过渡值 (0=闲置, 1=激活) */
type TabState = { level: number[]; target: number[]; pos: number }

export class PlayerUI {
  // ---------- 选择/输入状态 ----------
  sel = 0
  msg = ""
  msgUntil = 0
  searchMode = false
  searchActive = false
  searchQuery = ""
  showHelp = false
  fullLyrics = false
  showInfo = false

  view: ViewName = "list"
  plLevel: "list" | "detail" = "list"
  plPickerMode = false
  plCurrent: string | null = null
  private savedSel: Record<ViewName, number> = { list: 0, fav: 0, pl: 0, settings: 0, queue: 0 }
  /** 搜索前保存队列与 favMode, 退出搜索时原样恢复 (不再把队列重置成整库) */
  private preSearch: { queue: number[]; favMode: boolean; sel: number; idx: number } | null = null

  showSort = false
  sortCursor = 0
  showStats = false
  showDirManager = false
  dirCursor = 0

  private sleepFading = false
  private sleepFadeFrom = 100
  private sleepFadeAt = 0
  private toasts: Array<{ id: number; text: string; color: string; at: number }> = []
  private toastSeq = 0
  private viewAnimT = 1
  private marqueeAnchor = 0
  private lastMarqueeSel = -1
  private selMarquee: { text: string; width: number } | null = null

  plDialogMode: "new" | "rename" | "rename-song" | "add-dir" | null = null
  plDialogValue = ""
  private pendingSongPath: string | null = null

  confirmAction: (() => void) | null = null
  private confirmMessage = ""

  // ---------- 节点引用 ----------
  private root!: BoxRenderable
  private main!: BoxRenderable
  private sidebar!: BoxRenderable
  private rightCol!: BoxRenderable
  private header!: HeaderNodes
  private now!: PlayerNodes
  private lyrics!: LyricNodes
  private upcoming!: { box: BoxRenderable; rows: TextRenderable[] }
  private tabs!: TabNodes
  private list!: ListNodes
  private status!: StatusNodes
  private searchInput!: InputRenderable

  private plRows: RowNodes[] = []
  private lyricRowCount = 0

  private help!: CardNodes
  private info!: CardNodes
  private sort!: CardNodes
  private stats!: CardNodes
  private dirs!: CardNodes
  private dialog!: CardNodes
  private confirm!: CardNodes
  private full!: CardNodes
  private fullTitle!: TextRenderable
  private fullProgress!: TextRenderable
  private fullLyricRows: TextRenderable[] = []

  private tabState: TabState = { level: [], target: [], pos: 0 }
  private playsTotal = -1
  private lastPlTitle = ""
  private lastTabsWidth = -1
  private theme: Theme = THEMES.mocha
  private themeName: ThemeName = "mocha"

  private animTimer: Timer | undefined = undefined
  private animMs = 0
  private tickCount = 0
  private spectrumPeaks: number[] = []
  private spectrumSeed = 0.37
  private spectrumSeedPath: string | null = null
  private wide = true
  private lastWide = true

  /** 退出回调 (index.ts 注入) */
  onQuit: (() => void) | null = null

  constructor(
    private renderer: CliRenderer,
    readonly p: Player,
    themeName: ThemeName = "mocha",
  ) {
    this.themeName = themeName in THEMES ? themeName : "mocha"
    this.theme = THEMES[this.themeName]
    this.p.onDurationsUpdated = () => {
      if (this.view !== "settings") this.updatePlaylist()
    }
    this.build()
    this.renderer.keyInput.on("keypress", (key) => this.handleKey(key))
    this.attachMpvEvents()
    this.updatePlaylist()
    this.updateNowPlaying()
  }

  // =========================================================
  //  构建
  // =========================================================

  private build() {
    const r = this.renderer
    const th = this.theme
    const root = new BoxRenderable(r, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: th.base,
    })
    this.root = root
    this.header = buildHeader(r, th)
    root.add(this.header.box)

    const main = new BoxRenderable(r, { flexDirection: "row", flexGrow: 1, flexBasis: 0 })
    this.main = main
    root.add(main)

    // ── 侧栏: 正在播放 / 歌词 / 接下来 ──
    const sidebar = new BoxRenderable(r, { flexDirection: "column", width: SIDEBAR_W })
    this.sidebar = sidebar
    main.add(sidebar)

    this.now = buildPlayer(r, th)
    sidebar.add(this.now.box)

    this.lyrics = buildLyrics(r, th)
    sidebar.add(this.lyrics.box)

    const upBox = panel(r, th, {
      title: " 接下来 ",
      titleColor: th.overlay,
      borderColor: th.surface0,
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 4,
      marginTop: 1,
    })
    const upRows: TextRenderable[] = []
    for (let i = 0; i < 12; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1, paddingLeft: 1 })
      upBox.add(row)
      upRows.push(row)
    }
    this.upcoming = { box: upBox, rows: upRows }
    sidebar.add(upBox)

    // ── 主区: 标签 + 列表 ──
    const rightCol = new BoxRenderable(r, { flexDirection: "column", flexGrow: 1, flexBasis: 0 })
    this.rightCol = rightCol
    main.add(rightCol)

    this.tabs = buildTabs(r, th, TAB_LABELS.map((l, i) => `${TAB_ICONS[i]} ${l}`), (i) => this.setView(TAB_KEYS[i]))
    rightCol.add(this.tabs.bar)
    rightCol.add(this.tabs.indicatorBox)
    this.tabState = {
      level: TAB_LABELS.map(() => 0),
      target: TAB_LABELS.map((_, i) => (i === TAB_KEYS.indexOf(this.view) ? 1 : 0)),
      pos: TAB_KEYS.indexOf(this.view),
    }

    this.list = buildList(r, th)
    rightCol.add(this.list.box)

    // ── 状态栏 ──
    this.status = buildStatus(r, th)
    root.add(this.status.box)

    this.searchInput = new InputRenderable(r, {
      flexGrow: 1,
      placeholder: "搜索歌名… Enter 确认 · Esc 取消",
      backgroundColor: th.surface0,
      focusedBackgroundColor: th.surface1,
      textColor: th.text,
      cursorColor: th.sky,
      visible: false,
    })
    this.status.box.add(this.searchInput)
    this.searchInput.on(InputRenderableEvents.ENTER, (v: string) => this.doSearch(v))
    this.searchInput.on(InputRenderableEvents.CHANGE, (v: string) => {
      this.searchQuery = v
    })

    r.root.add(root)

    // ── 覆盖层 ──
    this.buildOverlays()
    this.attachMouse()
    this.applyViewLayout(true)
    this.applyTabBar()
    this.updateHeader()
  }

  private buildOverlays() {
    const r = this.renderer
    const th = this.theme

    // 帮助
    this.help = buildOverlay(r, th, {
      title: `帮助 · 蓝汐音乐 ${VERSION}`,
      color: th.sky,
      width: Math.min(92, Math.max(60, (r.width || 92) - 4)),
      height: Math.max(16, Math.min(30, (r.height || 30) - 2)),
      zIndex: 400,
    })
    const helpCols = new BoxRenderable(r, { flexDirection: "row", gap: 3, flexGrow: 1 })
    this.help.body.add(helpCols)
    const sections: Array<{ icon: string; title: string; items: Array<[string, string]> }> = [
      { icon: "♪", title: "播放", items: [
        ["空格 / Enter", "播放 · 暂停 · 播放选中"],
        ["n / p", "下一首 / 上一首"],
        ["← / →", "快退 / 快进 5 秒"],
        ["[ / ]", "快退 / 快进 10 秒"],
        ["+ / -", "音量 ±5 (自动保存)"],
        ["M / 0", "静音切换"],
      ]},
      { icon: "≡", title: "队列与模式", items: [
        ["s", "随机播放开关"],
        ["m", "循环模式 (OFF/ALL/ONE)"],
        ["w", "选中曲下一首播放"],
        ["e", "选中曲加入队列末尾"],
        ["5", "队列视图"],
        ["z", "睡眠定时"],
      ]},
      { icon: "♥", title: "收藏与歌单", items: [
        ["f", "收藏 / 取消收藏当前曲"],
        ["1 / 2 / 3", "列表 / 收藏 / 歌单"],
        ["P", "进入歌单视图"],
        ["n / r / d", "新建 / 重命名 / 删除歌单"],
        ["Enter / a / x", "进入歌单 / 加歌 / 移除"],
      ]},
      { icon: "✎", title: "歌曲文件", items: [
        ["i", "歌曲信息"],
        ["R", "重命名文件 (含 .lrc)"],
        ["D", "删除文件 (需确认)"],
        ["o", "排序菜单"],
        ["S", "音乐库统计"],
        ["d", "重新扫描目录"],
      ]},
      { icon: "⌕", title: "搜索与歌词", items: [
        ["/", "搜索 (中文, Enter 确认)"],
        ["l / L", "歌词开关 / 全屏歌词"],
        [", / ;", "歌词延迟 ∓0.25s"],
        ["4", "设置 (主题/音量/倍速…)"],
        ["g / G", "跳到列表首 / 尾"],
        ["q / Esc", "退出 / 逐级返回"],
      ]},
    ]
    // 两列排布: 前 3 组左列, 后 2 组右列
    const leftCol = new BoxRenderable(r, { flexDirection: "column", width: 41, gap: 0 })
    const rightCol = new BoxRenderable(r, { flexDirection: "column", flexGrow: 1, gap: 0 })
    helpCols.add(leftCol)
    helpCols.add(rightCol)
    sections.forEach((sec, si) => {
      const target = si < 3 ? leftCol : rightCol
      target.add(
        new TextRenderable(r, {
          content: t`${bold(fg(th.lavender)(`${sec.icon}  ${sec.title}`))}`,
          selectable: false,
          paddingTop: si === 0 ? 0 : 1,
        }),
      )
      for (const [k, v] of sec.items) {
        const pad = Math.max(1, 16 - displayWidth(k))
        target.add(
          new TextRenderable(r, {
            content: t`${bold(fg(th.sky)(`  ${k}`))}${" ".repeat(pad)}${fg(th.text)(v)}`,
            selectable: false,
            wrapMode: "none",
          }),
        )
      }
    })
    this.help.body.add(
      new TextRenderable(r, {
        content: t`${fg(th.surface1)("─".repeat(84))}`,
        selectable: false,
        paddingTop: 1,
      }),
    )
    this.help.body.add(
      new TextRenderable(r, {
        content: t`${fg(th.overlay)(" 提示: 鼠标可点击标签与列表行 · 滚轮滚动列表 · 按任意键关闭")}`,
        selectable: false,
      }),
    )

    // 歌曲信息
    this.info = buildOverlay(r, th, { title: "歌曲信息", color: th.lavender, width: 72, zIndex: 350, paddingBottom: 1 })
    for (let i = 0; i < 9; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1 })
      this.info.body.add(row)
    }
    this.info.body.add(new TextRenderable(r, { content: t`${fg(th.overlay)(" 按任意键关闭")}`, selectable: false, paddingTop: 1 }))

    // 排序
    this.sort = buildOverlay(r, th, { title: "列表排序", color: th.lavender, width: 56, zIndex: 360 })
    for (let i = 0; i < SORT_MODES.length + 1; i++) {
      this.sort.body.add(new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1 }))
    }
    this.sort.body.add(
      new TextRenderable(r, {
        content: t`${fg(th.overlay)(" ↑↓ 选择 · ←/→ 升降序 · Enter 应用 · Esc 取消")}`,
        selectable: false,
        wrapMode: "none",
        height: 1,
        paddingTop: 1,
      }),
    )

    // 统计
    this.stats = buildOverlay(r, th, {
      title: "音乐库统计",
      color: th.sky,
      width: Math.min(80, Math.max(56, (r.width || 80) - 10)),
      zIndex: 350,
    })
    for (let i = 0; i < 20; i++) {
      this.stats.body.add(new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1 }))
    }
    this.stats.body.add(new TextRenderable(r, { content: t`${fg(th.overlay)(" 按任意键关闭")}`, selectable: false, wrapMode: "none", height: 1, paddingTop: 1 }))

    // 目录管理
    this.dirs = buildOverlay(r, th, { title: "音乐目录", color: th.green, width: 76, zIndex: 360 })
    for (let i = 0; i < 9; i++) {
      this.dirs.body.add(new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1 }))
    }
    this.dirs.body.add(new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1, paddingTop: 1 }))

    // 输入弹层 (歌单命名 / 重命名 / 添加目录)
    this.dialog = buildOverlay(r, th, { title: "输入", color: th.sky, width: 64, zIndex: 420 })
    const dialogInput = new InputRenderable(r, {
      width: 56,
      placeholder: "输入…",
      backgroundColor: th.surface0,
      focusedBackgroundColor: th.surface1,
      textColor: th.text,
      cursorColor: th.pink,
    })
    this.dialog.body.add(dialogInput)
    const dialogHint = new TextRenderable(r, { content: "", fg: th.overlay, selectable: false, paddingTop: 1, wrapMode: "none" })
    this.dialog.body.add(dialogHint)
    this.dialogInput = dialogInput
    this.dialogHint = dialogHint
    dialogInput.on(InputRenderableEvents.ENTER, (v: string) => this.commitDialog(v))
    dialogInput.on(InputRenderableEvents.CHANGE, (v: string) => {
      this.plDialogValue = v
    })

    // 确认
    this.confirm = buildOverlay(r, th, { title: "确认", color: th.red, width: 66, zIndex: 430 })
    this.confirmText = new TextRenderable(r, { content: "", fg: th.text, selectable: false, wrapMode: "none" })
    this.confirm.body.add(this.confirmText)
    this.confirm.body.add(
      new TextRenderable(r, {
        content: t`${bold(fg(th.red)(" Enter / y 确认 "))}${fg(th.overlay)("  ·  ")}${fg(th.subtext)("Esc / n 取消")}`,
        selectable: false,
        paddingTop: 1,
      }),
    )

    // 全屏歌词 (不遮罩, 直接整屏)
    this.full = buildOverlay(r, th, { title: `全屏歌词 · 蓝汐音乐 ${VERSION}`, color: th.lavender, width: "100%", height: "100%", zIndex: 500 })
    this.full.scrim.visible = false
    this.full.card.visible = false
    this.full.card.width = "100%"
    this.full.card.height = "100%"
    this.full.card.border = false
    this.full.card.paddingLeft = 3
    this.full.card.paddingRight = 3
    this.full.body.flexGrow = 1
    this.fullTitle = new TextRenderable(r, { content: "", fg: th.text, selectable: false, wrapMode: "none" })
    this.full.body.add(this.fullTitle)
    this.fullProgress = new TextRenderable(r, { content: "", fg: th.lavender, selectable: false, wrapMode: "none" })
    this.full.body.add(this.fullProgress)
    const lyricArea = new BoxRenderable(r, {
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
    })
    this.full.body.add(lyricArea)
    this.fullLyricRows = []
    for (let i = 0; i < 9; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1, width: "100%", textAlign: "center" })
      lyricArea.add(row)
      this.fullLyricRows.push(row)
    }
    this.full.body.add(
      new TextRenderable(r, {
        content: t`${fg(th.overlay)(" L / Esc 退出 · 空格 暂停 · n / p 切歌 ")}`,
        selectable: false,
      }),
    )

    // 挂到根: 顺序决定 zIndex 相同时的绘制先后 (zIndex 已显式指定)
    for (const o of [this.info, this.stats, this.sort, this.dirs, this.help, this.dialog, this.confirm, this.full]) {
      this.root.add(o.scrim)
    }
  }

  private dialogInput!: InputRenderable
  private dialogHint!: TextRenderable
  private confirmText!: TextRenderable
  // =========================================================
  //  响应式布局
  // =========================================================

  /** 宽终端 (≥100 列) 左右分栏; 窄终端单列堆叠 */
  private applyViewLayout(force = false) {
    const w = this.renderer.width || 80
    const wide = w >= WIDE_COLS
    if (!force && wide === this.lastWide) return
    this.lastWide = wide
    this.wide = wide
    if (wide) {
      this.sidebar.visible = true
      this.sidebar.width = Math.max(34, Math.min(SIDEBAR_W, Math.floor(w * 0.36)))
      this.main.flexDirection = "row"
      this.lyrics.box.height = 7
      this.upcoming.box.visible = true
    } else {
      // 窄屏: 侧栏收起, 仅保留正在播放卡片 (歌词/接下来隐藏)
      this.sidebar.visible = true
      this.sidebar.width = "100%"
      this.main.flexDirection = "column"
      this.lyrics.box.visible = false
      this.upcoming.box.visible = false
    }
    this.lastTabsWidth = -1
    this.updatePlaylist()
  }

  // =========================================================
  //  事件
  // =========================================================

  private attachMouse() {
    // 进度条点击/拖动定位: 挂在整个播放卡片上, 按行判断
    this.now.box.onMouseDown = (ev: MouseEvent) => this.seekFromMouse(ev)
    this.now.box.onMouseDrag = (ev: MouseEvent) => this.seekFromMouse(ev)
    // 滚轮滚动列表
    this.list.scroll.onMouseScroll = (ev: MouseEvent) => {
      const dir = ev.scroll?.direction
      if (dir === "up") this.moveSel(-1)
      else if (dir === "down") this.moveSel(1)
    }
  }

  private attachMpvEvents() {
    const p = this.p
    p.mpv.observeProperty(1, "time-pos")
    p.mpv.observeProperty(2, "duration")
    p.mpv.observeProperty(3, "pause")
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
          p.noteDuration(p.currentPath, data)
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
  //  按键
  // =========================================================

  private handleKey(key: KeyEvent): void {
    const p = this.p
    const name = key.name
    const seq = key.sequence

    // 模态层优先: 帮助/信息/统计 任意键关闭
    if (this.showHelp) {
      this.showHelp = false
      this.help.scrim.visible = false
      this.help.card.visible = false
      key.preventDefault()
      return
    }
    if (this.showInfo) {
      this.closeInfo()
      key.preventDefault()
      return
    }
    if (this.showStats) {
      this.closeStats()
      key.preventDefault()
      return
    }
    if (this.showSort) {
      if (name === "up" || seq === "k") this.sortCursor = (this.sortCursor - 1 + SORT_MODES.length) % SORT_MODES.length
      else if (name === "down" || seq === "j") this.sortCursor = (this.sortCursor + 1) % SORT_MODES.length
      else if (name === "left" || name === "right") p.sortAsc = !p.sortAsc
      else if (name === "return" || name === "enter") this.applySortMenu()
      else if (name === "escape" || seq === "q") this.closeSort()
      this.updateSortMenu()
      key.preventDefault()
      return
    }
    if (this.showDirManager) {
      const n = this.dirList().length
      if (name === "up" || seq === "k") this.dirCursor = Math.max(0, this.dirCursor - 1)
      else if (name === "down" || seq === "j") this.dirCursor = Math.min(Math.max(0, n - 1), this.dirCursor + 1)
      else if (name === "return" || name === "enter") this.dirSetPrimary()
      else if (seq === "a") this.openDialog("add-dir")
      else if (seq === "d" || name === "delete") this.dirRemove()
      else if (name === "escape" || seq === "q") this.closeDirManager()
      if (this.showDirManager) this.updateDirManager()
      key.preventDefault()
      return
    }
    if (this.confirmAction) {
      if (name === "return" || name === "enter" || seq === "y" || seq === "Y") {
        const act = this.confirmAction
        this.closeConfirm()
        act()
      } else if (name === "escape" || seq === "n" || seq === "N") {
        this.closeConfirm()
        this.flash("已取消")
      }
      key.preventDefault()
      return
    }
    if (this.plDialogMode) {
      if (name === "escape") {
        this.closeDialog()
        key.preventDefault()
      }
      return
    }
    if (this.fullLyrics) {
      if (name === "escape" || seq === "q" || seq === "Q" || seq === "l" || seq === "L") this.setFullLyrics(false)
      else if (name === "space") p.togglePause(this)
      else if (seq === "n") p.advance(1).then(() => this.afterTrackChange())
      else if (seq === "p") p.advance(-1).then(() => this.afterTrackChange())
      key.preventDefault()
      return
    }
    if (this.searchMode) {
      if (name === "escape") {
        this.exitSearch(true)
        key.preventDefault()
      }
      return
    }

    // ── 通用导航 ──
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
    if (name === "pageup") {
      this.moveSel(-10)
      key.preventDefault()
      return
    }
    if (name === "pagedown") {
      this.moveSel(10)
      key.preventDefault()
      return
    }
    if (seq === "g") {
      this.sel = 0
      this.updatePlaylist()
      key.preventDefault()
      return
    }
    if (seq === "G") {
      this.sel = Math.max(0, this.listCount() - 1)
      this.updatePlaylist()
      key.preventDefault()
      return
    }

    // ── 设置视图 ──
    if (this.view === "settings") {
      if (name === "escape") {
        this.setView("list")
        key.preventDefault()
        return
      }
      if (name === "left" || name === "right") {
        this.settingAdjust(name === "left" ? -1 : 1)
        key.preventDefault()
        return
      }
      if (name === "return" || name === "enter") {
        this.settingEnter()
        key.preventDefault()
        return
      }
    }

    // ── 歌单视图 ──
    if (this.view === "pl") {
      if (name === "escape") {
        if (this.plPickerMode) this.plPickerExit()
        else if (this.plLevel === "detail") this.closePlDetail()
        else this.setView("list")
        key.preventDefault()
        return
      }
      if (this.plPickerMode) {
        if (name === "return" || name === "enter") {
          this.plPickerAdd()
          key.preventDefault()
          return
        }
      } else {
        if (name === "return" || name === "enter") {
          this.plEnter()
          key.preventDefault()
          return
        }
        if (seq === "n") {
          this.openDialog("new")
          key.preventDefault()
          return
        }
        if (seq === "r" && this.plLevel === "list") {
          const cur = p.playlists[this.sel]
          if (cur) this.openDialog("rename", cur.name)
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
      }
    }

    // ── 队列视图 ──
    if (this.view === "queue") {
      if (name === "escape") {
        this.setView("list")
        key.preventDefault()
        return
      }
      if (name === "return" || name === "enter") {
        this.queuePlaySel()
        key.preventDefault()
        return
      }
      if (seq === "x" || name === "delete") {
        this.queueRemoveSel()
        key.preventDefault()
        return
      }
      if (seq === "J") {
        this.queueMoveSel(1)
        key.preventDefault()
        return
      }
      if (seq === "K") {
        this.queueMoveSel(-1)
        key.preventDefault()
        return
      }
      if (seq === "c") {
        this.queueClearAll()
        key.preventDefault()
        return
      }
    }

    // ── 全局 ──
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
        } else p.togglePause(this)
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
      case seq === ",":
        p.setLyricDelay(p.lyricDelay - 0.25)
        saveConfig({ lyric_delay: p.lyricDelay })
        this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s`)
        break
      case seq === ";":
        p.setLyricDelay(p.lyricDelay + 0.25)
        saveConfig({ lyric_delay: p.lyricDelay })
        this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s`)
        break
      case seq === "o":
        this.openSort()
        key.preventDefault()
        break
      case seq === "S":
        this.openStats()
        key.preventDefault()
        break
      case seq === "w":
        this.queueNextSelected()
        break
      case seq === "e":
        this.queueAppendSelected()
        break
      case seq === "s":
        this.toggleShuffleInView()
        break
      case seq === "m":
        p.cycleRepeat()
        this.flash("循环: " + REPEAT_LABEL[p.repeat])
        break
      case seq === "z":
        p.cycleSleep()
        this.flashSleep()
        break
      case seq === "l":
        p.showLyrics = !p.showLyrics
        this.flash(`歌词显示: ${p.showLyrics ? "开" : "关"}`)
        break
      case seq === "i":
        this.openInfo()
        break
      case seq === "L":
        this.setFullLyrics(true)
        break
      case seq === "f":
        this.favCurrent()
        break
      case seq === "R":
        this.renameSelectedSong()
        key.preventDefault()
        break
      case seq === "D":
        this.deleteSelectedSong()
        key.preventDefault()
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
      case seq === "5":
        this.setView("queue")
        key.preventDefault()
        break
      case seq === "P":
        this.setView("pl")
        key.preventDefault()
        break
      case seq === "h":
        this.openHelp()
        key.preventDefault()
        break
      case seq === "+" || seq === "=":
        p.setVolume(p.volume + 5)
        saveConfig({ volume: p.volume })
        this.flash(`音量 ${p.volume}`)
        this.updateNowPlaying()
        break
      case seq === "-" || seq === "_":
        p.setVolume(p.volume - 5)
        saveConfig({ volume: p.volume })
        this.flash(`音量 ${p.volume}`)
        this.updateNowPlaying()
        break
      case seq === "d":
        this.refreshDir()
        break
      case seq === "M" || seq === "0":
        p.toggleMute().then(() => {
          this.flash(p.muted ? "已静音" : `音量 ${p.volume}`)
          this.updateNowPlaying()
        })
        break
      case seq === "q" || seq === "Q" || name === "escape":
        if (name === "escape" && this.searchActive) this.exitSearch(true)
        else if (name === "escape" && this.view !== "list") this.setView("list")
        else this.quit()
        break
    }
  }

  // =========================================================
  //  视图
  // =========================================================

  setView(v: ViewName) {
    if (this.view === v) {
      if (v === "pl" && this.plLevel === "detail") this.closePlDetail()
      return
    }
    const p = this.p
    this.savedSel[this.view] = this.sel
    if (this.view === "pl") {
      this.plPickerMode = false
      this.plLevel = "list"
      this.plCurrent = null
    }
    if (v === "fav") {
      this.syncFavQueue()
      this.sel = Math.max(0, Math.min(p.queue.length - 1, this.savedSel.fav))
    } else {
      if (p.favMode) p.toggleFavMode()
      if (v === "pl") {
        this.plLevel = "list"
        this.sel = Math.min(this.savedSel.pl, Math.max(0, p.playlists.length - 1))
      } else if (v === "settings") {
        this.sel = Math.min(this.savedSel.settings, SETTING_ROW_COUNT - 1)
      } else if (v === "queue") {
        this.sel = Math.min(this.savedSel.queue, Math.max(0, p.queue.length - 1))
      } else {
        this.sel = Math.min(this.savedSel.list, Math.max(0, p.playlist.length - 1))
      }
    }
    this.view = v
    this.searchActive = false
    this.searchQuery = ""
    this.viewAnimT = this.animTimer ? 0 : 1
    this.tabState.target = TAB_LABELS.map((_, i) => (i === TAB_KEYS.indexOf(v) ? 1 : 0))
    if (!this.animTimer) this.tabState.level = this.tabState.target.slice()
    this.applyTabBar()
    this.applyViewLayout(true)
    this.updateHeader()
    this.updatePlaylist()
  }

  /**
   * 随机开关: 普通视图下行为不变; 收藏/搜索视图下保留过滤集合,
   * 只重排该集合 (否则 toggleShuffle 会把 queue 重置成整库, 列表突然变成全部歌曲)。
   */
  private toggleShuffleInView() {
    const p = this.p
    const filtered = this.searchActive || this.view === "fav" || p.favMode
    const paths = filtered ? p.queue.map((i) => p.playlist[i]).filter((x): x is string => !!x) : []
    const wasShuffle = p.isShuffle
    p.toggleShuffle()
    if (filtered) {
      const idx = paths.map((x) => p.playlist.indexOf(x)).filter((i) => i >= 0)
      if (wasShuffle) {
        p.queue = idx
      } else {
        // 刚开启随机: 当前曲置顶, 其余洗牌
        const rest = idx.filter((i) => i !== p.idx)
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[rest[i], rest[j]] = [rest[j], rest[i]]
        }
        p.queue = idx.includes(p.idx) ? [p.idx, ...rest] : rest
      }
      this.sel = Math.max(0, Math.min(this.sel, p.queue.length - 1))
      this.updatePlaylist()
    }
    this.flash(p.isShuffle ? "随机播放已开启" : "顺序播放已开启")
  }

  /** 按收藏列表重建 queue (收藏视图专用); 空收藏也能进入并显示空状态 */
  private syncFavQueue() {
    const p = this.p
    const idx = p.favorites.map((x) => p.playlist.indexOf(x)).filter((i) => i >= 0)
    p.favMode = true
    p.queue = idx
    this.sel = Math.max(0, Math.min(this.sel, idx.length - 1))
  }

  /** 标签栏: 激活项用主题色 + 底色胶囊, 其余 subtext */
  private applyTabBar() {
    const th = this.theme
    for (let i = 0; i < this.tabs.btns.length; i++) {
      const a = this.tabState.level[i] ?? 0
      const btn = this.tabs.btns[i]
      btn.backgroundColor = mixHex(th.mantle, th.surface1, a)
      const active = a > 0.5
      this.tabs.texts[i].content = active
        ? t`${bold(fg(th.sky)(`${TAB_ICONS[i]} ${TAB_LABELS[i]}`))}`
        : t`${fg(mixHex(th.overlay, th.subtext, a))(`${TAB_ICONS[i]} ${TAB_LABELS[i]}`)}`
    }
  }

  private stepTabAnim() {
    let moving = false
    for (let i = 0; i < this.tabState.level.length; i++) {
      const target = this.tabState.target[i] ?? 0
      const d = target - this.tabState.level[i]
      if (Math.abs(d) < 0.02) this.tabState.level[i] = target
      else {
        this.tabState.level[i] += d * 0.24
        moving = true
      }
    }
    if (moving) this.applyTabBar()
  }

  /** 指示条: 平滑滑动到激活标签下方, 渐变 */
  private updateTabIndicator() {
    const idx = TAB_KEYS.indexOf(this.view)
    this.tabState.pos += this.animTimer ? (idx - this.tabState.pos) * 0.26 : idx - this.tabState.pos
    if (Math.abs(this.tabState.pos - idx) < 0.01) this.tabState.pos = idx
    const i0 = Math.max(0, Math.min(this.tabs.btns.length - 1, Math.floor(this.tabState.pos)))
    const i1 = Math.min(this.tabs.btns.length - 1, i0 + 1)
    const f = this.tabState.pos - i0
    const a = this.tabs.btns[i0]
    const b = this.tabs.btns[i1] ?? a
    const ax = typeof a.screenX === "number" ? a.screenX : 0
    const aw = typeof a.width === "number" ? Math.max(1, a.width) : 10
    const bx = typeof b.screenX === "number" ? b.screenX : ax
    const bw = typeof b.width === "number" ? Math.max(1, b.width) : aw
    const x = ax + (bx - ax) * f
    const w = Math.max(1, Math.round(aw + (bw - aw) * f))
    const boxX = typeof this.tabs.indicatorBox.screenX === "number" ? this.tabs.indicatorBox.screenX : 0
    this.tabs.indicator.left = Math.max(0, Math.round(x - boxX))
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink]
    const flow = (Date.now() / 1000) * 0.18
    const parts: TextChunk[] = []
    for (let i = 0; i < w; i++) {
      let col = paletteAt(pal, (i / Math.max(1, w - 1)) * 0.8 + flow)
      const edge = Math.min(i, w - 1 - i) / Math.max(1, (w - 1) * 0.25)
      if (edge < 1) col = mixHex(this.theme.mantle, col, edge)
      parts.push(fg(col)("▁"))
    }
    this.tabs.indicator.content = new StyledText(parts)
  }

  // =========================================================
  //  提示
  // =========================================================

  flash(text: string, seconds = 1.8) {
    this.msg = text
    this.msgUntil = Date.now() + seconds * 1000
    this.updateStatus()
    const color = /失败|错误|取消|删除/.test(text)
      ? this.theme.red
      : /收藏|已添加|已创建|已加入|已保存/.test(text)
        ? this.theme.green
        : /队列|排序|插队/.test(text)
          ? this.theme.lavender
          : this.theme.sky
    this.pushToast(text, color)
  }

  private flashSleep() {
    const m = this.p.sleepMinutes
    this.flash(m === 0 ? "睡眠定时已关闭" : `睡眠定时: ${m} 分钟后渐弱暂停`, 2.2)
    this.updateStatus()
    if (this.view === "settings") this.updatePlaylist()
  }

  private openHelp() {
    this.showHelp = true
    this.help.scrim.visible = true
    this.help.card.visible = true
  }

  // =========================================================
  //  列表导航
  // =========================================================

  private listCount(): number {
    const p = this.p
    if (this.view === "settings") return SETTING_ROW_COUNT
    if (this.view === "queue") return p.queue.length
    if (this.view === "pl") {
      if (this.plLevel === "list") return p.playlists.length
      if (this.plPickerMode) return p.playlist.length
      return this.plCurrent ? p.playlistPaths(this.plCurrent).length : 0
    }
    if (this.searchActive || this.view === "fav" || p.favMode) return p.queue.length
    return p.playlist.length
  }

  moveSel(delta: number) {
    const n = this.listCount()
    if (!n) return
    this.sel = Math.max(0, Math.min(n - 1, this.sel + delta))
    this.updatePlaylist()
  }

  /** 当前视图选中行的真实 playlist 下标 (统一入口, 避免各视图各算一遍) */
  private selectedIndex(): number | null {
    const p = this.p
    if (this.view === "settings") return null
    if (this.view === "queue") {
      const i = p.queue[this.sel]
      return i === undefined ? null : i
    }
    if (this.view === "pl") {
      if (this.plLevel === "list") return null
      if (this.plPickerMode) return this.sel < p.playlist.length ? this.sel : null
      const paths = this.plCurrent ? p.playlistPaths(this.plCurrent) : []
      const path = paths[this.sel]
      if (!path) return null
      const i = p.playlist.indexOf(path)
      return i >= 0 ? i : null
    }
    if (this.searchActive || this.view === "fav" || p.favMode) {
      const i = p.queue[this.sel]
      return i === undefined ? null : i
    }
    return this.sel < p.playlist.length ? this.sel : null
  }

  private selectedPath(): string | null {
    const i = this.selectedIndex()
    return i === null ? null : this.p.playlist[i] ?? null
  }

  playSel() {
    const p = this.p
    if (!p.mpvReady) {
      this.flash("mpv 还在启动, 稍等一下…")
      return
    }
    if (this.view === "pl") {
      this.plEnter()
      return
    }
    if (this.view === "settings") {
      this.settingEnter()
      return
    }
    if (this.view === "queue") {
      this.queuePlaySel()
      return
    }
    if (!p.playlist.length) return
    const real = this.selectedIndex()
    if (real === null) return
    p.playIndex(real).then(() => {
      this.afterTrackChange()
      this.syncSelToPlaying()
      this.updatePlaylist()
    })
  }

  playIndex(realIdx: number) {
    if (!this.p.mpvReady) {
      this.flash("mpv 还在启动, 稍等一下…")
      return
    }
    this.p.playIndex(realIdx).then(() => {
      this.afterTrackChange()
      this.syncSelToPlaying()
      this.updatePlaylist()
    })
  }

  /** 让选中行跟随当前播放曲 (仅当该曲确实在当前视图里) */
  private syncSelToPlaying() {
    const p = this.p
    if (this.view === "list" && !this.searchActive && !p.favMode) {
      this.sel = p.idx
      return
    }
    if (this.view === "fav" || this.searchActive) {
      const at = p.queue.indexOf(p.idx)
      if (at >= 0) this.sel = at
      return
    }
    if (this.view === "queue") {
      const at = p.queue.indexOf(p.idx)
      if (at >= 0) this.sel = at
    }
  }

  afterTrackChange() {
    this.refreshSpectrumSeed()
    this.updateNowPlaying()
    this.updatePlaylist()
    this.updateStatus()
  }

  seek(sec: number) {
    this.p.seek(sec)
    this.flash(sec > 0 ? `快进 ${sec} 秒` : `快退 ${-sec} 秒`)
  }

  private seekFromMouse(ev: MouseEvent) {
    const p = this.p
    if (!p.playing || p.duration <= 0) return
    const bar = this.now.bar
    const barX = typeof bar.screenX === "number" ? bar.screenX : 0
    const barY = typeof bar.screenY === "number" ? bar.screenY : 0
    const barW = typeof bar.width === "number" ? bar.width : 0
    if (barW <= 0) return
    // 只有点在进度条那一行才定位, 避免点标题也跳
    if (ev.y !== barY) return
    const local = Math.max(0, Math.min(barW, ev.x - barX))
    p.seekTo((local / barW) * p.duration)
    this.flash(`跳转到 ${fmt((local / barW) * p.duration)}`)
  }

  favCurrent() {
    const p = this.p
    const real = this.selectedIndex()
    if (real === null) {
      this.flash("这里没有可收藏的歌曲")
      return
    }
    const added = p.toggleFavorite(real)
    this.flash(`${added ? "♥ 已收藏" : "已取消收藏"}: ${titleOf(p.playlist[real])}`)
    // 收藏视图内增删收藏要立即反映到列表, 否则会留下已取消的幽灵行
    if (this.view === "fav" || p.favMode) this.syncFavQueue()
    this.updatePlaylist()
  }

  // =========================================================
  //  歌曲文件操作
  // =========================================================

  private renameSelectedSong() {
    const path = this.selectedPath()
    if (!path) {
      this.flash("这里没有可重命名的歌曲")
      return
    }
    this.pendingSongPath = path
    this.openDialog("rename-song", titleOf(path))
  }

  private deleteSelectedSong() {
    const path = this.selectedPath()
    if (!path) {
      this.flash("这里没有可删除的歌曲")
      return
    }
    const label = titleOf(path)
    this.askConfirm(`删除「${label}」? 会删除磁盘文件 (含同名歌词)`, () => {
      const r = this.p.deleteTrack(path)
      if (!r.ok) {
        this.flash(`删除失败 (${r.error})`)
        return
      }
      this.sel = Math.max(0, Math.min(Math.max(0, this.listCount() - 1), this.sel))
      this.flash(`已删除: ${label}`, 2)
      this.afterTrackChange()
    })
  }

  private askConfirm(message: string, action: () => void) {
    this.confirmMessage = message
    this.confirmAction = action
    this.confirmText.content = t`${fg(this.theme.text)(clipWidth(message, 58))}`
    this.confirm.scrim.visible = true
    this.confirm.card.visible = true
  }

  private closeConfirm() {
    this.confirmAction = null
    this.confirmMessage = ""
    this.confirm.scrim.visible = false
    this.confirm.card.visible = false
  }

  // =========================================================
  //  设置
  // =========================================================

  settingEnter() {
    if (this.sel === 0) this.cycleTheme()
    else if (this.sel === 3) this.flash("用 ←/→ 或 , ; 调整歌词延迟 (-5~5s)")
    else if (this.sel === 4) this.flashSleep()
    else if (this.sel === 5) this.openDirManager()
    else if (this.sel === 6) this.openSort()
    else if (this.sel === 7) {
      const n = clearCache()
      ensureCacheDir()
      this.p.saveState()
      this.flash(`已清空缓存 (${n} 项)`, 2.2)
      this.updatePlaylist()
    } else if (this.sel === 8) this.flash(`当前版本 ${VERSION}`)
    else if (this.sel === 2) this.flash("用 ←/→ 调整倍速 (0.25 步进)")
    else this.flash("用 ←/→ 或 +/- 调整音量")
  }

  settingAdjust(dir: number) {
    const p = this.p
    if (this.sel === 0) {
      const cur = THEME_ORDER.indexOf(this.themeName)
      const n = THEME_ORDER.length
      const next = THEME_ORDER[(((cur + dir) % n) + n) % n]
      this.applyTheme(next)
      saveConfig({ theme: next })
      this.flash(`主题: ${THEME_LABEL[next]}`, 2)
    } else if (this.sel === 1) {
      p.setVolume(p.volume + dir * 5)
      saveConfig({ volume: p.volume })
      this.flash(`音量 ${p.volume}`)
      this.updateNowPlaying()
      this.updatePlaylist()
    } else if (this.sel === 2) {
      p.setSpeed(p.speed + dir * 0.25).then(() => {
        saveConfig({ speed: p.speed })
        this.flash(`倍速 ${p.speed.toFixed(2)}x`)
        this.updatePlaylist()
      })
    } else if (this.sel === 3) {
      p.setLyricDelay(p.lyricDelay + dir * 0.25)
      saveConfig({ lyric_delay: p.lyricDelay })
      this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s`)
      this.updatePlaylist()
    } else if (this.sel === 4) {
      p.cycleSleep(dir)
      this.flashSleep()
    } else if (this.sel === 5) this.flash("Enter 管理音乐目录")
    else if (this.sel === 6) {
      const cur = SORT_MODES.indexOf(p.sortMode)
      const n = SORT_MODES.length
      const next = SORT_MODES[(((cur + dir) % n) + n) % n]
      p.setSort(next, p.sortAsc)
      saveConfig({ sort_mode: next, sort_asc: p.sortAsc })
      this.sel = Math.max(0, Math.min(this.listCount() - 1, this.sel))
      this.updatePlaylist()
      this.flash(`排序: ${SORT_LABEL[next]} ${p.sortAsc ? "↑" : "↓"}`)
    } else if (this.sel === 7) this.flash("Enter 清空缓存")
    else if (this.sel === 8) this.flash("版本号只读 · h 查看帮助")
  }

  applyMusicDirs(dirs: string[]): boolean {
    const p = this.p
    const clean: string[] = []
    for (const raw of dirs) {
      const abs = expandPath(raw)
      if (!abs || clean.includes(abs)) continue
      if (!existsSync(abs)) {
        this.flash(`目录不存在: ${abs}`)
        continue
      }
      clean.push(abs)
    }
    if (!clean.length) {
      this.flash("至少要保留一个有效目录")
      return false
    }
    saveMusicDirs(clean)
    p.musicDirs = clean
    p.musicDir = clean[0]
    p.refreshDir().then((n) => {
      this.sel = Math.max(0, Math.min(Math.max(0, this.listCount() - 1), p.idx))
      this.updatePlaylist()
      this.updateDirManager()
      this.flash(`音乐目录已更新 (${clean.length} 个, ${n} 首)`, 2.5)
    })
    return true
  }

  private dirList(): string[] {
    return this.p.scanRoots()
  }

  private openDirManager() {
    this.showDirManager = true
    this.dirCursor = 0
    this.dirs.scrim.visible = true
    this.dirs.card.visible = true
    this.updateDirManager()
  }

  private closeDirManager() {
    this.showDirManager = false
    this.dirs.scrim.visible = false
    this.dirs.card.visible = false
    this.updatePlaylist()
  }

  updateDirManager() {
    if (!this.dirs) return
    const dirs = this.dirList()
    if (this.dirCursor >= dirs.length) this.dirCursor = Math.max(0, dirs.length - 1)
    const rows = this.dirs.body.getChildren().filter((c): c is TextRenderable => c instanceof TextRenderable)
    for (let i = 0; i < 9 && i < rows.length; i++) {
      const d = dirs[i]
      rows[i].visible = !!d
      if (!d) {
        rows[i].content = ""
        continue
      }
      const isSel = i === this.dirCursor
      const primary = i === 0
      const label = ` ${primary ? "★ 主目录" : "  目录   "}  ${clipWidth(d, 54)}`
      rows[i].content = isSel
        ? t`${bold(fg(this.theme.green)(label))}`
        : t`${fg(primary ? this.theme.text : this.theme.subtext)(label)}`
      if (isSel) rows[i].fg = this.theme.green
    }
    const hint = rows[9]
    if (hint) hint.content = ` ${dirs.length} 个目录 · a 添加 · d 移除 · Enter 置顶 · Esc 关闭`
  }

  private dirSetPrimary() {
    const dirs = this.dirList()
    const d = dirs[this.dirCursor]
    if (!d) return
    if (this.dirCursor === 0) {
      this.flash("已经是主目录")
      return
    }
    this.dirCursor = 0
    if (this.applyMusicDirs([d, ...dirs.filter((x) => x !== d)])) this.flash(`★ 主目录: ${d}`, 2)
  }

  private dirRemove() {
    const dirs = this.dirList()
    if (dirs.length <= 1) {
      this.flash("至少要保留一个目录")
      return
    }
    const d = dirs[this.dirCursor]
    if (!d) return
    this.askConfirm(`从音乐目录移除「${clipWidth(d, 46)}」? (不删磁盘文件)`, () => {
      const next = dirs.filter((x) => x !== d)
      if (this.applyMusicDirs(next)) {
        this.dirCursor = Math.max(0, Math.min(next.length - 1, this.dirCursor))
        this.dirs.scrim.visible = true
        this.dirs.card.visible = true
        this.updateDirManager()
        this.flash(`已移除目录: ${d}`, 2)
      }
    })
  }

  // =========================================================
  //  搜索
  // =========================================================

  enterSearch() {
    const p = this.p
    this.preSearch = { queue: [...p.queue], favMode: p.favMode, sel: this.sel, idx: p.idx }
    this.searchMode = true
    this.searchQuery = ""
    this.searchInput.value = ""
    this.searchInput.visible = true
    this.status.left.visible = false
    this.status.right.visible = false
    this.searchInput.focus()
  }

  doSearch(query: string) {
    const p = this.p
    this.searchMode = false
    this.searchInput.visible = false
    this.status.left.visible = true
    this.status.right.visible = true
    const q = query.trim().toLowerCase()
    if (!q) {
      this.exitSearch(true)
      return
    }
    const pool = this.view === "fav" || p.favMode ? p.favorites : p.playlist
    const results = pool
      .map((path) => p.playlist.indexOf(path))
      .filter((i) => i >= 0 && titleOf(p.playlist[i]).toLowerCase().includes(q))
    p.queue = results
    this.sel = 0
    this.searchActive = true
    this.searchQuery = query
    this.flash(results.length ? `搜索到 ${results.length} 首: ${query}` : `没有找到 '${query}'`)
    this.updatePlaylist()
    this.updateHeader()
  }

  exitSearch(restore: boolean) {
    const p = this.p
    this.searchMode = false
    this.searchInput.visible = false
    this.status.left.visible = true
    this.status.right.visible = true
    this.searchInput.blur()
    if (restore && this.preSearch) {
      const snap = this.preSearch
      p.queue = snap.queue
      p.favMode = snap.favMode
      p.idx = snap.idx
      this.sel = Math.max(0, Math.min(snap.sel, Math.max(0, this.listCount() - 1)))
      this.preSearch = null
      this.searchActive = false
      this.searchQuery = ""
      this.flash("已退出搜索")
      this.updatePlaylist()
      this.updateHeader()
    }
  }

  refreshDir() {
    this.flash("正在扫描…", 1)
    this.p.refreshDir().then((n) => {
      this.flash(`扫描完成 · 共 ${n} 首`)
      this.sel = Math.min(this.p.idx, Math.max(0, this.listCount() - 1))
      this.updatePlaylist()
    })
  }

  // =========================================================
  //  主题
  // =========================================================

  /**
   * 切换主题 = 整树重建。所有"打开中"的状态 (弹层/搜索/选中) 都要跨重建恢复,
   * 否则切主题会把正在输入的弹层弄丢。
   */
  applyTheme(name: ThemeName) {
    if (!(name in THEMES) || name === this.themeName) return
    const snap = {
      view: this.view,
      plLevel: this.plLevel,
      plCurrent: this.plCurrent,
      plPicker: this.plPickerMode,
      sel: this.sel,
      savedSel: { ...this.savedSel },
      searchMode: this.searchMode,
      searchActive: this.searchActive,
      searchQuery: this.searchQuery,
      preSearch: this.preSearch,
      fullLyrics: this.fullLyrics,
      showInfo: this.showInfo,
      showHelp: this.showHelp,
      showStats: this.showStats,
      showSort: this.showSort,
      sortCursor: this.sortCursor,
      showDir: this.showDirManager,
      dirCursor: this.dirCursor,
      dialogMode: this.plDialogMode,
      dialogValue: this.plDialogValue,
      pendingSong: this.pendingSongPath,
      confirmMsg: this.confirmMessage,
      confirmAct: this.confirmAction,
      msg: this.msg,
      msgUntil: this.msgUntil,
    }
    this.root.destroyRecursively()
    this.themeName = name
    this.theme = THEMES[name]
    this.plRows = []
    this.lyricRowCount = 0
    this.toasts = []
    this.toastSeq = 0
    this.toastBoxes = []
    this.playsTotal = -1
    this.lastPlTitle = ""
    this.lastTabsWidth = -1
    this.lastWide = !this.wide // 强制重算布局
    this.build()

    this.view = snap.view
    this.plLevel = snap.plLevel
    this.plCurrent = snap.plCurrent
    this.plPickerMode = snap.plPicker
    this.sel = snap.sel
    this.savedSel = snap.savedSel
    this.searchActive = snap.searchActive
    this.searchQuery = snap.searchQuery
    this.preSearch = snap.preSearch
    this.fullLyrics = snap.fullLyrics
    this.showInfo = snap.showInfo
    this.showHelp = snap.showHelp
    this.showStats = snap.showStats
    this.showSort = snap.showSort
    this.sortCursor = snap.sortCursor
    this.showDirManager = snap.showDir
    this.dirCursor = snap.dirCursor
    this.plDialogMode = snap.dialogMode
    this.plDialogValue = snap.dialogValue
    this.pendingSongPath = snap.pendingSong
    this.msg = snap.msg
    this.msgUntil = snap.msgUntil

    if (snap.searchMode) {
      this.searchMode = true
      this.searchInput.value = snap.searchQuery
      this.searchInput.visible = true
      this.status.left.visible = false
      this.status.right.visible = false
      this.searchInput.focus()
    }
    if (snap.showHelp) this.openHelp()
    if (snap.showInfo) this.openInfo()
    if (snap.showStats) this.openStats()
    if (snap.showSort) this.openSort()
    if (snap.showDir) {
      this.showDirManager = true
      this.dirs.scrim.visible = true
      this.dirs.card.visible = true
      this.updateDirManager()
    }
    if (snap.confirmAct) this.askConfirm(snap.confirmMsg, snap.confirmAct)
    if (snap.dialogMode) this.openDialog(snap.dialogMode, snap.dialogValue)
    if (snap.fullLyrics) this.setFullLyrics(true)
    this.tabState.target = TAB_LABELS.map((_, i) => (i === TAB_KEYS.indexOf(this.view) ? 1 : 0))
    this.tabState.level = this.tabState.target.slice()
    this.tabState.pos = TAB_KEYS.indexOf(this.view)
    this.applyTabBar()
    this.applyViewLayout(true)
    this.updateHeader()
    this.updatePlaylist()
    this.updateNowPlaying()
    this.updateStatus()
  }

  cycleTheme() {
    const cur = THEME_ORDER.indexOf(this.themeName)
    const next = THEME_ORDER[(cur + 1) % THEME_ORDER.length]
    this.applyTheme(next)
    saveConfig({ theme: next })
    this.flash(`主题: ${THEME_LABEL[next]}`, 2)
  }

  quit() {
    this.onQuit?.()
  }

  // =========================================================
  //  歌单
  // =========================================================

  openPlDetail(name: string) {
    this.plCurrent = name
    this.plLevel = "detail"
    this.sel = 0
    this.updatePlaylist()
  }

  closePlDetail() {
    this.plLevel = "list"
    this.plCurrent = null
    this.sel = Math.min(this.sel, Math.max(0, this.p.playlists.length - 1))
    this.updatePlaylist()
  }

  private openDialog(mode: "new" | "rename" | "rename-song" | "add-dir", preset = "") {
    this.plDialogMode = mode
    this.plDialogValue = preset
    this.dialogInput.value = preset
    this.dialogInput.width = mode === "add-dir" || mode === "rename-song" ? 56 : 40
    const title =
      mode === "new" ? "新建歌单" : mode === "rename" ? "重命名歌单" : mode === "rename-song" ? "重命名歌曲" : "添加音乐目录"
    this.dialog.card.title = ` ${title} `
    const ext = this.pendingSongPath ? extOf(this.pendingSongPath) : ""
    this.dialogHint.content =
      mode === "new"
        ? "输入歌单名 · Enter 确认 · Esc 取消"
        : mode === "rename"
          ? `原名: ${preset} · Enter 确认 · Esc 取消`
          : mode === "rename-song"
            ? `只输入歌名, 后缀 ${ext} 保留 · Enter 确认 · Esc 取消`
            : "输入绝对路径 (支持 ~) · Enter 添加 · Esc 取消"
    this.dialog.scrim.visible = true
    this.dialog.card.visible = true
    this.dialogInput.focus()
  }

  private closeDialog() {
    const wasDir = this.plDialogMode === "add-dir"
    this.plDialogMode = null
    this.plDialogValue = ""
    this.pendingSongPath = null
    this.dialogInput.value = ""
    this.dialogInput.blur()
    this.dialog.scrim.visible = false
    this.dialog.card.visible = false
    if (wasDir && this.showDirManager) {
      this.dirs.scrim.visible = true
      this.dirs.card.visible = true
      this.updateDirManager()
    }
  }

  private commitDialog(value: string) {
    const v = value.trim()
    const mode = this.plDialogMode
    if (mode === "add-dir") {
      this.closeDialog()
      if (!v) return
      if (this.applyMusicDirs([...this.dirList(), v])) {
        this.dirCursor = Math.max(0, this.dirList().length - 1)
        if (this.showDirManager) this.updateDirManager()
        this.flash(`已添加目录: ${v}`, 2)
      }
      return
    }
    if (mode === "rename-song") {
      const path = this.pendingSongPath
      this.closeDialog()
      if (!path || !v) {
        this.flash("歌名不能为空")
        return
      }
      const r = this.p.renameTrack(path, v)
      if (!r.ok) {
        this.flash(`重命名失败 (${r.error})`)
        return
      }
      this.flash(`已重命名: ${titleOf(r.newPath)}`, 2)
      this.afterTrackChange()
      return
    }
    if (!v) {
      this.closeDialog()
      this.flash("歌单名不能为空")
      return
    }
    if (mode === "new") {
      const idx = this.p.createPlaylist(v)
      if (idx < 0) {
        this.flash(`已存在同名歌单: ${v}`)
      } else {
        this.flash(`已创建歌单: ${v}`)
        this.sel = idx
      }
    } else if (mode === "rename") {
      const target = this.plCurrent ?? this.p.playlists[this.sel]?.name ?? ""
      if (!target || !this.p.renamePlaylist(target, v)) this.flash("重命名失败 (重名或为空)")
      else {
        if (this.plCurrent === target) this.plCurrent = v
        this.flash(`已重命名为: ${v}`)
      }
    }
    this.closeDialog()
    this.updatePlaylist()
  }

  private plEnter() {
    const p = this.p
    if (this.plLevel === "list") {
      const pl = p.playlists[this.sel]
      if (!pl) {
        this.flash("还没有歌单 · 按 n 新建")
        return
      }
      this.openPlDetail(pl.name)
      return
    }
    if (!this.plCurrent) return
    const paths = p.playlistPaths(this.plCurrent)
    const path = paths[this.sel]
    if (!path) return
    const real = p.playlist.indexOf(path)
    if (real === -1) {
      this.flash("歌曲不在当前音乐目录")
      return
    }
    p.queue = paths.map((x) => p.playlist.indexOf(x)).filter((i) => i >= 0)
    p.playIndex(real).then(() => {
      this.afterTrackChange()
      this.setView("list")
      this.sel = real
      this.updatePlaylist()
    })
  }

  private plDelete() {
    const p = this.p
    if (this.plLevel === "list") {
      const pl = p.playlists[this.sel]
      if (!pl) return
      // 删歌单是破坏性操作: 走确认弹层, 避免误按 d
      this.askConfirm(`删除歌单「${pl.name}」? (只删歌单, 不删歌曲文件)`, () => {
        if (!p.deletePlaylist(pl.name)) return
        this.flash(`已删除歌单: ${pl.name}`)
        this.sel = Math.max(0, Math.min(p.playlists.length - 1, this.sel))
        this.updatePlaylist()
      })
      return
    }
    if (!this.plCurrent) return
    const paths = p.playlistPaths(this.plCurrent)
    const path = paths[this.sel]
    if (!path) return
    if (!p.removeTrackFromPlaylist(this.plCurrent, this.sel)) return
    this.flash(`已从歌单移除: ${titleOf(path)}`)
    const n = p.playlistPaths(this.plCurrent).length
    this.sel = Math.max(0, Math.min(n - 1, this.sel))
    this.updatePlaylist()
  }

  private enterPlPicker() {
    if (!this.plCurrent) return
    this.plPickerMode = true
    this.sel = 0
    this.flash("选歌模式 · Enter 加入歌单 · Esc 取消")
    this.updatePlaylist()
  }

  private plPickerAdd() {
    if (!this.plPickerMode || !this.plCurrent) return
    const p = this.p
    const path = p.playlist[this.sel]
    if (!path) return
    const added = p.addTrackToPlaylist(this.plCurrent, path)
    this.flash(added ? `已加入: ${titleOf(path)}` : `已在歌单中: ${titleOf(path)}`)
    this.sel = Math.min(p.playlist.length - 1, this.sel + 1)
    this.updatePlaylist()
  }

  private plPickerExit() {
    this.plPickerMode = false
    this.sel = 0
    this.updatePlaylist()
  }

  // =========================================================
  //  信息 / 全屏歌词
  // =========================================================

  private openInfo() {
    const p = this.p
    const path = p.currentPath
    const dur = p.durationOf(path)
    const rows = this.info.body.getChildren().filter((c): c is TextRenderable => c instanceof TextRenderable)
    const lines: Array<[string, string]> = [
      ["歌名", p.currentTitle()],
      ["艺术家", p.currentArtist() || "—"],
      ["格式", `${extOf(path || "").replace(".", "").toUpperCase() || "—"}  ·  ${dur > 0 ? fmtDuration(dur) : "时长未知"}`],
      ["路径", clipWidth(path ?? "—", 60)],
      ["已播放", `${p.playCountOf(path)} 次`],
      ["位置", `第 ${p.idx + 1}/${p.playlist.length} 首${p.playing ? `  ·  ${fmt(p.duration)}` : ""}`],
      ["模式", `${REPEAT_LABEL[p.repeat]}${p.isShuffle ? " · 随机" : ""}`],
      ["音量", `${p.volume}${p.muted ? " (静音)" : ""}  ·  倍速 ${p.speed.toFixed(2)}x`],
      ["歌词延迟", `${p.lyricDelay > 0 ? "+" : ""}${p.lyricDelay.toFixed(2)}s`],
    ]
    for (let i = 0; i < rows.length && i < lines.length; i++) {
      const [k, v] = lines[i]
      rows[i].content = t`${fg(this.theme.overlay)(fitWidth(k, 10))}${fg(this.theme.text)(v)}`
    }
    this.showInfo = true
    this.info.scrim.visible = true
    this.info.card.visible = true
  }

  private closeInfo() {
    this.showInfo = false
    this.info.scrim.visible = false
    this.info.card.visible = false
  }

  setFullLyrics(on: boolean) {
    this.fullLyrics = on
    this.full.scrim.visible = on
    this.full.card.visible = on
    if (on) {
      this.updateFullLyrics()
      this.updateNowPlaying()
    }
  }

  // =========================================================
  //  队列
  // =========================================================

  private queueNextSelected() {
    const i = this.selectedIndex()
    if (i === null) {
      this.flash("这里没有可插队的歌曲")
      return
    }
    this.p.queueInsertNext(i)
    this.flash(`下一首播放: ${titleOf(this.p.playlist[i])}`, 2)
    this.updatePlaylist()
  }

  private queueAppendSelected() {
    const i = this.selectedIndex()
    if (i === null) {
      this.flash("这里没有可加队的歌曲")
      return
    }
    this.p.queueAppend(i)
    this.flash(`已加入队列: ${titleOf(this.p.playlist[i])}`, 2)
    this.updatePlaylist()
  }

  private queuePlaySel() {
    const p = this.p
    if (!p.mpvReady) {
      this.flash("mpv 还在启动, 稍等一下…")
      return
    }
    const real = p.queue[this.sel]
    if (real === undefined) return
    p.playIndex(real).then(() => {
      this.afterTrackChange()
      this.updatePlaylist()
    })
  }

  private queueRemoveSel() {
    const p = this.p
    const removed = p.queueRemoveAt(this.sel)
    if (removed === null) return
    this.flash(`已从队列移除: ${titleOf(p.playlist[removed] ?? "")}`)
    if (!p.queue.length && p.ensureQueue()) {
      this.sel = Math.max(0, p.queue.indexOf(p.idx))
      this.flash("队列已空 → 已恢复整库顺序", 2)
    } else {
      this.sel = Math.max(0, Math.min(p.queue.length - 1, this.sel))
    }
    this.updatePlaylist()
  }

  private queueMoveSel(delta: number) {
    this.sel = this.p.queueMove(this.sel, delta)
    this.updatePlaylist()
  }

  private queueClearAll() {
    const n = this.p.queueClear()
    this.sel = Math.max(0, this.p.queue.indexOf(this.p.idx))
    this.flash(`队列已清空 (剩 ${n} 首)`)
    this.updatePlaylist()
  }

  private openSort() {
    this.showSort = true
    this.sortCursor = Math.max(0, SORT_MODES.indexOf(this.p.sortMode))
    this.sort.scrim.visible = true
    this.sort.card.visible = true
    this.updateSortMenu()
  }

  private closeSort() {
    this.showSort = false
    this.sort.scrim.visible = false
    this.sort.card.visible = false
    this.updatePlaylist()
  }

  private applySortMenu() {
    const mode = SORT_MODES[this.sortCursor]
    this.p.setSort(mode, this.p.sortAsc)
    saveConfig({ sort_mode: mode, sort_asc: this.p.sortAsc })
    this.closeSort()
    this.flash(`排序: ${SORT_LABEL[mode]} ${this.p.sortAsc ? "↑" : "↓"}`, 2)
  }

  updateSortMenu() {
    if (!this.sort) return
    const rows = this.sort.body.getChildren().filter((c): c is TextRenderable => c instanceof TextRenderable)
    for (let i = 0; i < SORT_MODES.length; i++) {
      const mode = SORT_MODES[i]
      const sel = i === this.sortCursor
      const active = mode === this.p.sortMode
      const label = `${sel ? "▸" : " "} ${fitWidth(SORT_LABEL[mode], 18)}${active ? "✓" : " "}`
      rows[i].content = sel
        ? t`${bold(fg(this.theme.sky)(label))}`
        : t`${fg(active ? this.theme.green : this.theme.text)(label)}`
    }
    const dirRow = rows[SORT_MODES.length]
    if (dirRow) dirRow.content = t`${fg(this.theme.subtext)(`  方向: ${this.p.sortAsc ? "升序 ↑" : "降序 ↓"}  (←/→ 切换)`)}`
  }

  private openStats() {
    this.showStats = true
    this.stats.scrim.visible = true
    this.stats.card.visible = true
    this.updateStats()
  }

  private closeStats() {
    this.showStats = false
    this.stats.scrim.visible = false
    this.stats.card.visible = false
  }

  // =========================================================
  //  统计面板
  // =========================================================

  private statBar(value: number, max: number, width: number, pal: string[]): TextChunk[] {
    const w = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0
    const parts: TextChunk[] = []
    for (let i = 0; i < w; i++) parts.push(fg(paletteAt(pal, i / Math.max(1, w - 1) * 0.7))(LEVEL_BLOCKS[7]))
    return parts
  }

  updateStats() {
    if (!this.stats) return
    const s = computeStats(this.p)
    const rows = this.stats.body.getChildren().filter((c): c is TextRenderable => c instanceof TextRenderable)
    const th = this.theme
    const lines: Array<StyledText | null> = []
    lines.push(
      t`${fg(th.overlay)("曲目 ")}${bold(fg(th.sky)(String(s.tracks)))}${fg(th.overlay)("   ·   总时长 ")}${bold(fg(th.lavender)(fmtDuration(s.knownDurSec)))}${fg(th.overlay)(` (${s.knownDurCount} 首已探测)`)}${fg(th.overlay)("   ·   播放 ")}${bold(fg(th.pink)(String(s.totalPlays)))}${fg(th.overlay)(" 次")}`,
    )
    lines.push(
      t`${fg(th.yellow)("♥")}${fg(th.text)(` ${s.favorites} 收藏`)}${fg(th.overlay)("   ·   ")}${fg(th.green)("❏")}${fg(th.text)(` ${s.playlists} 歌单`)}${fg(th.overlay)("   ·   ")}${fg(th.sky)("⌂")}${fg(th.text)(` ${s.dirs} 目录`)}`,
    )
    lines.push(null)
    lines.push(t`${bold(fg(th.lavender)("格式分布"))}`)
    const fmtMax = Math.max(1, ...s.formats.map((x) => x.value))
    for (const f of s.formats) {
      lines.push(
        new StyledText([
          ...t`${fg(th.text)("  " + fitWidth(f.label, 6))}${fg(th.overlay)(String(f.value).padStart(3) + " ")}`.chunks,
          ...this.statBar(f.value, fmtMax, 26, [th.sky, th.lavender]),
        ]),
      )
    }
    lines.push(null)
    lines.push(t`${bold(fg(th.peach)("播放次数 Top"))}`)
    if (!s.topPlays.length) {
      lines.push(t`${fg(th.overlay)("  (还没有播放记录)")}`)
    } else {
      const topMax = Math.max(1, ...s.topPlays.map((x) => x.value))
      for (const x of s.topPlays) {
        lines.push(
          new StyledText([
            ...t`${fg(th.text)("  " + fitWidth(clipWidth(x.label, 18), 18))}${fg(th.pink)(String(x.value).padStart(3) + " ")}`.chunks,
            ...this.statBar(x.value, topMax, 20, [th.pink, th.peach]),
          ]),
        )
      }
    }
    lines.push(null)
    lines.push(t`${bold(fg(th.sky)("最近播放"))}`)
    if (!s.recent.length) {
      lines.push(t`${fg(th.overlay)("  (还没有最近播放记录)")}`)
    } else {
      const now = Date.now()
      for (const x of s.recent) {
        lines.push(
          t`${fg(th.text)("  " + fitWidth(clipWidth(x.label, 26), 26))}${fg(th.subtext)(fmtAgo(x.value, now))}`,
        )
      }
    }
    for (let i = 0; i < rows.length; i++) rows[i].content = lines[i] ?? ""
  }

  // =========================================================
  //  通知浮层
  // =========================================================

  private toastBoxes: Array<{ box: BoxRenderable; text: TextRenderable }> = []

  private pushToast(text: string, color: string) {
    if (!this.animTimer) return
    this.toasts.push({ id: ++this.toastSeq, text, color, at: Date.now() })
    while (this.toasts.length > TOAST_MAX) this.toasts.shift()
    this.ensureToasts()
  }

  /** 懒创建通知节点: 必须挂在已提交的 root 上, 预建在隐藏父节点里的文本不会渲染 */
  private ensureToasts() {
    if (this.toastBoxes.length || !this.root) return
    for (let i = 0; i < TOAST_MAX; i++) {
      const box = new BoxRenderable(this.renderer, {
        position: "absolute",
        right: 2,
        bottom: 2 + i * 3,
        width: 44,
        height: 3,
        borderStyle: "rounded",
        borderColor: this.theme.lavender,
        backgroundColor: this.theme.mantle,
        paddingLeft: 1,
        paddingRight: 1,
        visible: false,
        zIndex: 600,
      })
      const text = new TextRenderable(this.renderer, { content: " ", selectable: false, wrapMode: "none" })
      box.add(text)
      this.root.add(box)
      this.toastBoxes.push({ box, text })
    }
  }

  private updateToasts() {
    if (!this.animTimer) {
      for (const tb of this.toastBoxes) tb.box.visible = false
      return
    }
    if (!this.toastBoxes.length) {
      if (!this.toasts.length) return
      this.ensureToasts()
    }
    const now = Date.now()
    this.toasts = this.toasts.filter((x) => now - x.at < TOAST_MS)
    for (let i = 0; i < this.toastBoxes.length; i++) {
      const tb = this.toastBoxes[i]
      const item = this.toasts[this.toasts.length - 1 - i]
      if (!item) {
        tb.box.visible = false
        continue
      }
      const age = now - item.at
      const enter = Math.min(1, age / 180)
      const ease = 1 - (1 - enter) * (1 - enter)
      const fade = Math.min(1, Math.max(0, (TOAST_MS - age) / 300))
      tb.box.visible = true
      tb.box.opacity = Math.max(0, Math.min(1, fade * ease))
      tb.box.right = Math.round(2 + (1 - ease) * 10)
      tb.box.borderColor = item.color
      tb.text.content = t`${fg(item.color)("● ")}${fg(this.theme.text)(clipWidth(item.text, 38))}`
    }
  }

  // =========================================================
  //  动效 (独立帧)
  // =========================================================

  startAnimLoop() {
    this.syncAnimRate(true)
  }

  stopAnimLoop() {
    clearInterval(this.animTimer)
    this.animTimer = undefined
    this.animMs = 0
  }

  private syncAnimRate(force = false) {
    const want = (this.p.playing && !this.p.paused) || this.fullLyrics ? ANIM_FAST_MS : ANIM_IDLE_MS
    if (!force && want === this.animMs) return
    this.animMs = want
    clearInterval(this.animTimer)
    this.animTimer = setInterval(() => this.animTick(), want)
  }

  private animTick() {
    this.updateLogo()
    this.updateSpectrum()
    this.updateNowPlaying()
    this.stepTabAnim()
    this.updateTabIndicator()
    this.updateViewTransition()
    this.updateToasts()
    if (this.showStats) this.updateStats()
    if (this.fullLyrics) this.updateFullLyrics()
  }

  /** Logo 渐变流光: 只写 logo 文本节点 */
  private updateLogo() {
    if (!this.header) return
    const chars = [..."蓝汐音乐"]
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink, this.theme.peach]
    const now = Date.now()
    const flow = (now / 1000) * 0.1
    const parts: TextChunk[] = chars.map((ch, i) => {
      const u = i / Math.max(1, chars.length - 1)
      return bold(fg(paletteAt(pal, u * 0.6 + flow))(ch))
    })
    this.header.logo.content = new StyledText(parts)
  }

  private updateSpectrum() {
    if (!this.now) return
    const p = this.p
    if (p.currentPath !== this.spectrumSeedPath) this.refreshSpectrumSeed()
    const W = typeof this.now.spec.width === "number" && this.now.spec.width > 6 ? this.now.spec.width - 1 : 30
    const cols = Math.max(6, Math.min(48, W))
    if (this.spectrumPeaks.length !== cols) this.spectrumPeaks = new Array(cols).fill(0)
    const now = Date.now() / 1000
    const playing = p.playing && !p.paused
    const energy = playing ? 0.55 + 0.45 * Math.abs(Math.sin(now * 1.5 + this.spectrumSeed)) : p.playing ? 0.16 : 0.05
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink]
    const half = Math.max(3, Math.floor(cols / 2))
    const parts: TextChunk[] = []
    for (let i = 0; i < cols; i++) {
      const x = i < half ? i : cols - 1 - i
      const lowBias = 1 - (x / half) * 0.45
      const raw =
        Math.sin(now * 3.1 + x * 0.52 + this.spectrumSeed) * 0.5 +
        Math.sin(now * 5.9 + x * 1.31 + this.spectrumSeed * 2.3) * 0.32 +
        Math.sin(now * 1.27 + x * 0.17) * 0.18
      const level = Math.max(0, Math.min(1, Math.abs(raw) * lowBias * energy * 1.7))
      const pk = Math.max((this.spectrumPeaks[i] ?? 0) - 0.012, level)
      this.spectrumPeaks[i] = pk
      let col = paletteAt(pal, (x / half) * 0.8 + now * 0.04)
      if (level > pk - 0.06) col = mixHex(col, this.theme.white, 0.5)
      parts.push(fg(col)(levelChar(level)))
    }
    this.now.spec.content = new StyledText(parts)
  }

  private refreshSpectrumSeed() {
    const path = this.p.currentPath ?? ""
    this.spectrumSeedPath = this.p.currentPath
    let h = 2166136261
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    this.spectrumSeed = ((h >>> 0) % 1000) / 1000
    this.spectrumPeaks = []
  }

  private updateViewTransition() {
    if (!this.list) return
    if (this.viewAnimT >= 1) {
      this.list.box.borderColor = this.theme.surface1
      return
    }
    this.viewAnimT = Math.min(1, this.viewAnimT + 0.1)
    const e = 1 - Math.pow(1 - this.viewAnimT, 3)
    this.list.box.borderColor = mixHex(this.theme.sky, this.theme.surface1, e)
  }


  // =========================================================
  //  列表渲染
  // =========================================================

  updatePlaylist() {
    const p = this.p
    this.applyListChrome()
    const n = this.listCount()
    this.ensureRows(n)
    if (this.sel !== this.lastMarqueeSel) {
      this.lastMarqueeSel = this.sel
      this.marqueeAnchor = Date.now()
    }
    const phase = Math.floor((Date.now() - this.marqueeAnchor) / 100)
    this.selMarquee = null
    const fallbackAvail = this.wide
      ? Math.max(40, (this.renderer.width || 100) - (typeof this.sidebar.width === "number" ? this.sidebar.width : SIDEBAR_W) - 4)
      : Math.max(30, (this.renderer.width || 80) - 4)
    const avail = typeof this.list.scroll.width === "number" && this.list.scroll.width > 4 ? this.list.scroll.width : fallbackAvail
    const inner = Math.max(20, avail - 2)

    for (let i = 0; i < n; i++) {
      const row = this.plRows[i]
      const m = this.rowModel(i)
      const isSel = i === this.sel
      const isPlaying = m.playing
      const numW = m.num ? displayWidth(m.num) : 0
      const leadW = 2
      const tagW = m.tag ? displayWidth(m.tag) + 1 : 0
      const metaW = m.meta ? displayWidth(m.meta) + 2 : 0
      const titleW = Math.max(8, inner - leadW - numW - tagW - metaW)
      const long = displayWidth(m.title) > titleW
      const scrollable = isSel && long
      if (scrollable) this.selMarquee = { text: m.title, width: titleW }
      const shown = scrollable ? scrollText(m.title, titleW, phase) : clipWidth(m.title, titleW)

      if (isSel) {
        row.box.backgroundColor = this.theme.surface0
        row.lead.content = t`${fg(m.accent)(m.playing ? "▶" : "▌")} `
        row.num.content = m.num ? t`${bold(fg(this.theme.sky)(m.num + " "))}` : ""
        row.title.content = t`${bold(fg(this.theme.text)(shown))}`
        row.tag.content = m.tag ? t`${fg(this.theme.pink)(" " + m.tag)}` : ""
        row.meta.content = m.meta ? t`${fg(this.theme.subtext)("  " + m.meta)}` : ""
      } else if (isPlaying) {
        row.box.backgroundColor = this.theme.base
        const glow = mixHex(this.theme.green, this.theme.sky, 0.2 + 0.6 * pulse(Date.now(), 2600))
        row.lead.content = t`${fg(glow)("▶")} `
        row.num.content = m.num ? t`${fg(this.theme.overlay)(m.num + " ")}` : ""
        row.title.content = t`${fg(glow)(shown)}`
        row.tag.content = m.tag ? t`${fg(this.theme.pink)(" " + m.tag)}` : ""
        row.meta.content = m.meta ? t`${fg(this.theme.green)("  " + m.meta)}` : ""
      } else {
        row.box.backgroundColor = this.theme.base
        row.lead.content = t`${fg(this.theme.surface1)("  ")}`
        row.num.content = m.num ? t`${fg(this.theme.overlay)(m.num + " ")}` : ""
        row.title.content = t`${fg(this.theme.text)(shown)}`
        row.tag.content = m.tag ? t`${fg(this.theme.overlay)(" " + m.tag)}` : ""
        row.meta.content = m.meta ? t`${fg(this.theme.overlay)("  " + m.meta)}` : ""
      }
    }

    // 空状态
    const emptyText = this.emptyText()
    this.list.empty.content = emptyText ? t`${fg(this.theme.overlay)(emptyText)}` : ""
    this.list.emptyArea.flexGrow = emptyText ? 1 : 0
    this.list.emptyArea.flexBasis = emptyText ? 0 : undefined
    this.list.scroll.flexGrow = emptyText ? 0 : 1
    this.list.footer.content = this.listFooter()

    try {
      this.list.scroll.scrollChildIntoView(`pl-${this.sel}`)
    } catch {
      /* 布局未就绪时忽略 */
    }
    this.updateStatus()
  }

  /** 列表面板的标题/边框颜色随视图变化, 让当前位置一眼可辨 */
  private applyListChrome() {
    const th = this.theme
    const title =
      this.view === "settings" ? "设置"
      : this.view === "queue" ? `队列 · ${this.p.queue.length} 首`
      : this.view === "fav" ? `收藏 · ${this.listCount()} 首`
      : this.view === "pl" ? (this.plLevel === "list" ? "歌单" : this.plPickerMode ? `加歌 → ${this.plCurrent ?? ""}` : this.plCurrent ?? "歌单")
      : this.searchActive ? `搜索 · ${this.listCount()} 首`
      : "播放列表"
    this.list.box.title = ` ${title} `
    const color =
      this.view === "settings" ? th.lavender
      : this.view === "queue" ? th.green
      : this.view === "fav" ? th.pink
      : this.view === "pl" ? th.green
      : th.sky
    if (this.viewAnimT >= 1) this.list.box.borderColor = th.surface1
    this.list.box.titleColor = color
  }

  private ensureRows(n: number) {
    if (this.plRows.length === n) return
    for (const row of this.plRows) row.box.destroyRecursively()
    this.plRows = []
    for (let i = 0; i < n; i++) {
      const row = buildRow(this.renderer, this.theme, () => this.onRowClick(i))
      row.box.id = `pl-${i}`
      this.list.scroll.add(row.box)
      this.plRows.push(row)
    }
  }

  private emptyText(): string {
    const p = this.p
    if (this.view === "queue") return p.queue.length ? "" : "队列是空的 · 按 e 把歌曲加入队列"
    if (this.view === "pl") {
      if (this.plLevel === "list") return p.playlists.length ? "" : "还没有歌单 · 按 n 新建"
      if (this.plPickerMode) return p.playlist.length ? "" : "音乐库为空"
      return this.listCount() ? "" : "歌单是空的 · 按 a 添加歌曲"
    }
    if (this.view === "settings") return ""
    if (this.searchActive) return this.listCount() ? "" : "没有匹配的歌曲 · Esc 退出搜索"
    if (this.view === "fav") return this.listCount() ? "" : "还没有收藏 · 在列表里按 f"
    return this.listCount() ? "" : "音乐库为空 · 按 d 重新扫描"
  }

  private listFooter(): string {
    const p = this.p
    if (this.view === "settings") return ""
    if (this.view === "pl" && this.plLevel === "list") return ` 共 ${p.playlists.length} 个歌单`
    if (this.view === "pl" && this.plPickerMode) return ` 共 ${p.playlist.length} 首 · Enter 加入 · Esc 返回`
    if (this.view === "pl" && this.plCurrent) return ` 共 ${this.listCount()} 首 · Esc 返回歌单列表`
    if (this.view === "queue") {
      const pos = p.queuePos()
      return pos >= 0
        ? ` 第 ${pos + 1}/${p.queue.length} 位 · 当前: ${clipWidth(p.currentBase(), 28)}`
        : ` ${p.queue.length} 首 · 当前曲不在队列`
    }
    return ` 共 ${this.listCount()} 首${this.searchActive ? ` · 搜索: ${this.searchQuery}` : ""}`
  }

  private rowModel(i: number): {
    lead: string
    accent: string
    num: string
    title: string
    tag: string
    meta: string
    playing: boolean
  } {
    const p = this.p
    const base = { lead: "", accent: this.theme.sky, num: "", title: "", tag: "", meta: "", playing: false }
    const n = Math.max(this.listCount(), 1)
    const idxStr = String(i + 1).padStart(String(n).length, " ")

    if (this.view === "settings") {
      const vol = p.volume
      const barW = 12
      const filled = Math.round((vol / 150) * barW)
      const bar = "█".repeat(filled) + "─".repeat(Math.max(0, barW - filled))
      const dirs = p.scanRoots()
      const rows: Array<[string, string]> = [
        ["主题", `${THEME_LABEL[this.themeName]}     (${THEME_ORDER.length} 种)`],
        ["音量", `${bar}  ${String(vol).padStart(3)}${p.muted ? "  静音" : "%"}`],
        ["倍速", `${p.speed.toFixed(2)}x`],
        ["歌词延迟", `${p.lyricDelay > 0 ? "+" : ""}${p.lyricDelay.toFixed(2)}s`],
        ["睡眠定时", p.sleepMinutes === 0 ? "关闭" : `${p.sleepMinutes} 分钟`],
        ["音乐目录", `(${dirs.length}) ${clipWidth(dirs[0] ?? "—", 34)}`],
        ["列表排序", `${SORT_LABEL[p.sortMode]} ${p.sortAsc ? "↑" : "↓"}`],
        ["缓存目录", clipWidth(CACHE_DIR, 36)],
        ["版本", VERSION],
      ]
      const row = rows[i]
      if (!row) return base
      return {
        ...base,
        title: `${fitWidth(row[0], 12)}${row[1]}`,
        tag: "",
        meta: i === 5 || i === 7 ? "Enter" : i === 8 ? "" : "◂ ▸",
        accent: this.theme.lavender,
      }
    }

    if (this.view === "queue") {
      const real = p.queue[i]
      const path = real !== undefined ? p.playlist[real] : undefined
      if (!path) return base
      const isCur = real === p.idx
      return {
        lead: "",
        accent: isCur ? this.theme.green : this.theme.lavender,
        num: idxStr,
        title: titleOf(path),
        tag: isCur ? "正在播放" : "",
        meta: `${extOf(path).replace(".", "")}  ${fmtShort(p.durationOf(path))}`,
        playing: isCur,
      }
    }

    if (this.view === "pl") {
      if (this.plLevel === "list") {
        const pl = p.playlists[i]
        if (!pl) return base
        return {
          lead: "",
          accent: this.theme.green,
          num: idxStr,
          title: pl.name,
          tag: "",
          meta: `${pl.paths.length} 首`,
          playing: false,
        }
      }
      if (this.plPickerMode) {
        const path = p.playlist[i]
        if (!path) return base
        const inPl = this.plCurrent ? p.playlistPaths(this.plCurrent).includes(path) : false
        return {
          lead: "",
          accent: this.theme.green,
          num: idxStr,
          title: titleOf(path),
          tag: inPl ? "✓" : "",
          meta: `${extOf(path).replace(".", "")}  ${fmtShort(p.durationOf(path))}`,
          playing: i === p.idx,
        }
      }
      const paths = this.plCurrent ? p.playlistPaths(this.plCurrent) : []
      const path = paths[i]
      if (!path) return base
      const real = p.playlist.indexOf(path)
      return {
        lead: "",
        accent: this.theme.sky,
        num: idxStr,
        title: titleOf(path),
        tag: "",
        meta: `${extOf(path).replace(".", "")}  ${fmtShort(p.durationOf(path))}`,
        playing: real === p.idx,
      }
    }

    // list / fav
    const filtered = this.searchActive || this.view === "fav" || p.favMode
    const real = filtered ? p.queue[i] : i
    const path = real !== undefined ? p.playlist[real] : undefined
    if (!path) return base
    const fav = p.favorites.includes(path)
    const cnt = p.playCountOf(path)
    return {
      lead: "",
      accent: real === p.idx ? this.theme.green : this.theme.sky,
      num: idxStr,
      title: titleOf(path),
      tag: fav ? "♥" : "",
      meta: `${cnt > 0 ? `♪${cnt}  ` : ""}${extOf(path).replace(".", "")}  ${fmtShort(p.durationOf(path))}`,
      playing: real === p.idx,
    }
  }

  private onRowClick(i: number) {
    const inRange = i < this.listCount()
    if (!inRange) return
    this.sel = i
    this.updatePlaylist()
    if (this.view === "settings") this.settingEnter()
    else if (this.view === "pl") this.plEnter()
    else this.playSel()
  }

  // =========================================================
  //  顶部 / 底部 / 播放卡片
  // =========================================================

  private updateHeader() {
    const p = this.p
    const th = this.theme
    const label =
      this.view === "settings"
        ? "设置"
        : this.view === "queue"
          ? "队列"
          : this.view === "fav"
            ? "收藏"
            : this.view === "pl"
              ? this.plLevel === "detail"
                ? `歌单 · ${this.plCurrent ?? ""}`
                : "歌单"
              : this.searchActive
                ? "搜索"
                : "播放列表"
    const icon = TAB_ICONS[TAB_KEYS.indexOf(this.view)] ?? "♪"
    this.header.mode.content = t`${bold(fg(th.base)(` ${icon} ${label} `))}`
    this.header.mode.bg = th.sky

    const sleep = p.sleepUntil ? `睡眠 ${fmt(p.sleepRemaining())}  ·  ` : ""
    const vol = p.muted ? "静音" : `${p.volume}%`
    const speed = p.speed !== 1 ? `  ·  ×${p.speed.toFixed(2)}` : ""
    this.header.right.content = clipWidth(
      `${sleep}${REPEAT_ICON[p.repeat]} ${REPEAT_LABEL[p.repeat]}  ·  ${p.isShuffle ? "随机" : "顺序"}  ·  ${vol}${speed}`,
      60,
    )
  }

  private updateStatus() {
    if (!this.status) return
    const p = this.p
    if (this.searchMode) return
    const fresh = Date.now() < this.msgUntil
    const pos = p.playlist.length && p.currentPath ? ` ${p.idx + 1}/${p.playlist.length}` : ""
    const total = p.totalPlayCount
    const rightStr = clipWidth(`♪ ${total} 次${pos}  ·  ${p.muted ? "静音" : `音量 ${p.volume}`} `, 40)
    const avail = Math.max(10, (this.renderer.width || 80) - displayWidth(rightStr) - 2)
    this.status.left.content = clipWidth(fresh ? this.msg : this.hintText(), Math.min(HINT_MAX, avail))
    this.status.left.fg = fresh ? this.theme.pink : this.theme.subtext
    this.status.right.content = rightStr
  }

  /** 上下文快捷键提示: 跟视图走, 而不是永远一条长清单 */
  private hintText(): string {
    if (this.view === "settings") return " ↑↓ 选择 · ←→ 调整 · Enter 确认 · Esc 返回 · q 退出"
    if (this.view === "queue") return " Enter 播放 · x 移除 · J/K 移动 · c 清空 · w 插队 · 1 返回列表"
    if (this.view === "pl") {
      if (this.plLevel === "list") return " Enter 进入 · n 新建 · r 重命名 · d 删除 · Esc 返回"
      if (this.plPickerMode) return " Enter 加入 · ↑↓ 选择 · Esc 返回歌单"
      return " Enter 播放 · a 加歌 · x 移除 · Esc 返回歌单列表"
    }
    if (this.view === "fav") return " Enter 播放 · f 取消收藏 · w 插队 · R 改名 · D 删除 · / 搜索"
    return " 空格 播放/暂停 · n/p 切歌 · w 插队 · f 收藏 · / 搜索 · h 帮助 · q 退出"
  }

  updateNowPlaying() {
    if (!this.now || !this.p) return
    const p = this.p
    const th = this.theme
    const playing = p.playing && !p.paused
    this.now.status.content = p.playing ? (p.paused ? "‖ 暂停 " : "▶ 播放 ") : "■ 待机 "
    this.now.status.fg = p.playing ? (p.paused ? th.yellow : th.green) : th.overlay

    const sidebarW0 = typeof this.sidebar.width === "number" ? this.sidebar.width : (this.renderer.width || SIDEBAR_W)
    const cardTextW = Math.max(10, sidebarW0 - 8)
    const tagged = p.currentArtist()
    const plays = p.playCountOf(p.currentPath)
    const posStr = p.playlist.length ? `${p.idx + 1}/${p.playlist.length}` : ""
    const ext = extOf(p.currentPath ?? "").replace(".", "").toUpperCase()
    const bits = [tagged, ext, posStr].filter((x) => !!x)
    const sub = `${bits.join("  ·  ")}${plays > 0 ? `  ·  ♪${plays}` : ""}`
    this.now.title.content = t`${bold(fg(th.text)(clipWidth(p.currentTitle(), cardTextW)))}`
    this.now.sub.content = t`${fg(th.overlay)(clipWidth(sub, cardTextW))}`

    const dur = p.duration
    const pos = p.timePos
    const ratio = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0
    const sidebarW = typeof this.sidebar.width === "number" ? this.sidebar.width : (this.renderer.width || SIDEBAR_W)
    const timeStr = `${fmt(pos)} / ${dur > 0 ? fmt(dur) : "--:--"}`
    const cardW = Math.max(16, sidebarW - 6)
    const width = Math.max(8, cardW - displayWidth(timeStr) - 1)
    const pal = [th.sky, th.lavender, th.pink]
    const flow = (Date.now() / 1000) * (playing ? 0.22 : 0.05)
    const shine = playing ? (((Date.now() / 1000) * 0.4) % 1.5) - 0.25 : -1
    this.now.bar.content = new StyledText(
      progressBar({ width, ratio, palette: pal, track: th.surface1, flow, shine, dim: playing ? 0 : 0.5 }),
    )
    this.now.time.content = timeStr

    // 卡片底部渐变线
    const inner = Math.max(10, (typeof this.now.box.width === "number" ? this.now.box.width : 40) - 6)
    const lineW = Math.max(6, Math.min(inner, 26))
    this.now.divider.content = new StyledText(
      gradientLine(lineW, pal, th.crust, (Date.now() / 1000) * 0.1, 0.3),
    )
    const glow = p.playing ? (p.paused ? 0.2 : 0.15 + 0.45 * pulse(Date.now(), 3200)) : 0
    this.now.box.borderColor = glow > 0 ? mixHex(th.surface1, p.paused ? th.yellow : th.lavender, glow) : th.surface1

    this.updateSpectrum()
    this.updateUpcoming()
    if (this.fullLyrics) this.updateFullLyrics()
  }

  private nextUpIndex(): number | null {
    const p = this.p
    const pos = p.queue.indexOf(p.idx)
    if (pos < 0) return null
    const next = p.queue[pos + 1]
    return next === undefined ? null : next
  }

  /** 侧栏「接下来」: 队列中当前曲之后 3 首 */
  private updateUpcoming() {
    if (!this.upcoming || !this.upcoming.box.visible) return
    const p = this.p
    const th = this.theme
    const pos = p.queue.indexOf(p.idx)
    const sidebarW0 = typeof this.sidebar.width === "number" ? this.sidebar.width : (this.renderer.width || SIDEBAR_W)
    const titleW = Math.max(10, sidebarW0 - 14)
    let shown = 0
    for (let i = 0; i < this.upcoming.rows.length; i++) {
      const row = this.upcoming.rows[i]
      const real = pos >= 0 ? p.queue[pos + 1 + i] : undefined
      const path = real === undefined ? undefined : p.playlist[real]
      if (!path) {
        row.content = ""
        continue
      }
      shown++
      const dur = p.durationOf(path)
      row.content = t`${fg(th.overlay)(` ${i + 1} `)}${fg(i === 0 ? th.text : th.subtext)(clipWidth(titleOf(path), titleW))}${fg(th.overlay)(dur > 0 ? `  ${fmtShort(dur)}` : "")}`
    }
    if (!shown) this.upcoming.rows[0].content = t`${fg(th.overlay)(" 队列已到末尾")}`
  }

  /** 歌词面板: 当前句 + 上下各一句 (高度随面板自适应) */
  private updateLyrics() {
    const p = this.p
    const th = this.theme
    if (!this.wide) {
      this.lyrics.box.visible = false
      return
    }
    this.lyrics.box.visible = true
    if (!p.showLyrics || !p.lyrics.length) {
      // 常显面板: 无歌词时给出说明, 避免侧栏出现空洞
      const hint = p.showLyrics ? " (无歌词文件 · 同名 .lrc)" : " 歌词已关闭 · 按 l 开启"
      const rows = this.lyrics.rows
      if (!rows.length) return
      const mid = Math.floor(rows.length / 2)
      rows.forEach((row, i) => {
        row.content = i === mid ? t`${fg(th.overlay)(hint)}` : ""
      })
      return
    }
    const h = Math.max(3, Math.min(5, typeof this.lyrics.inner.height === "number" ? this.lyrics.inner.height : 5))
    if (this.lyricRowCount !== h) {
      for (const row of this.lyrics.rows) row.destroy()
      this.lyrics.rows = []
      for (let i = 0; i < h; i++) {
        const row = new TextRenderable(this.renderer, { content: "", selectable: false, wrapMode: "none", height: 1, width: "100%" })
        this.lyrics.inner.add(row)
        this.lyrics.rows.push(row)
      }
      this.lyricRowCount = h
    }
    const lyricTime = p.timePos - p.lyricDelay
    let cur = 0
    for (let i = 0; i < p.lyrics.length; i++) {
      if (p.lyrics[i].time <= lyricTime) cur = i
      else break
    }
    const mid = Math.floor(h / 2)
    const sidebarW = typeof this.sidebar.width === "number" ? this.sidebar.width : SIDEBAR_W
    const maxW = Math.max(10, sidebarW - 10)
    for (let r = 0; r < h; r++) {
      const idx = cur + (r - mid)
      const row = this.lyrics.rows[r]
      if (idx < 0 || idx >= p.lyrics.length) {
        row.content = ""
        continue
      }
      const text = p.lyrics[idx].text || "♪"
      if (r === mid) {
        // 当前句居中 + 左右留白, 超宽滚动
        const inner = Math.max(8, maxW - 4)
        const shown = scrollText(text, inner, this.tickCount)
        row.content = t`${fg(th.sky)(bold("♪ " + shown))}`
      } else {
        row.content = t`${fg(r === mid - 1 || r === mid + 1 ? th.subtext : th.overlay)("  " + clipWidth(text, maxW - 2))}`
      }
    }
  }

  private updateFullLyrics() {
    const p = this.p
    const th = this.theme
    this.fullTitle.content = t`${fg(p.playing ? (p.paused ? th.yellow : th.green) : th.overlay)("  ")}${bold(fg(th.text)(clipWidth(p.currentTitle(), 60)))}${fg(th.overlay)(p.currentArtist() ? `  — ${clipWidth(p.currentArtist(), 30)}` : "")}`
    const dur = p.duration
    const tpos = Math.max(0, p.timePos - p.lyricDelay)
    const ratio = dur > 0 ? Math.min(1, tpos / dur) : 0
    const w = Math.max(20, Math.min(80, (this.renderer.width || 80) - 16))
    const pal = [th.sky, th.lavender, th.pink]
    const bar = progressBar({ width: w, ratio, palette: pal, track: th.surface1, flow: (Date.now() / 1000) * 0.2, shine: -1 })
    this.fullProgress.content = new StyledText([...bar, ...t`${fg(th.subtext)(`  ${fmt(tpos)} / ${dur > 0 ? fmt(dur) : "--:--"}`)}`.chunks])
    if (!p.lyrics.length) {
      const mid = Math.floor(this.fullLyricRows.length / 2)
      this.fullLyricRows.forEach((row, i) => {
        row.content = i === mid ? t`${fg(th.overlay)("(无歌词文件 · 同名 .lrc)")}` : ""
      })
      return
    }
    let cur = 0
    for (let i = 0; i < p.lyrics.length; i++) {
      if (p.lyrics[i].time <= tpos) cur = i
      else break
    }
    const mid = Math.floor(this.fullLyricRows.length / 2)
    const maxW = Math.max(20, Math.min(90, (this.renderer.width || 80) - 12))
    for (let r = 0; r < this.fullLyricRows.length; r++) {
      const idx = cur + (r - mid)
      const row = this.fullLyricRows[r]
      if (idx < 0 || idx >= p.lyrics.length) {
        row.content = ""
        continue
      }
      const dist = Math.abs(r - mid)
      const text = p.lyrics[idx].text
      if (dist === 0) {
        const shown = scrollText(text, maxW, this.tickCount)
        row.content = t`${bold(fg(th.sky)(shown))}`
      } else {
        row.content = t`${fg(dist === 1 ? th.subtext : th.overlay)(clipWidth(text, maxW))}`
      }
    }
  }

  // =========================================================
  //  主循环 (100ms)
  // =========================================================

  tick() {
    const p = this.p
    this.tickCount++
    if (this.searchMode && !this.searchInput.focused) this.searchInput.focus()

    // 睡眠定时到点 → 7 秒渐弱后暂停
    if (p.sleepExpired()) {
      p.fadeState = null
      this.sleepFading = true
      this.sleepFadeFrom = p.volume
      this.sleepFadeAt = Date.now()
      this.flash("睡眠定时到点 · 正在渐弱…", 3)
    }
    if (this.sleepFading) {
      const t = Math.min(1, (Date.now() - this.sleepFadeAt) / 7000)
      const v = Math.round(this.sleepFadeFrom * (1 - t))
      p.mpv.setProperty("volume", v)
      p.fadeVol = v
      if (t >= 1) {
        p.mpv.pause(true)
        p.paused = true
        p.mpv.setProperty("volume", p.volume)
        p.fadeVol = p.volume
        this.sleepFading = false
        this.flash("睡眠定时已暂停播放", 3)
      }
    }

    this.applyViewLayout()
    this.updateHeader()
    this.updateNowPlaying()
    this.updateLyrics()
    this.updatePlaylist()
    if (!this.animTimer) {
      this.updateToasts()
      this.updateTabIndicator()
      this.updateViewTransition()
      this.stepTabAnim()
    }
    if (this.animTimer) this.syncAnimRate()
    if (this.showStats) this.updateStats()
    if (this.showSort) this.updateSortMenu()
    if (this.showDirManager) this.updateDirManager()
    if (!this.sleepFading) p.updateFade()
    if (p.playing && p.duration <= 0 && this.tickCount % 10 === 0) {
      p.mpv.getProperty<number>("duration").then((d) => {
        if (typeof d === "number" && Number.isFinite(d) && d > 0) p.duration = d
      })
    }
  }
}

// =========================================================
//  文件级小工具
// =========================================================

/** 扩展名 (含点, 小写; 过长/无扩展名返回 "") */
function extOf(p: string): string {
  const i = p.lastIndexOf(".")
  if (i <= 0) return ""
  const ext = p.slice(i).toLowerCase()
  return ext.length > 1 && ext.length <= 5 ? ext : ""
}

/** 展开 ~ 并转绝对路径 (目录输入用) */
function expandPath(raw: string): string {
  const s = raw.trim()
  if (!s) return ""
  if (s === "~") return homedir()
  if (s.startsWith("~/")) return resolve(homedir(), s.slice(2))
  return resolve(s)
}
