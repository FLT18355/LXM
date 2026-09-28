/**
 * bili-tui — yt-dlp 图形化 (哔哩哔哩 视频/音乐)
 *
 * 状态机: idle → probing → video | list → downloading → done | error
 * 只接受 bilibili.com / b23.tv; 其它域名一律拒绝。
 */
import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  t,
  bold,
  fg,
  bg,
  type CliRenderer,
  type KeyEvent,
  StyledText,
  type TextChunk,
} from "@opentui/core"
import { existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  biliHostOk,
  probe,
  probeFull,
  videoMenu,
  audioMenu,
  DownloadJob,
  type Probe,
  type VideoInfo,
  type ListInfo,
  type MenuItem,
  type Progress,
  type DownloadSpec,
} from "./ytdlp"
import { loadConfig, saveConfig, defaultDownloadDir, defaultCookiesFile, type Config } from "./config"
import { truncateW, chip, keycap, keyHint, progressBar, padStartW, ICON, displayWidth } from "./ui-helpers"
import { THEMES, THEME_ORDER, THEME_LABEL, parseThemeName, type Theme, type ThemeName } from "./theme"

type Stage = "idle" | "probing" | "video" | "list" | "downloading" | "done" | "error"
type Mode = "video" | "audio"

/** [按键列表, 说明] — 用于 idle 屏快捷键面板 */
const HELP_LINES: [string[], string][] = [
  [["Enter"], "解析 URL 栏中的哔哩哔哩链接"],
  [["v", "a"], "切换视频画质 / 音乐音质"],
  [["↑", "↓", "j", "k"], "在画质列表 / 分P列表中移动"],
  [["Space"], "分P列表勾选当前项"],
  [["d"], "下载已勾选的分P (合集批量)"],
  [["Enter"], "画质页直接下载当前项"],
  [["c"], "下载中取消当前任务"],
  [["s"], "修改下载目录 (Esc 关闭弹层)"],
  [["t"], "循环切换主题 (摩卡 ⇄ 拿铁)"],
  [["o"], "下载完成后打开下载目录"],
  [["Esc"], "返回上一级 / 退出"],
  [["q"], "退出程序 · Ctrl+C 强退"],
]

const MAX_LOG_LINES = 300

/** 解析阶段 spinner 帧 (盲文点阵) */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`
}

function truncate(s: string, n: number): string {
  return truncateW(s, n)
}

export class App {
  private r: CliRenderer
  private cfg: Config
  private outDir: string
  private cookiesFile: string
  private themeName: ThemeName
  private theme: Theme

  // 控件
  private urlInput!: InputRenderable
  private stageHint!: TextRenderable
  private vTabText!: TextRenderable
  private aTabText!: TextRenderable
  private dirText!: TextRenderable
  private idleBox!: BoxRenderable
  private busyText!: TextRenderable
  private videoBox!: BoxRenderable
  private vInfoText!: TextRenderable
  private fmtHint!: TextRenderable
  private fmtSelect!: SelectRenderable
  private listBox!: BoxRenderable
  private lTitleText!: TextRenderable
  private lHintText!: TextRenderable
  private entriesBox!: ScrollBoxRenderable
  private entryBoxes: BoxRenderable[] = []
  private dlBox!: BoxRenderable
  private dlName!: TextRenderable
  private dlBar!: TextRenderable
  private dlMeta!: TextRenderable
  private dlStatus!: TextRenderable
  private logBox!: ScrollBoxRenderable
  private resultTitle!: TextRenderable
  private resultBody!: TextRenderable
  private statusBar!: TextRenderable
  private msgBar!: TextRenderable
  private resultBox!: BoxRenderable
  private gradBar!: TextRenderable
  private urlLabel!: TextRenderable
  private idleBanner!: TextRenderable
  private idleSub!: TextRenderable
  private idleKeyWrap!: BoxRenderable
  private spinnerIdx = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  /** spinner 旁的静态文案 */
  private busyBase = ""
  /** banner 波浪相位 + 定时器 (仅 idle / probing 阶段运行) */
  private bannerPhase = 0
  private bannerTimer: ReturnType<typeof setInterval> | undefined
  private dirOverlay!: BoxRenderable
  private dirInput!: InputRenderable

  // 状态
  private stage: Stage = "idle"
  private mode: Mode = "video"
  private listInfo: ListInfo | null = null
  private videoInfo: VideoInfo | null = null
  private videoEntryUrl = ""
  private menu: MenuItem[] = []
  private job: DownloadJob | null = null
  private selIdx = 0
  private selected = new Set<number>()
  private msgTimer: ReturnType<typeof setTimeout> | undefined
  private logNodes: TextRenderable[] = []
  private logText: string[] = []
  private prog: Progress = { status: "" }
  private destroyed = false

  constructor(renderer: CliRenderer) {
    this.r = renderer
    this.cfg = loadConfig()
    this.outDir = this.resolveDir((this.cfg.download_dir as string) || defaultDownloadDir())
    this.cookiesFile = (this.cfg.cookies_file as string) || defaultCookiesFile()
    this.themeName = parseThemeName(this.cfg.theme)
    this.theme = THEMES[this.themeName]
    this.build()
    this.setStage("idle")
    this.renderStatus()
    this.r.keyInput.on("keypress", (k) => this.handleKey(k))
    // 外部信号 (kill / Ctrl+C) 终止时, 先设标志阻止异步回调写已销毁的 renderable,
    // 再销毁渲染器恢复终端, 最后退出进程 (监听器会压制默认终止行为)
    const markDead = (): void => {
      if (this.destroyed) return
      this.destroyed = true
      this.stopSpinner()
      this.stopBanner()
      try {
        this.r.destroy()
      } catch {
        /* 已销毁 */
      }
      setTimeout(() => process.exit(0), 50)
    }
    process.on("SIGINT", markDead)
    process.on("SIGTERM", markDead)
  }

  private resolveDir(d: string): string {
    for (const cand of [d, join(homedir(), "Downloads")]) {
      try {
        mkdirSync(cand, { recursive: true })
        if (existsSync(cand)) return cand
      } catch {
        /* 试下一个 */
      }
    }
    return homedir()
  }

  // ======================================================== 构树

  private build(): void {
    const r = this.r
    const th = this.theme
    const root = new BoxRenderable(r, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: th.base,
    })

    // ── 顶栏: 品牌 + 阶段 + 主题 ──
    const header = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: th.mantle,
    })
    header.add(
      new TextRenderable(r, {
        content: t`${bg(th.blue)(bold(fg(th.crust)(` ${ICON.video} bili-tui `)))}${fg(th.overlay)("  ▸ ")}${fg(th.subtext)("哔哩哔哩下载")}${fg(th.overlay)("  ·  yt-dlp")}`,
        selectable: false,
        wrapMode: "none",
      }),
    )
    const headerRight = new BoxRenderable(r, { height: 1, flexDirection: "row", alignItems: "center", gap: 1 })
    this.stageHint = new TextRenderable(r, { content: "", fg: th.subtext, selectable: false, wrapMode: "none" })
    headerRight.add(this.stageHint)
    header.add(headerRight)
    root.add(header)

    // ── 渐变饰条 (1行) ──
    this.gradBar = new TextRenderable(r, {
      content: this.makeGradientLine(),
      height: 1,
      selectable: false,
      wrapMode: "none",
    })
    root.add(this.gradBar)

    // ── URL 面板 (圆角边框) ──
    const urlPanel = new BoxRenderable(r, {
      flexDirection: "row",
      alignItems: "center",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.crust,
    })
    this.urlLabel = new TextRenderable(r, {
      content: t`${bold(fg(th.blue)("URL"))}${fg(th.overlay)("▸")}`,
      selectable: false,
      wrapMode: "none",
    })
    urlPanel.add(this.urlLabel)
    this.urlInput = new InputRenderable(r, {
      id: "url",
      flexGrow: 1,
      minWidth: 1,
      placeholder: "粘贴哔哩哔哩链接 (video / av / bangumi / audio / b23.tv)  ·  Enter 解析",
      backgroundColor: th.crust,
      focusedBackgroundColor: th.mantle,
      textColor: th.text,
      cursorColor: th.blue,
    })
    this.urlInput.on(InputRenderableEvents.ENTER, (v) => this.startProbe(v))
    urlPanel.add(this.urlInput)
    // 解析按钮 (静态提示, 鼠标点击触发)
    const parseBtn = new BoxRenderable(r, {
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: th.surface0,
      onMouseDown: () => this.startProbe(this.urlInput.value),
    })
    parseBtn.add(new TextRenderable(r, { content: t`${bold(fg(th.green)(`${ICON.search} 解析`))}`, selectable: false, wrapMode: "none" }))
    urlPanel.add(parseBtn)
    root.add(urlPanel)

    // ── 模式 chip + 目录行 ──
    const modeRow = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: 0,
      backgroundColor: th.crust,
    })
    modeRow.add(new TextRenderable(r, { content: t`${fg(th.overlay)("模式")}`, selectable: false, wrapMode: "none" }))
    const vidTab = new BoxRenderable(r, {
      height: 1,
      backgroundColor: th.surface0,
      onMouseDown: () => { if (this.videoInfo) this.switchMode("video") },
    })
    this.vTabText = new TextRenderable(r, { content: `  ${ICON.video} 视频  `, fg: th.subtext, selectable: false, wrapMode: "none" })
    vidTab.add(this.vTabText)
    const audTab = new BoxRenderable(r, {
      height: 1,
      backgroundColor: th.surface0,
      onMouseDown: () => { if (this.videoInfo) this.switchMode("audio") },
    })
    this.aTabText = new TextRenderable(r, { content: `  ${ICON.music} 音乐  `, fg: th.subtext, selectable: false, wrapMode: "none" })
    audTab.add(this.aTabText)
    modeRow.add(vidTab)
    modeRow.add(audTab)
    // 目录 chip
    modeRow.add(new TextRenderable(r, { content: t`${fg(th.overlay)(`  ${ICON.folder} 目录`)}`, selectable: false, wrapMode: "none" }))
    this.dirText = new TextRenderable(r, { content: this.outDir, fg: th.subtext, selectable: false, wrapMode: "none", flexShrink: 1 })
    modeRow.add(this.dirText)
    root.add(modeRow)

    // ── idle / probing: 居中欢迎屏 ──
    this.idleBox = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      alignItems: "center",
      justifyContent: "center",
      paddingX: 2,
      paddingTop: 1,
      backgroundColor: th.base,
    })
    // ASCII banner
    this.idleBanner = new TextRenderable(r, {
      content: this.makeBanner(),
      fg: th.blue,
      selectable: false,
      wrapMode: "none",
      marginBottom: 1,
    })
    this.idleBox.add(this.idleBanner)
    // 副标题
    this.idleSub = new TextRenderable(r, {
      content: t`${fg(th.lavender)("把哔哩哔哩链接丢进水里, 等它浮上来")}${fg(th.overlay)(`  ${ICON.tint}  `)}${fg(th.mauve)("Paste · Parse · Download")}`,
      selectable: false,
      wrapMode: "none",
      marginBottom: 1,
    })
    this.idleBox.add(this.idleSub)
    // 快捷键面板: 两列
    this.idleKeyWrap = new BoxRenderable(r, {
      flexDirection: "row",
      gap: 4,
      alignItems: "flex-start",
    })
    const colA = new BoxRenderable(r, { flexDirection: "column", gap: 0 })
    const colB = new BoxRenderable(r, { flexDirection: "column", gap: 0 })
    const half = Math.ceil(HELP_LINES.length / 2)
    for (const [keys, desc] of HELP_LINES.slice(0, half)) {
      colA.add(new TextRenderable(r, { content: keyHint(keys, desc, th), selectable: false, wrapMode: "none" }))
    }
    for (const [keys, desc] of HELP_LINES.slice(half)) {
      colB.add(new TextRenderable(r, { content: keyHint(keys, desc, th), selectable: false, wrapMode: "none" }))
    }
    this.idleKeyWrap.add(colA)
    this.idleKeyWrap.add(colB)
    this.idleBox.add(this.idleKeyWrap)
    this.busyText = new TextRenderable(r, { content: "", fg: th.yellow, selectable: false, wrapMode: "none", marginTop: 1 })
    this.idleBox.add(this.busyText)
    root.add(this.idleBox)

    // ── video: 信息卡 + 格式面板 ──
    this.videoBox = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      paddingX: 1,
      paddingTop: 0,
      gap: 1,
      backgroundColor: th.base,
      visible: false,
    })
    // 信息卡: 圆角边框
    const infoCard = new BoxRenderable(r, {
      flexDirection: "column",
      marginLeft: 1,
      marginRight: 1,
      paddingX: 1,
      paddingTop: 0,
      paddingBottom: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.crust,
    })
    this.vInfoText = new TextRenderable(r, { content: "", fg: th.text, selectable: false, wrapMode: "none" })
    infoCard.add(this.vInfoText)
    this.videoBox.add(infoCard)
    // 格式面板: 边框
    const fmtPanel = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      marginLeft: 1,
      marginRight: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.mantle,
      title: " 清晰度 ",
      titleColor: th.blue,
    })
    this.fmtSelect = new SelectRenderable(r, {
      id: "formats",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 4,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 0,
      marginBottom: 0,
      backgroundColor: th.mantle,
      focusedBackgroundColor: th.mantle,
      textColor: th.text,
      focusedTextColor: th.text,
      selectedTextColor: th.crust,
      selectedBackgroundColor: th.blue,
      descriptionColor: th.overlay,
      selectedDescriptionColor: th.crust,
      wrapSelection: false,
      showScrollIndicator: true,
      showSelectionIndicator: false,
    })
    this.fmtSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      const m = this.menu[index]
      if (m) this.startDownload(m)
    })
    this.fmtSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      const m = this.menu[index]
      if (m) this.saveQuality(m.selector)
    })
    fmtPanel.add(this.fmtSelect)
    this.videoBox.add(fmtPanel)
    this.fmtHint = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", marginLeft: 2 })
    this.videoBox.add(this.fmtHint)
    root.add(this.videoBox)

    // ── list: 多P / 合集 ──
    this.listBox = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      paddingX: 1,
      paddingTop: 0,
      backgroundColor: th.base,
      visible: false,
    })
    const listPanel = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      marginLeft: 1,
      marginRight: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.mantle,
      title: " 分 P 列表 ",
      titleColor: th.blue,
    })
    const listHead = new BoxRenderable(r, { flexDirection: "row", justifyContent: "space-between", marginLeft: 1, marginRight: 1, marginBottom: 0 })
    this.lTitleText = new TextRenderable(r, { content: "", fg: th.text, selectable: false, flexShrink: 1, wrapMode: "none" })
    listHead.add(this.lTitleText)
    this.lHintText = new TextRenderable(r, { content: "", fg: th.subtext, selectable: false, wrapMode: "none" })
    listHead.add(this.lHintText)
    listPanel.add(listHead)
    this.entriesBox = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      flexBasis: 0,
      marginLeft: 1,
      marginRight: 1,
      stickyScroll: false,
      scrollbarOptions: { trackOptions: { foregroundColor: th.surface1, backgroundColor: th.mantle } },
      rootOptions: { backgroundColor: th.mantle },
      contentOptions: { backgroundColor: th.mantle },
    })
    listPanel.add(this.entriesBox)
    listPanel.add(
      new TextRenderable(r, {
        content: t`${fg(th.overlay)("↑↓/jk 移动 · 空格 勾选 · a 全选/清空 · Enter 单P · d 下载 · Esc 返回")}`,
        selectable: false,
        wrapMode: "none",
        marginLeft: 1,
      }),
    )
    this.listBox.add(listPanel)
    root.add(this.listBox)

    // ── downloading ──
    this.dlBox = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      paddingX: 1,
      paddingTop: 0,
      backgroundColor: th.base,
      visible: false,
    })
    const dlPanel = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      marginLeft: 1,
      marginRight: 1,
      gap: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.crust,
      title: " 下载 ",
      titleColor: th.green,
    })
    this.dlName = new TextRenderable(r, { content: "", fg: th.text, selectable: false, wrapMode: "none", marginLeft: 1, marginRight: 1 })
    dlPanel.add(this.dlName)
    this.dlBar = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", marginLeft: 1, marginRight: 1, marginTop: 0 })
    dlPanel.add(this.dlBar)
    this.dlMeta = new TextRenderable(r, { content: "", fg: th.subtext, selectable: false, wrapMode: "none", marginLeft: 1, marginRight: 1 })
    dlPanel.add(this.dlMeta)
    this.dlStatus = new TextRenderable(r, { content: "", fg: th.lavender, selectable: false, wrapMode: "none", marginLeft: 1, marginRight: 1 })
    dlPanel.add(this.dlStatus)
    // 日志子面板
    const logWrap = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 0,
      border: true,
      borderStyle: "single",
      borderColor: th.surface0,
      backgroundColor: th.crust,
      title: " yt-dlp ",
      titleColor: th.overlay,
    })
    this.logBox = new ScrollBoxRenderable(r, {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 3,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollbarOptions: { trackOptions: { foregroundColor: th.surface1, backgroundColor: th.crust } },
      rootOptions: { backgroundColor: th.crust },
      contentOptions: { backgroundColor: th.crust },
    })
    logWrap.add(this.logBox)
    dlPanel.add(logWrap)
    dlPanel.add(new TextRenderable(r, { content: t`${fg(th.overlay)("  c 取消下载")}`, selectable: false, wrapMode: "none", marginLeft: 1 }))
    this.dlBox.add(dlPanel)
    root.add(this.dlBox)

    // ── done / error ──
    this.resultBox = new BoxRenderable(r, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      alignItems: "center",
      justifyContent: "center",
      paddingX: 2,
      paddingTop: 1,
      gap: 1,
      backgroundColor: th.base,
      visible: false,
    })
    const resultCard = new BoxRenderable(r, {
      flexDirection: "column",
      width: "80%",
      minWidth: 50,
      padding: 1,
      gap: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: th.surface0,
      backgroundColor: th.crust,
    })
    this.resultTitle = new TextRenderable(r, { content: "", fg: th.green, selectable: false, wrapMode: "none" })
    resultCard.add(this.resultTitle)
    this.resultBody = new TextRenderable(r, { content: "", fg: th.text, selectable: false })
    resultCard.add(this.resultBody)
    resultCard.add(
      new TextRenderable(r, {
        content: t`${keycap("Enter", th)}${fg(th.overlay)("/")} ${keycap("Esc", th)} ${fg(th.subtext)("返回")}${fg(th.overlay)("   ")}${keycap("o", th)} ${fg(th.subtext)("打开目录")}${fg(th.overlay)("   ")}${keycap("n", th)} ${fg(th.subtext)("新链接")}${fg(th.overlay)("   ")}${keycap("q", th)} ${fg(th.subtext)("退出")}`,
        selectable: false,
        wrapMode: "none",
      }),
    )
    this.resultBox.add(resultCard)
    root.add(this.resultBox)

    // ── 底栏 ──
    const footer = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: th.mantle,
    })
    this.statusBar = new TextRenderable(r, { content: "", fg: th.subtext, selectable: false, wrapMode: "none", flexShrink: 1 })
    footer.add(this.statusBar)
    this.msgBar = new TextRenderable(r, { content: "", fg: th.yellow, selectable: false, wrapMode: "none", flexShrink: 1 })
    footer.add(this.msgBar)
    root.add(footer)

    // ── 目录设置弹层 (居中) ──
    this.dirOverlay = new BoxRenderable(r, {
      position: "absolute",
      top: "30%",
      left: "20%",
      width: "60%",
      minWidth: 50,
      flexDirection: "column",
      gap: 1,
      padding: 1,
      backgroundColor: th.mantle,
      border: true,
      borderStyle: "rounded",
      borderColor: th.blue,
      title: ` ${ICON.folder} 下载目录 `,
      titleColor: th.blue,
      titleAlignment: "center",
      zIndex: 200,
      visible: false,
    })
    this.dirOverlay.add(new TextRenderable(r, {
      content: t`${fg(th.subtext)("输入新目录路径")}${fg(th.overlay)("  ·  ")}${keycap("Enter", th)} ${fg(th.subtext)("保存")}${fg(th.overlay)("  ")}${keycap("Esc", th)} ${fg(th.subtext)("取消")}`,
      selectable: false,
      wrapMode: "none",
    }))
    this.dirInput = new InputRenderable(r, {
      id: "dir",
      value: this.outDir,
      backgroundColor: th.surface0,
      focusedBackgroundColor: th.surface1,
      textColor: th.text,
      cursorColor: th.blue,
    })
    this.dirInput.on(InputRenderableEvents.ENTER, (v) => this.saveDir(v))
    this.dirOverlay.add(this.dirInput)
    root.add(this.dirOverlay)

    r.root.add(root)
  }

  /** 渐变饰条: 用主题 grad 三色铺满一行 */
  private makeGradientLine(): StyledText {
    const th = this.theme
    const w = this.r.width
    const seg = Math.max(1, Math.floor(w / 3))
    const rest = w - seg * 3
    return t`${fg(th.grad[0])("━".repeat(seg))}${fg(th.grad[1])("━".repeat(seg))}${fg(th.grad[2])("━".repeat(seg + rest))}`
  }

  /** 品牌 banner: 三行等宽, 中行文字精确居中 + 波浪流光 */
  private makeBanner(): StyledText {
    const th = this.theme
    const inner = 36 // 框内宽度
    const glyphs = Array.from("◆  b i l i - t u i  ◆")
    const labelW = displayWidth(glyphs.join(""))
    const left = Math.max(0, Math.floor((inner - labelW) / 2))
    const right = Math.max(0, inner - labelW - left)
    // 流光色环: 主题蓝 → 天蓝 → 薰衣草 → 紫 → 粉 → 青
    const cycle = [th.blue, th.sapphire, th.lavender, th.mauve, th.pink, th.sky]
    const chunks: TextChunk[] = [
      fg(th.blue)(`╭${"━".repeat(inner)}╮`),
      fg(th.blue)(`\n┃${" ".repeat(left)}`),
    ]
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]
      if (g === " ") {
        chunks.push(fg(th.blue)(g))
        continue
      }
      const p = (((i - this.bannerPhase) % cycle.length) + cycle.length) % cycle.length
      chunks.push(fg(cycle[p])(g))
    }
    chunks.push(fg(th.blue)(`${" ".repeat(right)}┃`))
    chunks.push(fg(th.blue)(`\n╰${"━".repeat(inner)}╯`))
    return new StyledText(chunks)
  }

  /** 启动 banner 流光: 每 110ms 推进相位并重绘 */
  private startBanner(): void {
    if (this.bannerTimer) return
    this.bannerTimer = setInterval(() => {
      if (this.destroyed) {
        this.stopBanner()
        return
      }
      this.bannerPhase = (this.bannerPhase + 1) % 12
      this.idleBanner.content = this.makeBanner()
      this.r.requestRender()
    }, 110)
  }

  private stopBanner(): void {
    if (this.bannerTimer) {
      clearInterval(this.bannerTimer)
      this.bannerTimer = undefined
    }
  }

  // ======================================================== 主题

  /** 切主题: 保存状态 → 销毁树 → 重建 → 按当前阶段恢复视图 */
  private applyTheme(name: ThemeName): void {
    const next = THEMES[name]
    if (!next || name === this.themeName) return
    const stage = this.stage
    const url = this.urlInput.value
    const dirVal = this.dirInput.value
    const busyBase = this.busyBase
    const prog = this.prog
    const logText = this.logText
    const resTitle = this.resultTitle.content
    const resBody = this.resultBody.content

    this.stopSpinner()
    this.stopBanner()
    for (const ch of this.r.root.getChildren()) ch.destroyRecursively()
    this.themeName = name
    this.theme = next
    this.logNodes = []
    this.build()
    this.urlInput.value = url
    this.dirInput.value = dirVal
    this.prog = prog
    this.logText = logText
    this.resultTitle.content = resTitle
    this.resultBody.content = resBody

    // 按原阶段恢复视图
    switch (stage) {
      case "video":
        this.buildVideoMenu()
        this.setStage("video")
        break
      case "list":
        this.renderEntries()
        this.setStage("list")
        break
      case "downloading": {
        this.dlName.content = prog.status ? t`${bold(fg(this.theme.text)(truncate(prog.status, 96)))}` : t``
        this.dlBar.content = this.renderBar(prog.percent ?? 0)
        this.dlMeta.content = t`${fg(this.theme.subtext)(`保存到: ${this.outDir}`)}`
        this.dlStatus.content = t`${fg(this.theme.lavender)(truncate(prog.status, 110))}`
        for (const line of logText) this.appendLogLine(line)
        this.setStage("downloading")
        break
      }
      case "done":
      case "error":
        this.setStage(stage)
        break
      case "probing":
        this.setStage("probing")
        if (busyBase) this.startSpinner(busyBase)
        break
      default:
        this.setStage("idle")
    }
    this.renderStatus()
    this.flash(`主题: ${THEME_LABEL[name]}`)
  }

  private cycleTheme(): void {
    const cur = THEME_ORDER.indexOf(this.themeName)
    const next = THEME_ORDER[(cur + 1) % THEME_ORDER.length]
    this.applyTheme(next)
    this.cfg.theme = next
    saveConfig(this.cfg)
  }

  // ======================================================== 阶段

  private stageBoxes(): BoxRenderable[] {
    return [this.idleBox, this.videoBox, this.listBox, this.dlBox, this.resultBox]
  }

  private setStage(s: Stage): void {
    this.stage = s
    for (const b of this.stageBoxes()) b.visible = false
    const hints: Record<Stage, StyledText> = {
      idle: t`${fg(this.theme.overlay)("等待链接")}`,
      probing: t`${fg(this.theme.yellow)("解析中…")}`,
      video: this.mode === "video" ? t`${fg(this.theme.blue)("选择视频画质")}` : t`${fg(this.theme.mauve)("选择音乐音质")}`,
      list: t`${fg(this.theme.blue)("选择分 P")}`,
      downloading: t`${fg(this.theme.green)("下载中")}`,
      done: t`${fg(this.theme.green)("下载完成")}`,
      error: t`${fg(this.theme.red)("出错了")}`,
    }
    this.stageHint.content = hints[s]
    switch (s) {
      case "idle":
      case "probing":
        this.idleBox.visible = true
        this.urlInput.focus()
        break
      case "video":
        this.videoBox.visible = true
        this.fmtSelect.focus()
        break
      case "list":
        this.listBox.visible = true
        break
      case "downloading":
        this.dlBox.visible = true
        break
      case "done":
      case "error":
        this.resultBox.visible = true
        break
    }
    // banner 流光只在欢迎屏可见时运行
    if (s === "idle" || s === "probing") this.startBanner()
    else this.stopBanner()
    this.renderStatus()
  }

  private renderTabs(): void {
    const th = this.theme
    const vid = this.mode === "video"
    // 激活标签 = 实心 pill (高对比), 非激活 = 暗底
    this.vTabText.fg = vid ? th.crust : th.subtext
    this.vTabText.bg = vid ? th.blue : th.surface0
    this.aTabText.fg = vid ? th.subtext : th.crust
    this.aTabText.bg = vid ? th.surface0 : th.mauve
  }

  private renderStatus(): void {
    const th = this.theme
    this.statusBar.content = t`${chip(THEME_LABEL[this.themeName], th, { fg: th.lavender })}${fg(th.overlay)("  ")}${chip(this.mode === "video" ? `${ICON.video} 视频` : `${ICON.music} 音乐`, th, { fg: this.mode === "video" ? th.blue : th.mauve })}${fg(th.overlay)("  ")}${chip(ICON.folder, th, { fg: th.subtext })}${fg(th.subtext)(truncate(this.outDir, 50))}`
  }

  private flash(msg: string, ok = false): void {
    this.msgBar.content = t`${fg(ok ? this.theme.green : this.theme.yellow)(truncate(msg, 90))}`
    clearTimeout(this.msgTimer)
    this.msgTimer = setTimeout(() => {
      if (this.destroyed) return
      this.msgBar.content = t`${fg(this.theme.text)("")}`
      this.msgTimer = undefined
    }, 5000)
  }

  // ======================================================== 探测

  /** 启动 spinner: 每 100ms 推进一帧并请求重绘 */
  private startSpinner(base: string): void {
    this.busyBase = base
    this.stopSpinner()
    this.spinnerIdx = 0
    this.renderBusy()
    this.spinnerTimer = setInterval(() => {
      if (this.destroyed) {
        this.stopSpinner()
        return
      }
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length
      this.renderBusy()
      this.r.requestRender()
    }, 100)
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  private renderBusy(): void {
    if (!this.busyBase) {
      this.busyText.content = t``
      return
    }
    const frame = SPINNER[this.spinnerIdx % SPINNER.length]
    this.busyText.content = t`${fg(this.theme.cyan)(frame)} ${fg(this.theme.yellow)(this.busyBase)}`
  }

  /** 结束 busy 状态: 停止 spinner 并清空提示 */
  private clearBusy(): void {
    this.stopSpinner()
    this.busyBase = ""
    this.busyText.content = t``
  }

  private startProbe(raw: string): void {
    const u = raw.trim()
    if (!u) {
      this.flash("链接是空的")
      return
    }
    if (!biliHostOk(u)) {
      this.flash("只支持哔哩哔哩链接 (bilibili.com / b23.tv)")
      return
    }
    this.listInfo = null
    this.videoInfo = null
    this.setStage("probing")
    this.startSpinner(`正在解析 ${truncate(u, 72)} …`)
    probe(u, this.cookiesFile)
      .then((p) => {
        if (this.destroyed || this.stage !== "probing") return
        this.onProbe(p, u)
      })
      .catch((e: Error) => {
        if (!this.destroyed) this.probeError(e)
      })
  }

  private probeError(e: Error): void {
    if (this.destroyed) return
    this.clearBusy()
    this.setStage("idle")
    this.urlInput.focus()
    this.flash(`解析失败: ${e.message}`)
  }

  private onProbe(p: Probe, url: string): void {
    this.clearBusy()
    if (p.kind === "list") {
      this.listInfo = p
      this.showList(p)
      return
    }
    if (p.formats.length > 0) {
      this.openVideo(p, url)
      return
    }
    // flat 探测没带 formats → 完整探测一次
    this.setStage("probing")
    this.startSpinner("正在获取清晰度列表…")
    probeFull(url, this.cookiesFile)
      .then((full) => {
        if (this.destroyed || this.stage !== "probing") return
        this.clearBusy()
        if (full.kind === "video" && full.formats.length) this.openVideo(full, url)
        else if (full.kind === "list") {
          this.listInfo = full
          this.showList(full)
        } else {
          this.setStage("idle")
          this.flash("没有可用格式 (可能是会员/付费限定内容)")
        }
      })
      .catch((e: Error) => {
        if (!this.destroyed) this.probeError(e)
      })
  }

  private openVideo(info: VideoInfo, url: string): void {
    this.videoInfo = info
    this.videoEntryUrl = url
    this.buildVideoMenu()
    this.setStage("video")
  }

  private buildVideoMenu(): void {
    const info = this.videoInfo
    const th = this.theme
    if (!info) return
    if (this.mode === "video" && !info.hasVideo) this.mode = "audio"
    if (this.mode === "audio" && !info.hasAudio && info.hasVideo) this.mode = "video"
    this.menu = this.mode === "video" ? videoMenu(info) : audioMenu(info)
    this.fmtSelect.options = this.menu.map((m) => ({ name: m.name, description: m.desc, value: m.selector }))
    const saved = (this.mode === "video" ? this.cfg.quality_id : this.cfg.audio_quality_id) as string | undefined
    let idx = saved ? this.menu.findIndex((m) => m.selector === saved) : -1
    if (idx < 0) idx = 0
    this.fmtSelect.selectedIndex = idx
    const dur = info.duration ? fmtDuration(info.duration) : "?"
    // 信息卡: 标题 + chips (时长 / UP)
    const durChip = chip(`${ICON.clock} ${dur}`, th, { fg: th.cyan })
    const upChip: TextChunk | string = info.uploader ? chip(`UP ${truncate(info.uploader, 20)}`, th, { fg: th.peach }) : ""
    const upSep: TextChunk | string = info.uploader ? fg(th.overlay)("  ") : ""
    this.vInfoText.content = t`${bold(fg(th.text)(truncate(info.title, 80)))}\n${fg(th.overlay)("  ")}${durChip}${upSep}${upChip}`
    this.fmtHint.content = t`${fg(th.overlay)("  ")}${keycap("↑↓", th)}${fg(th.subtext)(" 选择  ")}${keycap("Enter", th)}${fg(th.subtext)(" 下载  ")}${keycap("v", th)}/${keycap("a", th)}${fg(th.subtext)(" 切换  ")}${keycap("Esc", th)}${fg(th.subtext)(" 返回")}`
    this.renderTabs()
  }

  private switchMode(m: Mode): void {
    if (!this.videoInfo) return
    this.mode = m
    this.buildVideoMenu()
    this.setStage("video")
  }

  private saveQuality(selector: string): void {
    if (this.mode === "video") this.cfg.quality_id = selector
    else this.cfg.audio_quality_id = selector
    saveConfig(this.cfg)
  }

  // ======================================================== 列表

  private showList(info: ListInfo): void {
    this.selIdx = 0
    this.selected = new Set()
    this.renderEntries()
    this.setStage("list")
  }

  private renderEntries(): void {
    const info = this.listInfo
    if (!info) return
    const th = this.theme
    this.lTitleText.content = t`${bold(fg(th.text)(truncate(info.title, 60)))}`
    this.lHintText.content = t`${fg(th.subtext)(`已选 ${this.selected.size} / 共 ${info.entries.length}`)}`
    for (const row of this.entryBoxes) this.entriesBox.remove(row)
    this.entryBoxes = []
    info.entries.forEach((e, i) => {
      const isSel = i === this.selIdx
      const checked = this.selected.has(i)
      const zebra = i % 2 === 0 ? th.mantle : th.crust
      const box = new BoxRenderable(this.r, {
        id: `p${i}`,
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: isSel ? th.surface1 : zebra,
        onMouseDown: () => {
          this.selIdx = i
          this.togglePick(i)
        },
      })
      // 复选标记
      box.add(
        new TextRenderable(this.r, {
          content: checked ? t`${fg(th.green)("▣")}` : t`${fg(th.overlay)("□")}`,
          selectable: false,
          wrapMode: "none",
        }),
      )
      // P 编号 (右对齐)
      const pLabel = `P${e.index ?? i + 1}`
      box.add(
        new TextRenderable(this.r, {
          content: t`${fg(isSel ? th.blue : th.overlay)(padStartW(pLabel, 5))} `,
          selectable: false,
          wrapMode: "none",
        }),
      )
      // 标题
      box.add(
        new TextRenderable(this.r, {
          content: isSel ? t`${bold(fg(th.text)(truncate(e.title, 76)))}` : t`${fg(th.text)(truncate(e.title, 76))}`,
          selectable: false,
          flexShrink: 1,
          wrapMode: "none",
        }),
      )
      this.entriesBox.add(box)
      this.entryBoxes.push(box)
    })
  }

  private togglePick(i: number): void {
    if (this.selected.has(i)) this.selected.delete(i)
    else this.selected.add(i)
    this.renderEntries()
  }

  private moveSel(delta: number): void {
    const n = this.listInfo?.entries.length ?? 0
    if (!n) return
    this.selIdx = Math.max(0, Math.min(n - 1, this.selIdx + delta))
    this.renderEntries()
    const row = this.entryBoxes[this.selIdx]
    if (row?.id) this.entriesBox.scrollChildIntoView(row.id)
  }

  private selectAll(): void {
    const info = this.listInfo
    if (!info) return
    if (this.selected.size === info.entries.length) this.selected = new Set()
    else this.selected = new Set(info.entries.map((_, i) => i))
    this.renderEntries()
  }

  private enterEntry(): void {
    const info = this.listInfo
    const e = info?.entries[this.selIdx]
    if (!info || !e) return
    this.setStage("probing")
    this.startSpinner(`正在解析 P${e.index ?? this.selIdx + 1} 的清晰度…`)
    probeFull(e.url, this.cookiesFile)
      .then((p) => {
        if (this.destroyed || this.stage !== "probing") return
        this.clearBusy()
        if (p.kind === "video") this.openVideo(p, e.url)
        else {
          this.setStage("list")
          this.flash("该分 P 无法解析为单个视频")
        }
      })
      .catch((err: Error) => {
        if (!this.destroyed) this.probeError(err)
      })
  }

  // ======================================================== 下载

  private startDownload(m: MenuItem): void {
    const url = this.videoEntryUrl
    if (!url) {
      this.flash("没有可下载的链接")
      return
    }
    this.saveQuality(m.selector)
    const title = this.videoInfo?.title ?? url
    this.beginJob({ url, outDir: this.outDir, selector: m.selector, asPlaylist: false, cookies: this.cookiesFile }, `${title}  [${m.name}]`)
  }

  private startListDownload(): void {
    const info = this.listInfo
    if (!info || !info.entries.length) return
    const picks = this.selected.size ? [...this.selected].sort((a, b) => a - b) : [this.selIdx]
    const selector = this.mode === "audio" ? "ba/b" : "bv*+ba/b"
    const items = picks.map((i) => info.entries[i]?.index ?? i + 1).join(",")
    this.beginJob(
      { url: info.webpageUrl, outDir: this.outDir, selector, asPlaylist: true, items, cookies: this.cookiesFile },
      `${info.title}  [合集 ${picks.length} P · 最佳${this.mode === "audio" ? "音质" : "画质"}]`,
    )
  }

  private beginJob(spec: DownloadSpec, label: string): void {
    if (this.job) {
      this.flash("已有任务在下载, 先按 c 取消")
      return
    }
    for (const n of this.logNodes) this.logBox.remove(n)
    this.logNodes = []
    this.logText = []
    this.prog = { status: "启动中…" }
    this.dlName.content = t`${bold(fg(this.theme.text)(truncate(label, 96)))}`
    this.dlBar.content = this.renderBar(0)
    this.dlMeta.content = t`${fg(this.theme.subtext)(`保存到: ${this.outDir}`)}`
    this.dlStatus.content = t`${fg(this.theme.lavender)("启动 yt-dlp…")}`
    this.setStage("downloading")
    const job = new DownloadJob(
      spec,
      (p) => this.onProgress(p),
      (line) => this.onLog(line),
    )
    this.job = job
    job.done
      .then((res) => {
        if (this.destroyed || this.job !== job) return
        this.job = null
        if (res.ok) this.showResult("done", res.files, label)
        else this.showResult("error", [], res.error || "未知错误", label)
      })
      .catch((e: Error) => {
        if (this.destroyed || this.job !== job) return
        this.job = null
        this.showResult("error", [], e.message, label)
      })
  }

  private onProgress(p: Progress): void {
    if (this.destroyed) return
    this.prog = p
    if (typeof p.percent === "number") this.dlBar.content = this.renderBar(p.percent)
    const bits: string[] = []
    if (p.percent !== undefined) bits.push(`${p.percent.toFixed(1)}%`)
    if (p.totalText) bits.push(p.totalText)
    if (p.speedText) bits.push(`速度 ${p.speedText}`)
    if (p.etaText) bits.push(`剩余 ${p.etaText}`)
    this.dlMeta.content = t`${fg(this.theme.subtext)(bits.join("  ·  ") || this.outDir)}`
    if (p.status) this.dlStatus.content = t`${fg(this.theme.lavender)(truncate(p.status, 110))}`
    this.r.requestRender()
  }

  private renderBar(pct: number): StyledText {
    return progressBar(pct, this.theme, this.r.width - 6)
  }

  private onLog(line: string): void {
    if (this.destroyed) return
    this.logText.push(line)
    while (this.logText.length > MAX_LOG_LINES) this.logText.shift()
    this.appendLogLine(line)
  }

  private appendLogLine(line: string): void {
    const node = new TextRenderable(this.r, {
      content: t`${fg(this.theme.subtext)(truncate(line, 200))}`,
      selectable: false,
      wrapMode: "none",
    })
    this.logBox.add(node)
    this.logNodes.push(node)
    while (this.logNodes.length > MAX_LOG_LINES) {
      const old = this.logNodes.shift()
      if (old) this.logBox.remove(old)
    }
  }

  private cancelJob(): void {
    if (!this.job) {
      this.flash("当前没有进行中的任务")
      return
    }
    this.job.kill()
    this.dlStatus.content = t`${fg(this.theme.red)("正在取消…")}`
  }

  // ======================================================== 结果

  private showResult(kind: "done" | "error", files: string[], body: string, label = ""): void {
    if (kind === "done") {
      this.resultTitle.content = t`${bold(fg(this.theme.green)("下载完成"))}${fg(this.theme.overlay)(`  ·  ${files.length} 个文件`)}`
      const lines = files.length ? files : [label]
      this.resultBody.content = t`${fg(this.theme.text)(lines.map((f) => `  ${truncate(f.split("/").pop() || f, 100)}`).join("\n"))}`
      this.lastResultFiles = files
    } else {
      this.resultTitle.content = t`${bold(fg(this.theme.red)("下载失败"))}`
      this.resultBody.content = t`${fg(this.theme.red)(truncate(body, 2000))}`
      this.lastResultFiles = []
    }
    this.setStage(kind)
    this.flash(kind === "done" ? "下载完成" : "下载失败", kind === "done")
  }
  private lastResultFiles: string[] = []

  /** 完成后返回上一级: 有列表回列表, 有视频回画质页, 否则回 idle */
  private backFromResult(): void {
    if (this.listInfo) {
      this.showList(this.listInfo)
    } else if (this.videoInfo) {
      this.buildVideoMenu()
      this.setStage("video")
    } else {
      this.setStage("idle")
      this.urlInput.focus()
    }
  }

  private openDir(): void {
    const opener = Bun.which("xdg-open") || Bun.which("open")
    if (!opener) {
      this.flash(`打开器不存在, 目录: ${this.outDir}`)
      return
    }
    Bun.spawn([opener, this.outDir])
    this.flash(`已打开 ${this.outDir}`, true)
  }

  // ======================================================== 目录设置

  private showDirOverlay(): void {
    this.dirOverlay.visible = true
    this.dirInput.value = this.outDir
    this.dirInput.focus()
  }

  private hideDirOverlay(): void {
    this.dirOverlay.visible = false
    this.refocus()
  }

  private saveDir(raw: string): void {
    const d = raw.trim().replace(/^["']|["']$/g, "")
    if (!d) {
      this.hideDirOverlay()
      return
    }
    const abs = d.startsWith("~") ? join(homedir(), d.slice(1) || "") : resolveSafe(d)
    try {
      mkdirSync(abs, { recursive: true })
    } catch {
      this.flash(`无法创建目录: ${abs}`)
      return
    }
    if (!existsSync(abs)) {
      this.flash(`目录不存在: ${abs}`)
      return
    }
    this.outDir = abs
    this.cfg.download_dir = abs
    saveConfig(this.cfg)
    this.dirText.content = abs
    this.renderStatus()
    this.hideDirOverlay()
    this.flash(`下载目录已保存: ${abs}`, true)
  }

  // ======================================================== 按键

  private refocus(): void {
    if (this.stage === "video") this.fmtSelect.focus()
    else this.urlInput.focus()
  }

  private inputActive(): boolean {
    return this.urlInput.focused || this.dirInput.focused
  }

  private handleKey(k: KeyEvent): void {
    const name = k.name
    const seq = k.sequence

    if (name === "tab" && this.stage !== "downloading") {
      if (this.urlInput.focused) {
        this.urlInput.blur()
        if (this.stage === "video") this.fmtSelect.focus()
      } else {
        this.urlInput.focus()
      }
      k.preventDefault()
      return
    }

    // 弹层输入优先: 只处理 Esc
    if (this.dirOverlay.visible) {
      if (name === "escape") {
        this.hideDirOverlay()
        k.preventDefault()
      }
      return
    }

    // URL 栏聚焦时: 输入框自处理全部文本键 (含 s/q/t); 仅 Esc 退回非焦点态
    if (this.inputActive()) {
      if (name === "escape") {
        this.urlInput.blur()
        k.preventDefault()
      }
      return
    }

    // 主题循环: t / T
    if (seq === "t" || seq === "T") {
      this.cycleTheme()
      k.preventDefault()
      return
    }

    // 设置: 任意阶段均可打开目录弹层 (输入框聚焦 / 弹层打开时已被上面的分支拦下)
    if (seq === "s") {
      this.showDirOverlay()
      k.preventDefault()
      return
    }

    switch (name) {
      case "escape":
        this.onEscape()
        k.preventDefault()
        return
      case "return":
      case "linefeed":
        // video 页 Enter 交给焦点中的 Select (全局 preventDefault 会吞掉它)
        if (this.stage !== "video") {
          this.onEnter()
          k.preventDefault()
        }
        return
    }

    // Select 自己处理 ↑↓/jk/enter; 这里只处理全局与各视图差异键
    if (this.stage === "downloading") {
      if (seq === "c") {
        this.cancelJob()
        k.preventDefault()
      }
      return
    }
    if (this.stage === "video") {
      if (seq === "v") {
        this.switchMode("video")
        k.preventDefault()
        return
      }
      if (seq === "a") {
        this.switchMode("audio")
        k.preventDefault()
        return
      }
      if (seq === "q") {
        this.quit()
        k.preventDefault()
        return
      }
      return
    }
    if (this.stage === "list") {
      if (seq === "k" || name === "up") {
        this.moveSel(-1)
        k.preventDefault()
        return
      }
      if (seq === "j" || name === "down") {
        this.moveSel(1)
        k.preventDefault()
        return
      }
      if (name === "space") {
        this.togglePick(this.selIdx)
        k.preventDefault()
        return
      }
      if (seq === "a") {
        this.selectAll()
        k.preventDefault()
        return
      }
      if (seq === "d") {
        this.startListDownload()
        k.preventDefault()
        return
      }
      if (seq === "q") {
        this.quit()
        k.preventDefault()
        return
      }
      return
    }
    if (this.stage === "done" || this.stage === "error") {
      if (seq === "o") {
        this.openDir()
        k.preventDefault()
        return
      }
      if (seq === "n") {
        this.setStage("idle")
        this.urlInput.value = ""
        this.urlInput.focus()
        k.preventDefault()
        return
      }
      if (seq === "q") {
        this.quit()
        k.preventDefault()
        return
      }
      return
    }
    // idle
    if (seq === "q") {
      this.quit()
      k.preventDefault()
    }
  }

  private onEscape(): void {
    switch (this.stage) {
      case "video":
        if (this.listInfo) this.showList(this.listInfo)
        else {
          this.videoInfo = null
          this.setStage("idle")
        }
        break
      case "list":
        this.listInfo = null
        this.setStage("idle")
        break
      case "done":
      case "error":
        this.backFromResult()
        break
      case "downloading":
        this.flash("下载中, 按 c 取消")
        break
      default:
        this.quit()
    }
  }

  private onEnter(): void {
    if (this.stage === "done" || this.stage === "error") {
      this.backFromResult()
      return
    }
    if (this.stage === "idle") {
      this.startProbe(this.urlInput.value)
      return
    }
    if (this.stage === "list") {
      this.enterEntry()
      return
    }
    // video 阶段 Enter 已由 Select 处理
  }

  /** 命令行直接传链接时跳过手动输入 */
  startWithUrl(url: string): void {
    this.urlInput.value = url
    this.startProbe(url)
  }

  private quit(): void {
    this.destroyed = true
    this.stopSpinner()
    this.stopBanner()
    if (this.job) this.job.kill()
    this.r.destroy()
  }
}

function resolveSafe(d: string): string {
  return d.startsWith("/") ? d : join(process.cwd(), d)
}
