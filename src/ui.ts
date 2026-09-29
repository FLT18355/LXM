/**
 * OpenTUI 界面 — Catppuccin 四口味主题音乐播放器
 *
 * 列表区五视图 tab: 播放列表 / 收藏 / 歌单 / 设置 / 队列 (1/2/3/4/5 或鼠标点击切换)
 * 歌单 tab 内二级: 歌单列表 → 某歌单详情 (Enter 进入, Esc 返回)
 * 歌单详情内 a 进入"加歌选歌"模式 (Enter 加入, Esc 返回)
 * 设置 tab: 主题 / 音量 / 倍速 / 歌词延迟 / 睡眠 / 音乐目录 / 排序 / 缓存 / 版本
 * 歌曲编辑: R 重命名歌曲文件 (弹层输入) · D 删除歌曲文件 (确认弹层) — 动的是磁盘文件
 * 覆盖层: 帮助 h / 信息 i / 排序 o / 统计 S / 目录管理 / 歌单命名弹层 / 删除确认 / 通知浮层
 *
 * ── 维护约定 ──
 * - 装饰动效走独立 animTick (30fps, 待机降频), 只重画 LOGO/等化器/彩虹条/频谱/进度条/tab/通知;
 *   列表行的底色与文本由 updatePlaylist 独占写入, animTick 绝不碰, 否则两份真相源互踩会闪。
 * - 跑马灯由 tick 的 advanceMarquee 推进, 相位锚定"最近一次选中变化", 换行时从 0 平滑重启。
 * - applyTheme 是全树重建: 任何需要跨重建存活的 UI 状态都要写进备份/恢复清单。
 * - 通知浮层节点必须懒创建 (在隐藏的 absolute 盒子里预建的文本节点之后不再渲染)。
 * 渐变工具在文件头 mixHex/paletteAt/pulse; 入口 index.ts 调 startAnimLoop/stopAnimLoop。
 */
import {
  BoxRenderable,
  StyledText,
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
  type TextChunk,
} from "@opentui/core"
import { existsSync } from "fs"
import { resolve } from "path"
import { Player, REPEAT_CYCLE, SORT_MODES, SORT_LABEL, type SortMode } from "./player"
import { titleOf } from "./scanner"
import { THEMES, THEME_ORDER, THEME_LABEL, parseThemeName, type Theme, type ThemeName } from "./theme"
import { loadConfig, saveConfig, musicDirsFromConfig, saveMusicDirs } from "./config"
import { CACHE_DIR, clearCache, ensureCacheDir } from "./cache"
import { computeStats, fmtDuration, fmtAgo, type StatsBucket } from "./stats"
import type { MpvEvent } from "./mpv"
import { VERSION } from "./version"

const REPEAT_LABEL: Record<string, string> = {
  OFF: "不循环",
  ALL: "列表循环",
  ONE: "单曲循环",
}

// 视图 tab: 顺序即快捷键 1/2/3/4/5
// 注意: settings 必须保持在 index 3 (= 键 4), 队列视图排在最后 (键 5) — 兼容既有按键习惯与测试
export type ViewName = "list" | "fav" | "pl" | "settings" | "queue"
const TAB_KEYS: ViewName[] = ["list", "fav", "pl", "settings", "queue"]
const TAB_LABELS = [
  " \uF03A 播放列表 ",
  " \uF004 收藏 ",
  " \uF1C5 歌单 ",
  " \uF013 设置 ",
  " \uF0CA 队列 ",
]

const EQ_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆"]
/** 频谱/条形图用的 8 级块字符 */
const BLOCK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
/** 设置视图行数 (主题/音量/倍速/歌词延迟/睡眠/音乐目录/排序/缓存/版本) */
const SETTING_ROW_COUNT = 9
/** 通知浮层: 最多同屏条数 + 单条存活毫秒 */
const TOAST_MAX = 3
const TOAST_MS = 2100

/** 动效帧间隔: 播放/全屏歌词时 30fps, 待机时降频省电 (渐变本身极慢, 5fps 也平滑) */
const ANIM_FAST_MS = 33
const ANIM_IDLE_MS = 180

/** 彩虹条色板: 主题色的固定顺序 (每帧按主题取值 → 换主题不变调色逻辑) */
const RAINBOW_KEYS = ["sky", "lavender", "pink", "peach", "yellow", "green"] as const

// ── 混色工具 (动效每帧插值出 hex, 直接喂给 fg()/backgroundColor) ──

/** 线性混色 (hex 三/六位): t=0 → a, t=1 → b; 用于渐变/淡出/呼吸插值 */
function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a
  if (t >= 1) return b
  let hex = "#"
  for (let i = 0; i < 3; i++) {
    const ca = Number.parseInt(a.length === 4 ? a[1 + i] + a[1 + i] : a.slice(1 + i * 2, 3 + i * 2), 16) || 0
    const cb = Number.parseInt(b.length === 4 ? b[1 + i] + b[1 + i] : b.slice(1 + i * 2, 3 + i * 2), 16) || 0
    hex += Math.round(ca + (cb - ca) * t).toString(16).padStart(2, "0")
  }
  return hex
}

/** 循环色板采样: u 自动取模, 相邻色之间线性插值 → 连续无级渐变 */
function paletteAt(pal: readonly string[], u: number): string {
  const n = pal.length
  const x = (((u % 1) + 1) % 1) * n
  const i = Math.floor(x)
  return mixHex(pal[i % n], pal[(i + 1) % n], x - i)
}

/** 0..1 的圆滑脉冲 (周期 periodMs, 相位 0 时取 0) */
function pulse(now: number, periodMs: number): number {
  return 0.5 - 0.5 * Math.cos((now / periodMs) * Math.PI * 2)
}

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

/** 字符串显示宽度 (CJK 宽字符计 2) */
function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    w += code > 0x2e7f && (code <= 0xa4cf || code >= 0xac00) ? 2 : 1
  }
  return w
}

/**
 * 超长文本行内滚动 (marquee): 宽度未超限原样返回; 超出时按 tick 左右来回滚动,
 * 头尾各停顿 4 帧. off 为字符偏移 (CJK 按字符计, clipWidth 兜底防溢出).
 */
function scrollText(text: string, maxw: number, tick: number): string {
  if (maxw <= 0) return ""
  if (displayWidth(text) <= maxw) return text
  const chars = [...text]
  // 可滚动的字符步数: 估算可视字符数, 保守取宽/2, 至少滚 1 步
  const steps = Math.max(1, chars.length - Math.floor(maxw / 2))
  const period = steps + 8 // 滚动 + 两端停顿
  const phase = tick % (period * 2)
  let off: number
  if (phase < period) off = Math.min(steps, Math.max(0, phase - 4))
  else off = Math.min(steps, Math.max(0, steps - (phase - period - 4)))
  if (off >= chars.length) off = 0
  return clipWidth(chars.slice(off).join(""), maxw)
}

/** 文件扩展名 (含点, 小写; 无则空串) */
function extOf(p: string): string {
  const i = p.lastIndexOf(".")
  if (i <= 0) return ""
  const ext = p.slice(i).toLowerCase()
  return ext.length > 1 && ext.length <= 5 ? ext : ""
}

/** 列表行右侧元信息: 扩展名 + 时长 (秒; 未知显示 --) */
function metaOf(path: string, dur: number): string {
  return `${extOf(path)}  ${dur > 0 ? `${Math.round(dur)}s` : "--"}`
}

/** 音量小条 (单块字符): 0 → ▁, 100+ → █ */
function volGlyph(v: number): string {
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const i = Math.max(0, Math.min(chars.length - 1, Math.round((v / 100) * (chars.length - 1))))
  return chars[i]
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
  showInfo = false
  private infoOverlay!: BoxRenderable
  private infoLines: TextRenderable[] = []
  private tickCount = 0
  private lastLyricIdx = -1
  private lastPlTitle = ""

  // 列表区视图 tab: 播放列表 / 收藏 / 歌单 / 设置 / 队列
  view: ViewName = "list"
  plLevel: "list" | "detail" = "list" // 歌单 tab 内: 歌单列表 / 某歌单详情
  plPickerMode = false // 歌单详情 a 触发的"加歌选歌"
  plCurrent: string | null = null // 详情/选歌模式的当前歌单名
  private savedListSel = 0 // 进歌单前列表游标, 返回时恢复
  private savedFavSel = 0 // 进设置前收藏游标, 返回时恢复
  private savedQueueSel = 0 // 进队列视图前游标, 返回时恢复
  private dirInput = "" // 设置: 改目录弹层输入缓冲

  // ---------- r-1.0 新增 UI 状态 ----------
  /** 排序菜单 (o 打开): 是否显示 + 光标所在字段 */
  showSort = false
  sortCursor = 0
  /** 统计面板 (S 打开) */
  showStats = false
  /** 音乐目录管理弹层 (设置 → 音乐目录 Enter) */
  showDirManager = false
  dirCursor = 0
  /** 睡眠定时渐弱: 起始音量 + 起始时间 + 是否进行中 */
  private sleepFading = false
  private sleepFadeFrom = 100
  private sleepFadeAt = 0
  /** 通知浮层 (flash 同时推一条) */
  private toasts: Array<{ id: number; text: string; color: string; at: number }> = []
  private toastSeq = 0
  /** 视图切换过渡进度 0..1 */
  private viewAnimT = 1
  /**
   * 跑马灯 (超长标题行内滚动) 稳定化:
   * 相位以"最近一次选中变化"为锚点, 新选中行从 0 开始平滑滚动,
   * 不再复用全局 tickCount (那会让快速上下切换时文字随机跳位 → 闪来闪去)。
   */
  private marqueeAnchor = 0
  private lastMarqueeSel = -1
  /** 当前选中行的跑马灯参数 (由 updatePlaylist 记录, tick 里推进) */
  private selMarquee: { text: string; width: number } | null = null

  // 弹层输入态: "new" 新建歌单 / "rename" 重命名歌单 / "rename-song" 重命名歌曲文件
  //            / "add-dir" 添加音乐目录 / null 不弹 ("set-dir" 为旧版遗留, 保留兼容)
  plDialogMode: "new" | "rename" | "rename-song" | "set-dir" | "add-dir" | null = null
  plDialogValue = ""
  /** 重命名歌曲的目标文件 (开弹层时锁定, 免受 sel 变动影响) */
  pendingSongPath: string | null = null

  // 破坏性操作确认弹层 (删除歌曲): 非 null 时独占按键, Enter/y 确认 · Esc/n 取消
  confirmAction: (() => void) | null = null
  private confirmMessage = ""

  // ---------- 节点引用 ----------
  private eqText!: TextRenderable
  private logoText!: TextRenderable
  private accentText!: TextRenderable
  private headModeText!: TextRenderable
  private headRightText!: TextRenderable
  private nowStatusText!: TextRenderable
  private nowTitleText!: TextRenderable
  private progressText!: TextRenderable
  private timeText!: TextRenderable
  private nowDivider!: TextRenderable
  /** r-1.0: 正在播放卡片里的程序化频谱条 (1 行) */
  private spectrumText!: TextRenderable
  private lyricInner!: BoxRenderable
  private lyricsBox!: BoxRenderable
  private lyricRows: TextRenderable[] = []
  private plBox!: BoxRenderable
  private plTitle!: TextRenderable
  private plDivider!: TextRenderable
  private lastPlDivW = -1
  private plRows: Array<{
    box: BoxRenderable
    lead: TextRenderable
    num: TextRenderable
    text: TextRenderable
    meta: TextRenderable
  }> = []
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
  // 确认弹层 (删除歌曲等破坏性操作)
  private confirmOverlay!: BoxRenderable
  private confirmText!: TextRenderable
  // tab 栏 (播放列表 / 收藏 / 歌单 / 设置 / 队列)
  private tabBar!: BoxRenderable
  private tabBtns: BoxRenderable[] = []
  private tabTexts: TextRenderable[] = []
  /** r-1.0: tab 栏下滑动的激活指示条 (渐变, 平滑跟随当前 tab) */
  private tabIndicator!: TextRenderable
  private tabIndBox!: BoxRenderable
  // 导航栏播放统计 (设置按钮左边)
  private playsStat!: TextRenderable
  private playsTotal = 0
  private theme: Theme = THEMES.latte
  private themeName: ThemeName = "latte"

  // ---------- r-1.0 覆盖层节点 ----------
  // 排序菜单 (o)
  private sortOverlay!: BoxRenderable
  private sortRows: TextRenderable[] = []
  // 统计面板 (S)
  private statsOverlay!: BoxRenderable
  private statsTitle!: TextRenderable
  private statsRows: TextRenderable[] = []
  // 音乐目录管理 (设置 → 音乐目录 Enter)
  private dirOverlay!: BoxRenderable
  private dirRows: TextRenderable[] = []
  private dirHint!: TextRenderable
  // 通知浮层 (底部右侧, 首次使用时懒创建节点)
  private toastBoxes: Array<{ box: BoxRenderable; text: TextRenderable }> = []
  private toastRoot: BoxRenderable | null = null

  // ---------- 装饰动效 (独立于 100ms tick 的动画帧) ----------
  /** 动效循环定时器; undefined = 未启动 (测试/无动画场景不会创建) */
  private animTimer: Timer | undefined = undefined
  private animMs = 0 // 当前帧间隔 (播放/待机自适应)
  /** tab 颜色过渡: level 为当前插值值, target 为目标值 (0=闲置, 1=激活) */
  private tabLevel: number[] = []
  private tabTarget: number[] = []
  /** 指示条当前位置 (tab 下标浮点), 每帧向激活 tab 缓动 */
  private tabIndicatorPos = 0
  /** 频谱每列峰值保持值 (缓慢回落, 制造"峰顶") */
  private spectrumPeaks: number[] = []
  /** 每首歌的频谱随机种子 (换歌波形换样) */
  private spectrumSeed = 0.37
  private spectrumSeedPath: string | null = null

  constructor(
    private renderer: CliRenderer,
    readonly p: Player,
    themeName: ThemeName = "latte",
  ) {
    this.themeName = themeName
    this.theme = THEMES[themeName] ?? THEMES.latte
    // 后台探测/播放回填时长后刷新列表 (行右侧格式/时长)
    this.p.onDurationsUpdated = () => {
      if (this.view === "list" || this.view === "fav" || this.view === "pl" || this.view === "queue") this.updatePlaylist()
    }
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
    // 品牌 logo: 内容由 updateLogo 每帧画 (渐变流动 + 高光扫过)
    this.logoText = new TextRenderable(r, { content: "\uF025 蓝汐音乐", fg: this.theme.sky, selectable: false, wrapMode: "none" })
    headLeft.add(this.logoText)
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

    // ── 顶部渐变彩虹条 (品牌点缀: 居中缩窄的细条, 内容由 updateAccent 每帧画) ──
    const accent = new BoxRenderable(r, {
      height: 1,
      flexDirection: "row",
      justifyContent: "center",
      backgroundColor: this.theme.base,
    })
    this.accentText = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
    accent.add(this.accentText)
    root.add(accent)

    // ── 正在播放卡片 (紧凑: 减内边距, 底部加渐变分隔线) ──
    this.nowPlayBox = new BoxRenderable(r, {
      flexDirection: "column",
      backgroundColor: this.theme.crust,
      borderStyle: "double",
      borderColor: this.theme.surface1,
      title: " 正在播放 ",
      titleColor: this.theme.sky,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 0,
      paddingBottom: 0,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      gap: 0,
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
    // r-1.0: 程序化频谱可视化 (非真实 FFT, 无 cava 依赖) — 内容由 updateSpectrum 每帧画
    const specRow = new BoxRenderable(r, { height: 1, flexDirection: "row", alignItems: "center" })
    this.spectrumText = new TextRenderable(r, { content: "", selectable: false, flexGrow: 1, wrapMode: "none" })
    specRow.add(this.spectrumText)
    this.nowPlayBox.add(specRow)
    // 渐变分隔线 (卡片底部点缀: 居中缩窄, 内容由 updateNowPlaying 每帧画)
    const nowDivRow = new BoxRenderable(r, { flexDirection: "row", justifyContent: "center", height: 1 })
    this.nowDivider = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
    nowDivRow.add(this.nowDivider)
    this.nowPlayBox.add(nowDivRow)
    root.add(this.nowPlayBox)

    // ── 歌词区 (无歌词/关闭时 tick 里 visible=false 自动收起, 让列表更大) ──
    this.lyricsBox = new BoxRenderable(r, {
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
    this.lyricsBox.add(lyricInner)
    this.lyricInner = lyricInner
    root.add(this.lyricsBox)

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
    // 播放统计标签 (设置按钮右边, 灰色小字)
    this.playsStat = new TextRenderable(r, {
      content: "",
      fg: this.theme.overlay,
      selectable: false,
      flexGrow: 1,
      justifyContent: "flex-end",
      wrapMode: "none",
    })
    this.tabBar.add(this.playsStat)
    root.add(this.tabBar)
    // r-1.0: tab 激活指示条 (1 行, 渐变, 平滑滑动到当前 tab 下方)
    const tabIndBox = new BoxRenderable(r, {
      id: "tabIndBox",
      height: 1,
      flexDirection: "row",
      marginLeft: 1,
      marginRight: 1,
      backgroundColor: this.theme.mantle,
    })
    this.tabIndicator = new TextRenderable(r, {
      position: "absolute",
      top: 0,
      left: 0,
      content: "",
      selectable: false,
      wrapMode: "none",
    })
    tabIndBox.add(this.tabIndicator)
    this.tabIndBox = tabIndBox
    root.add(tabIndBox)
    this.updateTabBar()

    // ── 播放列表 (多视图共享此区) ──
    this.plBox = new BoxRenderable(r, {
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
    this.plBox.add(this.plTitle)
    // 标题下的细分隔线 (宽度在 tick 里按布局刷新)
    this.plDivider = new TextRenderable(r, { content: "", fg: this.theme.surface1, selectable: false, paddingLeft: 1 })
    this.plBox.add(this.plDivider)
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
    this.plBox.add(this.scrollbox)
    root.add(this.plBox)

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
      title: ` 帮助 · 蓝汐音乐 ${VERSION} `,
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
    const helpSections: Array<{ icon: string; title: string; items: Array<[string, string]> }> = [
      { icon: "\uF04B", title: "播放控制", items: [
        ["空格 / Enter", "播放 · 暂停 · 播放选中"],
        ["n / p  ·  ← / →  ·  [ / ]", "切歌 · 快退快进 5 / 10 秒"],
      ]},
      { icon: "\uF044", title: "编辑歌曲", items: [
        ["R", "重命名歌曲文件 (同名 .lrc 一起改)"],
        ["D", "删除歌曲文件 (Enter 确认, 不可恢复)"],
      ]},
      { icon: "\uF03A", title: "列表导航", items: [
        ["↑↓ / jk  ·  g / G", "选择曲目 · 跳到首 / 尾"],
        ["1 / 2 / 3 / 4 / 5", "列表 / 收藏 / 歌单 / 设置 / 队列"],
        ["o  ·  S", "排序菜单 · 音乐库统计面板"],
        ["鼠标", "点击行播放 · 点击 tab 切换"],
      ]},
      { icon: "\uF0CA", title: "播放队列", items: [
        ["w  ·  e", "下一首播放 (插队) · 加入队列末尾"],
        ["5", "队列视图: Enter 播放 · x 移除"],
        ["J / K  ·  c", "队列内下移 / 上移 · 清空待播"],
      ]},
      { icon: "\uF074", title: "随机 · 循环 · 歌词", items: [
        ["s  ·  m", "随机播放 · 循环模式"],
        ["l / L", "歌词开关 / 全屏 KTV 歌词"],
        ["设置行 4", "歌词延迟 -5~5s (负=提前, 正=滞后)"],
        [", / ;", "歌词延迟 -0.25s / +0.25s (快捷)"],
        ["自动", "歌词/歌名超宽时行内滚动"],
      ]},
      { icon: "\uF004", title: "收藏 · 歌单", items: [
        ["f / F", "收藏当前曲 / 收藏模式"],
        ["3 或 P  ·  n / r / d", "歌单视图 · 新建 / 重命名 / 删除"],
        ["Enter / a / x", "进入详情 / 加歌 / 移除"],
      ]},
      { icon: "\uF002", title: "搜索 · 扫描", items: [
        ["/", "搜索 (中文 · Enter 确认 · Esc 取消)"],
        ["d", "重新扫描音乐目录"],
      ]},
      { icon: "\uF013", title: "音量 · 设置", items: [
        ["+ / -  ·  M / 0", "音量增减 / 静音"],
        ["z  ·  i", "睡眠定时 (渐弱暂停) / 歌曲信息"],
        ["设置 → 音乐目录", "多目录管理: a 添加 · d 删除 · Enter 置顶"],
        ["4", "设置: 主题/音量/倍速/歌词延迟/排序/目录"],
      ]},
      { icon: "\uF08B", title: "退出", items: [
        ["q / Esc", "退出 / 逐级返回"],
      ]},
    ]
    for (const sec of helpSections) {
      this.helpOverlay.add(
        new TextRenderable(r, {
          content: t`${bold(fg(this.theme.lavender)(` ${sec.icon}  ${sec.title}`))}`,
          selectable: false,
        }),
      )
      for (const [k, v] of sec.items) {
        // 键列固定显示宽度 22 (CJK 按 2 计), 对齐说明列
        const pad = Math.max(1, 22 - displayWidth(k))
        this.helpOverlay.add(
          new TextRenderable(r, {
            content: t`${fg(this.theme.overlay)("   ")}${bold(fg(this.theme.sky)(k))}${" ".repeat(pad)}${fg(this.theme.text)(v)}`,
            selectable: false,
            wrapMode: "none",
          }),
        )
      }
    }
    this.helpOverlay.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.surface1)("  " + "─".repeat(38))}`,
        selectable: false,
      }),
    )
    this.helpOverlay.add(
      new TextRenderable(r, {
        content: t`${bold(fg(this.theme.pink)(" 按任意键返回喵~"))}${fg(this.theme.overlay)(`   ·   蓝汐音乐 ${VERSION} `)}`,
        selectable: false,
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

    // ── 歌曲信息覆盖层 (i 键) ──
    this.infoOverlay = new BoxRenderable(r, {
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
      zIndex: 150,
    })
    const infoCard = new BoxRenderable(r, {
      flexDirection: "column",
      borderStyle: "single",
      borderColor: this.theme.lavender,
      title: " 歌曲信息 ",
      titleColor: this.theme.lavender,
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      width: 78,
    })
    this.infoLines = []
    for (let i = 0; i < 9; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false })
      infoCard.add(row)
      this.infoLines.push(row)
    }
    infoCard.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.pink)(" 按任意键关闭喵~ ")}`,
        selectable: false,
        paddingTop: 1,
      }),
    )
    this.infoOverlay.add(infoCard)
    root.add(this.infoOverlay)

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

    // ── 确认弹层 (破坏性操作: 删除歌曲) ──
    this.confirmOverlay = new BoxRenderable(r, {
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
      zIndex: 250,
    })
    const confirmCard = new BoxRenderable(r, {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: this.theme.red,
      title: " \uF1F8 确认 ",
      titleColor: this.theme.red,
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      width: 66,
    })
    this.confirmText = new TextRenderable(r, { content: "", fg: this.theme.text, selectable: false })
    confirmCard.add(this.confirmText)
    confirmCard.add(
      new TextRenderable(r, {
        content: t`${bold(fg(this.theme.red)(" Enter / y 确认 "))}${fg(this.theme.overlay)("  ·  ")}${fg(this.theme.subtext)("Esc / n 取消 ")}`,
        selectable: false,
        paddingTop: 1,
      }),
    )
    this.confirmOverlay.add(confirmCard)
    root.add(this.confirmOverlay)

    // ── r-1.0 排序菜单 (o) ──
    this.sortOverlay = new BoxRenderable(r, {
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
      zIndex: 320,
    })
    const sortCard = new BoxRenderable(r, {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: this.theme.lavender,
      title: " \uF0CA 列表排序 ",
      titleColor: this.theme.lavender,
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      width: 48,
    })
    this.sortRows = []
    for (let i = 0; i < SORT_MODES.length + 1; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
      sortCard.add(row)
      this.sortRows.push(row)
    }
    sortCard.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.overlay)("↑↓ 选择 · ←/→ 切换升降序 · Enter 应用 · Esc 取消")}`,
        selectable: false,
        paddingTop: 1,
      }),
    )
    this.sortOverlay.add(sortCard)
    root.add(this.sortOverlay)

    // ── r-1.0 音乐库统计 (S) ──
    this.statsOverlay = new BoxRenderable(r, {
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
      zIndex: 310,
    })
    const statsCard = new BoxRenderable(r, {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: this.theme.sky,
      title: ` \uF080 音乐库统计 · 蓝汐音乐 ${VERSION} `,
      titleColor: this.theme.sky,
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      width: 74,
    })
    this.statsTitle = new TextRenderable(r, { content: "", fg: this.theme.text, selectable: false, wrapMode: "none" })
    statsCard.add(this.statsTitle)
    statsCard.add(new TextRenderable(r, { content: "", selectable: false }))
    this.statsRows = []
    for (let i = 0; i < 22; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
      statsCard.add(row)
      this.statsRows.push(row)
    }
    statsCard.add(
      new TextRenderable(r, {
        content: t`${fg(this.theme.pink)(" 按任意键关闭喵~ ")}`,
        selectable: false,
        paddingTop: 1,
      }),
    )
    this.statsOverlay.add(statsCard)
    root.add(this.statsOverlay)

    // ── r-1.0 音乐目录管理 (设置 → 音乐目录 Enter) ──
    this.dirOverlay = new BoxRenderable(r, {
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
      zIndex: 315,
    })
    const dirCard = new BoxRenderable(r, {
      flexDirection: "column",
      borderStyle: "double",
      borderColor: this.theme.green,
      title: " \uF07B 音乐目录管理 ",
      titleColor: this.theme.green,
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
      width: 76,
    })
    this.dirRows = []
    for (let i = 0; i < 9; i++) {
      const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
      dirCard.add(row)
      this.dirRows.push(row)
    }
    this.dirHint = new TextRenderable(r, {
      content: "",
      fg: this.theme.subtext,
      selectable: false,
      paddingTop: 1,
      wrapMode: "none",
    })
    dirCard.add(this.dirHint)
    this.dirOverlay.add(dirCard)
    root.add(this.dirOverlay)

    // ── r-1.0 通知浮层 (底部右侧堆叠) ──
    // 注意: 不在隐藏的 absolute 盒子里预先创建文本节点 — 那样的节点后续不再渲染。
    // 改为首次 pushToast 时懒创建 (见 ensureToastBoxes)。
    this.toastRoot = root
    this.toastBoxes = []

    this.attachDialogEvents()

    r.root.add(root)
  }

  /** 懒创建通知浮层节点: 必须在树已提交渲染后创建 (预建在隐藏 absolute 盒里的文本节点之后不再渲染) */
  private ensureToastBoxes() {
    if (this.toastBoxes.length || !this.toastRoot) return
    for (let i = 0; i < TOAST_MAX; i++) {
      const box = new BoxRenderable(this.renderer, {
        position: "absolute",
        right: 2,
        bottom: 2 + i * 3,
        width: 46,
        height: 3,
        borderStyle: "single",
        borderColor: this.theme.lavender,
        backgroundColor: this.theme.mantle,
        paddingLeft: 1,
        paddingRight: 1,
        visible: false,
        zIndex: 450,
      })
      const text = new TextRenderable(this.renderer, { content: " ", selectable: false, wrapMode: "none" })
      box.add(text)
      this.toastRoot.add(box)
      this.toastBoxes.push({ box, text })
    }
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
          // 时长回填: 当前播放曲目的时长进缓存 (列表右侧显示)
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
    // 歌曲信息弹层: 任意键关闭
    if (this.showInfo) {
      this.closeInfo()
      key.preventDefault()
      return
    }
    // 统计面板 (r-1.0): 任意键关闭
    if (this.showStats) {
      this.closeStats()
      key.preventDefault()
      return
    }
    // 排序菜单 (r-1.0): ↑↓ 选择 · ←/→ 升降序 · Enter 应用 · Esc 取消
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
    // 音乐目录管理 (r-1.0)
    if (this.showDirManager) {
      if (name === "up" || seq === "k") this.dirCursor = Math.max(0, this.dirCursor - 1)
      else if (name === "down" || seq === "j") {
        this.dirCursor = Math.min(Math.max(0, this.dirList().length - 1), this.dirCursor + 1)
      } else if (name === "return" || name === "enter") this.dirSetPrimary()
      else if (seq === "a") this.openPlDialog("add-dir")
      else if (seq === "d" || name === "delete") this.dirRemove()
      else if (name === "escape" || seq === "q") this.closeDirManager()
      if (this.showDirManager) this.updateDirManager()
      key.preventDefault()
      return
    }
    // 确认弹层 (删除歌曲): Enter/y 确认, Esc/n 取消, 其它键忽略
    if (this.confirmAction) {
      if (name === "return" || name === "enter" || seq === "y" || seq === "Y") {
        const act = this.confirmAction
        this.closeConfirm()
        act()
      } else if (name === "escape" || seq === "n" || seq === "N") {
        this.closeConfirm()
        this.flash("已取消喵~")
      }
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
    // g/G: 跳到列表首/尾 (vim 风格)
    if (seq === "g") {
      this.sel = 0
      this.updatePlaylist()
      key.preventDefault()
      return
    }
    if (seq === "G") {
      const n = this.listCount()
      this.sel = Math.max(0, n - 1)
      this.updatePlaylist()
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

    // 队列视图 (view==="queue") 的特有按键 (r-1.0)
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
      if (seq === "w") {
        this.queueNextSel()
        key.preventDefault()
        return
      }
      // 其它键落入下方 switch (s/m/音量/视图切换等)
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
      case seq === ",":
        p.setLyricDelay(p.lyricDelay - 0.25)
        saveConfig({ lyric_delay: p.lyricDelay })
        this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s (已保存)`)
        break
      case seq === ";":
        p.setLyricDelay(p.lyricDelay + 0.25)
        saveConfig({ lyric_delay: p.lyricDelay })
        this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s (已保存)`)
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
        p.toggleShuffle()
        this.flash(p.isShuffle ? "\uF074 随机播放已开启" : "\uF001 顺序播放已开启")
        break
      case seq === "m":
        p.cycleRepeat()
        this.flash("循环模式: " + REPEAT_LABEL[p.repeat])
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
        // 必须 preventDefault: 弹层输入框在按键处理中被 focus, 不拦的话触发键 R 会漏进输入框
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

  /** 切换列表区视图: list / fav / pl / settings / queue */
  setView(v: ViewName) {
    if (this.view === v) {
      // 再按一次歌单 tab: 若在详情则返回列表
      if (v === "pl" && this.plLevel === "detail") this.closePlDetail()
      return
    }
    const p = this.p
    // 离开前保存各视图游标
    if (this.view === "list") this.savedListSel = this.sel
    else if (this.view === "fav") this.savedFavSel = this.sel
    else if (this.view === "queue") this.savedQueueSel = this.sel
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
      } else if (v === "queue") {
        this.sel = Math.max(0, Math.min(Math.max(0, p.queue.length - 1), this.savedQueueSel))
      } else {
        this.sel = Math.max(0, Math.min(Math.max(0, p.playlist.length - 1), this.savedListSel))
      }
    }
    this.view = v
    this.searchActive = false
    this.searchQuery = ""
    this.beginViewTransition()
    this.updateTabBar()
    this.updatePlaylist()
  }

  // =========================================================
  //  视图过渡 / 选择高亮 (r-1.0 动效)
  // =========================================================

  /** 启动一次视图切换过渡 (列表边框扫光 + 指示条滑动) */
  private beginViewTransition() {
    this.viewAnimT = 0
    if (!this.animTimer) this.viewAnimT = 1
  }

  /** 刷新 tab 栏: 记录目标态并重绘 (动效循环未启动时直接到位) */
  private updateTabBar() {
    const curIdx = TAB_KEYS.indexOf(this.view)
    this.tabTarget = TAB_LABELS.map((_, i) => (i === curIdx ? 1 : 0))
    if (!this.animTimer || this.tabLevel.length !== TAB_LABELS.length) this.tabLevel = this.tabTarget.slice()
    this.applyTabBar()
  }

  /** 把 tab 过渡值画到节点 (颜色插值 → 切换 tab 时底色/文字平滑淡入淡出) */
  private applyTabBar() {
    for (let i = 0; i < this.tabBtns.length; i++) {
      const a = this.tabLevel[i] ?? 0
      this.tabBtns[i].backgroundColor = mixHex(this.theme.surface0, this.theme.surface2, a)
      const label = TAB_LABELS[i]
      this.tabTexts[i].content =
        a > 0.5 ? t`${bold(fg(this.theme.sky)(label))}` : t`${fg(mixHex(this.theme.subtext, this.theme.sky, a))(label)}`
    }
  }

  /** 每帧推进 tab 颜色过渡 (0.22 缓动 ≈ 6 帧到位) */
  private stepTabAnim() {
    for (let i = 0; i < this.tabLevel.length; i++) {
      const target = this.tabTarget[i] ?? 0
      const d = target - this.tabLevel[i]
      this.tabLevel[i] = Math.abs(d) < 0.02 ? target : this.tabLevel[i] + d * 0.22
    }
    this.applyTabBar()
  }

  // =========================================================
  //  动作
  // =========================================================
  flash(text: string, seconds = 1.6) {
    this.msg = text
    this.msgUntil = Date.now() + seconds * 1000
    // r-1.0: 同时推一条通知浮层 (按内容猜一个强调色; 动效循环未启动时不显示)
    const color = /\uF1F8|失败|错误|取消/.test(text)
      ? this.theme.red
      : /\uF004|\uF055|\uF067|已收藏|已添加|已创建/.test(text)
        ? this.theme.green
        : /\uF0CA|队列|排序|插队/.test(text)
          ? this.theme.lavender
          : this.theme.sky
    this.pushToast(text, color)
  }

  /** 睡眠定时器切换后的提示 (含刷新设置行显示) */
  private flashSleep() {
    const m = this.p.sleepMinutes
    this.flash(m === 0 ? "\uF017 睡眠定时器已关闭喵~" : `\uF017 睡眠定时: ${m} 分钟后自动暂停喵~`, 2)
    this.updatePlaylist()
  }

  /** 当前视图的行数 */
  private listCount(): number {
    const p = this.p
    if (this.view === "settings") return SETTING_ROW_COUNT
    if (this.view === "queue") return p.queue.length
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
    this.refreshSpectrumSeed()
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

  // ---------- 编辑歌曲 (重命名 R / 删除 D, 动的是磁盘文件) ----------

  /** 当前视图选中行对应的歌曲路径; 设置/歌单列表级、或该曲不在音乐库中返回 null */
  private selectedSongPath(): string | null {
    const p = this.p
    if (this.view === "settings") return null
    if (this.view === "pl") {
      if (this.plPickerMode) return p.playlist[this.sel] ?? null
      if (this.plLevel === "detail" && this.plCurrent) {
        const path = p.playlistPaths(this.plCurrent)[this.sel]
        return path && p.playlist.includes(path) ? path : null
      }
      return null
    }
    if (!p.playlist.length) return null
    const useQueue = this.searchActive || this.view === "fav" || p.favMode
    const idx = useQueue ? p.selToPlaylistIdx(this.sel, true) : this.sel
    return p.playlist[idx] ?? null
  }

  /** R: 重命名选中歌曲 (弹层输入新歌名, 扩展名沿用原文件) */
  private renameSelectedSong() {
    const path = this.selectedSongPath()
    if (!path) {
      this.flash("这里没有可重命名的歌曲喵~")
      return
    }
    this.pendingSongPath = path
    this.openPlDialog("rename-song", titleOf(path))
  }

  /** D: 删除选中歌曲 (确认后删磁盘文件 + 同名 .lrc) */
  private deleteSelectedSong() {
    const path = this.selectedSongPath()
    if (!path) {
      this.flash("这里没有可删除的歌曲喵~")
      return
    }
    const label = titleOf(path)
    this.askConfirm(`\uF1F8 删除「${label}」? 会删除磁盘文件 (含同名歌词)`, () => {
      const r = this.p.deleteTrack(path)
      if (!r.ok) {
        this.flash(`删除失败喵~ (${r.error})`)
        return
      }
      this.sel = Math.max(0, Math.min(Math.max(0, this.listCount() - 1), this.sel))
      this.flash(`\uF1F8 已删除: ${label}`, 2)
      this.afterTrackChange()
    })
  }

  /** 弹确认弹层 (破坏性操作); action 在确认后执行, Esc/n 取消 */
  private askConfirm(message: string, action: () => void) {
    this.confirmMessage = message
    this.confirmAction = action
    this.confirmText.content = t`${fg(this.theme.text)(clipWidth(message, 58))}`
    this.confirmOverlay.visible = true
  }

  private closeConfirm() {
    this.confirmAction = null
    this.confirmMessage = ""
    this.confirmOverlay.visible = false
  }

  // ---------- 设置视图 ----------

  /** 设置项 Enter: 0 主题 / 3 歌词延迟 / 4 睡眠 / 5 目录管理 / 6 排序菜单 / 7 缓存 / 8 版本 */
  settingEnter() {
    if (this.sel === 0) this.cycleTheme()
    else if (this.sel === 3) this.flash("用 ←/→ 或 , ; 调整歌词延迟喵~ (-5~5s, 步进 0.25, 正=滞后/负=提前, 自动保存)")
    else if (this.sel === 4) {
      this.p.cycleSleep()
      this.flashSleep()
    } else if (this.sel === 5) this.openDirManager()
    else if (this.sel === 6) this.openSort()
    else if (this.sel === 7) {
      const n = clearCache()
      ensureCacheDir()
      this.flash(`已清空缓存 (${n} 项) 喵~`, 2.2)
      this.updatePlaylist()
    }
    else if (this.sel === 8) this.flash(`当前版本 ${VERSION} 喵~`)
    else if (this.sel === 2) this.flash("用 ←/→ 调整倍速喵~ (步进 0.25, 自动保存)")
    else this.flash("用 ←/→ 或 +/- 调整音量喵~ (自动保存)")
  }

  /** 设置项 ←/→: 主题=前/后切换, 音量=∓5, 倍速=∓0.25, 歌词延迟=∓0.25, 排序=切换字段 (均持久化) */
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
    } else if (this.sel === 2) {
      p.setSpeed(p.speed + dir * 0.25).then(() => {
        saveConfig({ speed: p.speed })
        this.flash(`倍速 ${p.speed.toFixed(2)}x (已保存)`)
        this.updatePlaylist()
      })
    } else if (this.sel === 3) {
      p.setLyricDelay(p.lyricDelay + dir * 0.25)
      saveConfig({ lyric_delay: p.lyricDelay })
      this.flash(`歌词延迟 ${p.lyricDelay.toFixed(2)}s (已保存)`)
      this.updatePlaylist()
    } else if (this.sel === 4) {
      this.p.cycleSleep(dir)
      this.flashSleep()
    } else if (this.sel === 5) this.flash("Enter 管理音乐目录喵~ (a 添加 · d 删除 · Enter 置顶)")
    else if (this.sel === 6) {
      const cur = SORT_MODES.indexOf(p.sortMode)
      const n = SORT_MODES.length
      const next = SORT_MODES[((cur + dir) % n + n) % n]
      p.setSort(next, p.sortAsc)
      saveConfig({ sort_mode: next, sort_asc: p.sortAsc })
      this.sel = Math.max(0, Math.min(this.listCount() - 1, this.sel))
      this.updatePlaylist()
      this.flash(`排序: ${SORT_LABEL[next]} ${p.sortAsc ? "↑" : "↓"} (已保存) Enter 打开菜单`)
    } else if (this.sel === 7) this.flash("Enter 清空缓存喵~")
    else if (this.sel === 8) this.flash("版本是只读的喵~ h 帮助查看更多")
  }

  /** 改音乐目录: 校验 + 持久化 + 重扫 */
  applyMusicDirs(dirs: string[]): boolean {
    const p = this.p
    const clean: string[] = []
    for (const d of dirs) {
      let abs = d
      try {
        abs = resolve(d)
      } catch {
        abs = d
      }
      if (!abs || clean.includes(abs)) continue
      if (!existsSync(abs)) {
        this.flash(`目录不存在喵~: ${d}`)
        continue
      }
      clean.push(abs)
    }
    if (!clean.length) {
      this.flash("至少要保留一个有效目录喵~")
      return false
    }
    saveMusicDirs(clean)
    p.musicDirs = clean
    p.musicDir = clean[0]
    p.refreshDir().then((n) => {
      this.sel = Math.max(0, Math.min(Math.max(0, this.listCount() - 1), p.idx))
      this.updatePlaylist()
      this.updateDirManager()
      this.flash(`\uF07C 音乐目录已更新 (${clean.length} 个, ${n} 首)`, 2.5)
    })
    return true
  }

  // ---------- r-1.0: 音乐目录管理弹层 ----------

  /** 当前目录列表 (有效主列表) */
  private dirList(): string[] {
    return this.p.scanRoots()
  }

  private openDirManager() {
    this.showDirManager = true
    this.dirCursor = 0
    this.dirOverlay.visible = true
    this.updateDirManager()
  }

  private closeDirManager() {
    this.showDirManager = false
    this.dirOverlay.visible = false
    this.updatePlaylist()
  }

  /** 重画目录管理弹层 (列表 + 高亮 + 提示) */
  updateDirManager() {
    if (!this.dirOverlay) return
    const dirs = this.dirList()
    if (this.dirCursor >= dirs.length) this.dirCursor = Math.max(0, dirs.length - 1)
    for (let i = 0; i < this.dirRows.length; i++) {
      const row = this.dirRows[i]
      const d = dirs[i]
      if (!d) {
        row.content = ""
        continue
      }
      const sel = i === this.dirCursor
      const label = `${sel ? "▌ " : "  "}${i === 0 ? "\uF005 主 " : "   "}${clipWidth(d, 60)}`
      row.content = sel
        ? t`${bold(fg(this.theme.green)(label))}`
        : t`${fg(i === 0 ? this.theme.sky : this.theme.text)(label)}`
    }
    this.dirHint.content = ` 共 ${dirs.length} 个目录 (全部合并扫描) · a 添加 · d 删除 · Enter 设为主目录 · Esc 关闭`
  }

  /** Enter: 把选中目录置顶为主目录 */
  private dirSetPrimary() {
    const dirs = this.dirList()
    const d = dirs[this.dirCursor]
    if (!d) return
    if (this.dirCursor === 0) {
      this.flash("已经在主目录位置啦喵~")
      return
    }
    const next = [d, ...dirs.filter((x) => x !== d)]
    this.dirCursor = 0
    if (this.applyMusicDirs(next)) this.flash(`\uF005 主目录: ${d}`, 2)
  }

  /** d: 删除选中目录 (不删磁盘文件) */
  private dirRemove() {
    const dirs = this.dirList()
    if (dirs.length <= 1) {
      this.flash("至少要保留一个目录喵~")
      return
    }
    const d = dirs[this.dirCursor]
    if (!d) return
    this.askConfirm(`\uF1F8 从音乐目录移除「${clipWidth(d, 46)}」? (不删磁盘文件)`, () => {
      const next = dirs.filter((x) => x !== d)
      if (this.applyMusicDirs(next)) {
        this.dirCursor = Math.max(0, Math.min(next.length - 1, this.dirCursor))
        this.updateDirManager()
        this.dirOverlay.visible = true
        this.flash(`已移除目录: ${d}`, 2)
      }
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
    const info = this.showInfo
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
    const confirmMsg = this.confirmMessage
    const confirmAct = this.confirmAction
    const pendingSong = this.pendingSongPath
    // r-1.0: 新弹层/面板状态也必须跨重建存活 (applyTheme 备份/恢复清单)
    const showSort = this.showSort
    const sortCursor = this.sortCursor
    const showStats = this.showStats
    const showDirManager = this.showDirManager
    const dirCursor = this.dirCursor

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
    if (info) this.openInfo()
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
    this.pendingSongPath = pendingSong
    if (confirmAct) this.askConfirm(confirmMsg, confirmAct)
    this.showSort = showSort
    this.sortCursor = sortCursor
    this.showStats = showStats
    this.showDirManager = showDirManager
    this.dirCursor = dirCursor
    if (showSort) {
      this.sortOverlay.visible = true
      this.updateSortMenu()
    }
    if (showStats) {
      this.statsOverlay.visible = true
      this.updateStats()
    }
    if (showDirManager) {
      this.dirOverlay.visible = true
      this.updateDirManager()
    }
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

  /** 弹出输入弹层: 新建/重命名歌单 · 重命名歌曲 · 添加音乐目录 */
  openPlDialog(mode: "new" | "rename" | "rename-song" | "set-dir" | "add-dir", preset = "") {
    this.plDialogMode = mode
    this.plDialogValue = preset
    this.plDialogInput.value = preset
    this.plDialogInput.width = mode === "set-dir" || mode === "add-dir" ? 70 : mode === "rename-song" ? 50 : 40
    this.plDialogTitle.content =
      mode === "new"
        ? t`${bold(fg(this.theme.sky)(" \uF067 新建歌单 "))}`
        : mode === "rename"
          ? t`${bold(fg(this.theme.sky)(" \uF044 重命名歌单 "))}`
          : mode === "rename-song"
            ? t`${bold(fg(this.theme.sky)(" \uF044 重命名歌曲 "))}`
            : mode === "add-dir"
              ? t`${bold(fg(this.theme.sky)(" \uF067 添加音乐目录 "))}`
              : t`${bold(fg(this.theme.sky)(" \uF07B 修改音乐目录 "))}`
    const songExt = this.pendingSongPath ? extOf(this.pendingSongPath) : ""
    this.plDialogHint.content =
      mode === "new"
        ? "输入名称 · Enter 确认 · Esc 取消"
        : mode === "rename"
          ? `原名: ${preset}  ·  Enter 确认 · Esc 取消`
          : mode === "rename-song"
            ? `原名: ${preset}${songExt}  ·  只输入歌名, 后缀 ${songExt} 保留 · Enter 确认 · Esc 取消`
            : mode === "add-dir"
              ? `输入完整路径 (支持 ~) · Enter 添加到目录列表 · Esc 取消`
              : `当前: ${preset}  ·  输入完整路径 · Enter 确认重扫 · Esc 取消`
    this.plDialogOverlay.visible = true
    this.plDialogInput.focus()
  }

  closePlDialog() {
    const wasDir = this.plDialogMode === "set-dir" || this.plDialogMode === "add-dir"
    this.plDialogMode = null
    this.plDialogValue = ""
    this.pendingSongPath = null
    this.plDialogInput.value = ""
    this.plDialogInput.width = 40
    this.plDialogOverlay.visible = false
    this.plDialogInput.blur()
    if (wasDir && this.view === "settings") this.updatePlaylist()
    // 从目录管理里打开的添加弹层: 关闭后回到目录弹层
    if (wasDir && this.showDirManager) {
      this.dirOverlay.visible = true
      this.updateDirManager()
    }
  }

  commitPlDialog(value: string) {
    const v = value.trim()
    const mode = this.plDialogMode
    if (mode === "set-dir") {
      this.closePlDialog()
      if (v) this.applyMusicDirs([...this.dirList(), v])
      return
    }
    if (mode === "add-dir") {
      this.closePlDialog()
      if (!v) return
      if (this.applyMusicDirs([...this.dirList(), v])) {
        this.dirCursor = Math.max(0, this.dirList().length - 1)
        this.flash(`\uF067 已添加目录: ${v}`, 2)
        this.updateDirManager()
      }
      return
    }
    if (mode === "rename-song") {
      const path = this.pendingSongPath
      this.closePlDialog()
      if (!path) return
      if (!v) {
        this.flash("歌名不能为空喵~")
        return
      }
      const r = this.p.renameTrack(path, v)
      if (!r.ok) {
        this.flash(`重命名失败喵~ (${r.error})`)
        return
      }
      this.flash(`\uF044 已重命名为: ${titleOf(r.newPath)}`, 2)
      this.afterTrackChange()
      return
    }
    if (!v) {
      this.flash("歌单名不能为空喵~")
      this.closePlDialog()
      return
    }
    if (mode === "new") {
      const idx = this.p.createPlaylist(v)
      if (idx < 0) {
        this.flash(`已存在同名歌单喵~: ${v}`)
        this.closePlDialog()
        return
      }
      this.flash(`\uF067 已创建歌单: ${v}`)
      this.sel = idx
    } else if (mode === "rename") {
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

  /** 歌曲信息弹层: 打开并填充内容 */
  private openInfo() {
    const p = this.p
    const path = p.currentPath
    const dur = p.durationOf(path)
    const lines: Array<string | null> = [
      `歌名    ${p.currentTitle()}`,
      `艺术家  ${p.currentArtist() || "—"}`,
      `格式    ${extOf(path || "").replace(".", "").toUpperCase() || "—"}  ·  时长 ${dur > 0 ? `${Math.round(dur)} 秒` : "--"}`,
      null, // 路径
      `已播放  ${p.playCountOf(path)} 次`,
      `位置    第 ${p.idx + 1}/${p.playlist.length} 首${p.playing ? `  ·  ${p.duration > 0 ? fmt(p.duration) : "--:--"}` : ""}`,
      `模式    ${REPEAT_LABEL[p.repeat]}${p.isShuffle ? " · 随机" : ""}`,
      `音量    ${p.volume}${p.muted ? " (静音)" : ""}  ·  倍速 ${p.speed.toFixed(2)}x`,
      `歌词延迟 ${p.lyricDelay > 0 ? "+" : ""}${p.lyricDelay.toFixed(2)}s`,
    ]
    if (path) lines[3] = `路径    ${clipWidth(path, 58)}`
    for (let i = 0; i < this.infoLines.length; i++) {
      const l = lines[i]
      this.infoLines[i].content = l ? t`${fg(this.theme.text)(l)}` : ""
    }
    this.showInfo = true
    this.infoOverlay.visible = true
  }

  private closeInfo() {
    this.showInfo = false
    this.infoOverlay.visible = false
  }

  // =========================================================
  //  r-1.0 播放队列动作
  // =========================================================

  /** 当前选中行的真实 playlist 下标 (无则 null) */
  private selectedPlaylistIndex(): number | null {
    const path = this.selectedSongPath()
    if (!path) return null
    const i = this.p.playlist.indexOf(path)
    return i >= 0 ? i : null
  }

  /** w: 选中曲插队到当前曲之后 (列表/收藏/歌单/选歌 通用) */
  private queueNextSelected() {
    const i = this.selectedPlaylistIndex()
    if (i === null) {
      this.flash("这里没有可插队的歌曲喵~")
      return
    }
    this.p.queueInsertNext(i)
    const name = titleOf(this.p.playlist[i])
    this.flash(`\uF0CA 下一首播放: ${name}`, 2)
    this.updatePlaylist()
  }

  /** e: 选中曲加入队列末尾 */
  private queueAppendSelected() {
    const i = this.selectedPlaylistIndex()
    if (i === null) {
      this.flash("这里没有可加队的歌曲喵~")
      return
    }
    this.p.queueAppend(i)
    const name = titleOf(this.p.playlist[i])
    this.flash(`\uF0CA 已加入队列: ${name}`, 2)
    this.updatePlaylist()
  }

  /** 队列视图 Enter: 播放选中项 */
  private queuePlaySel() {
    const p = this.p
    const real = p.queue[this.sel]
    if (real === undefined || real < 0 || real >= p.playlist.length) return
    p.playIndex(real).then(() => {
      this.afterTrackChange()
      this.updatePlaylist()
    })
  }

  /** 队列视图 x: 从队列移除选中项 (不改播放) */
  private queueRemoveSel() {
    const p = this.p
    const removed = p.queueRemoveAt(this.sel)
    if (removed === null) return
    const name = p.playlist[removed] ? titleOf(p.playlist[removed]) : "?"
    this.flash(`已从队列移除: ${name}`, 1.6)
    // 检测: 队列被清空时立即用整库重建, 否则 n/p 与播完续播都会失效
    if (!p.queue.length && p.ensureQueue()) {
      this.sel = Math.max(0, Math.min(p.queue.length - 1, p.queue.indexOf(p.idx)))
      this.flash("队列已空 → 已恢复整库顺序喵~", 2)
    } else {
      this.sel = Math.max(0, Math.min(Math.max(0, p.queue.length - 1), this.sel))
    }
    this.updatePlaylist()
  }

  /** 队列视图 J/K: 下移/上移选中项 */
  private queueMoveSel(delta: number) {
    this.sel = this.p.queueMove(this.sel, delta)
    this.updatePlaylist()
  }

  /** 队列视图 c: 清空待播 */
  private queueClearAll() {
    const n = this.p.queueClear()
    this.sel = 0
    this.flash(`\uF0CA 队列已清空 (剩 ${n} 首)`, 1.8)
    this.updatePlaylist()
  }

  /** 队列视图 w: 选中项移动到当前曲之后 */
  private queueNextSel() {
    const p = this.p
    const real = p.queue[this.sel]
    if (real === undefined) return
    p.queueInsertNext(real)
    this.sel = Math.max(0, p.queue.indexOf(real))
    this.flash(`\uF0CA 下一首播放: ${titleOf(p.playlist[real])}`, 1.8)
    this.updatePlaylist()
  }

  // =========================================================
  //  r-1.0 排序菜单
  // =========================================================

  private openSort() {
    this.showSort = true
    this.sortCursor = Math.max(0, SORT_MODES.indexOf(this.p.sortMode))
    this.sortOverlay.visible = true
    this.updateSortMenu()
  }

  private closeSort() {
    this.showSort = false
    this.sortOverlay.visible = false
    this.updatePlaylist()
  }

  private applySortMenu() {
    const mode = SORT_MODES[this.sortCursor]
    this.p.setSort(mode, this.p.sortAsc)
    saveConfig({ sort_mode: mode, sort_asc: this.p.sortAsc })
    this.closeSort()
    this.flash(`\uF0CA 排序: ${SORT_LABEL[mode]} ${this.p.sortAsc ? "↑" : "↓"} (已保存)`, 2.2)
  }

  /** 重画排序菜单 (字段列表 + 升降序行 + 高亮) */
  updateSortMenu() {
    if (!this.sortOverlay) return
    for (let i = 0; i < this.sortRows.length; i++) {
      const row = this.sortRows[i]
      if (i === SORT_MODES.length) {
        const label = `${this.p.sortAsc ? "↑ 升序" : "↓ 降序"}  (←/→ 切换)`
        row.content = t`${fg(this.theme.subtext)(label)}`
        continue
      }
      const mode = SORT_MODES[i]
      const sel = i === this.sortCursor
      const active = mode === this.p.sortMode
      const label = `${sel ? "▌ " : "  "}${SORT_LABEL[mode]}${active ? "  \uF00C" : ""}`
      row.content = sel
        ? t`${bold(fg(this.theme.sky)(label))}`
        : t`${fg(active ? this.theme.green : this.theme.text)(label)}`
    }
  }

  // =========================================================
  //  r-1.0 音乐库统计面板
  // =========================================================

  private openStats() {
    this.showStats = true
    this.statsOverlay.visible = true
    this.updateStats()
  }

  private closeStats() {
    this.showStats = false
    this.statsOverlay.visible = false
  }

  /** 画一根渐变条形 (value/max 比例 × width 列) */
  private statBar(value: number, max: number, width: number, pal: string[], flow = 0): TextChunk[] {
    const w = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0
    const parts: TextChunk[] = []
    for (let i = 0; i < w; i++) {
      parts.push(fg(paletteAt(pal, i / Math.max(1, w - 1) * 0.8 + flow))(BLOCK_CHARS[BLOCK_CHARS.length - 1]))
    }
    return parts
  }

  /** 重画统计面板 (真实数据: 曲库/格式分布/播放 Top/最近播放) */
  updateStats() {
    if (!this.statsOverlay) return
    const s = computeStats(this.p)
    this.statsTitle.content = t`${fg(this.theme.subtext)(" 曲目 ")}${bold(fg(this.theme.sky)(String(s.tracks)))}${fg(this.theme.subtext)("  总时长 ")}${bold(fg(this.theme.lavender)(fmtDuration(s.knownDurSec)))}${fg(this.theme.overlay)(`(${s.knownDurCount} 首已探测)`)}${fg(this.theme.subtext)("  播放 ")}${bold(fg(this.theme.pink)(String(s.totalPlays)))}${fg(this.theme.subtext)(" 次")}`

    const lines: Array<StyledText | null> = []
    const summary = t`${fg(this.theme.overlay)(" ")}${fg(this.theme.yellow)("\uF004")}${fg(this.theme.text)(` ${s.favorites} 收藏`)}${fg(this.theme.overlay)("   ·   ")}${fg(this.theme.green)("\uF1C5")}${fg(this.theme.text)(` ${s.playlists} 歌单`)}${fg(this.theme.overlay)("   ·   ")}${fg(this.theme.sky)("\uF07B")}${fg(this.theme.text)(` ${s.dirs} 目录`)}${fg(this.theme.overlay)("   ·   ")}${fg(this.theme.lavender)("\uF001")}${fg(this.theme.text)(` ${s.formats.length} 种格式`)}`
    lines.push(summary, null)

    lines.push(t`${bold(fg(this.theme.lavender)(" 格式分布"))}`)
    const fmtMax = Math.max(1, ...s.formats.map((x) => x.value))
    for (const f of s.formats) {
      lines.push(
        new StyledText([
          ...t`${fg(this.theme.overlay)("  ")}${fg(this.theme.text)(f.label.padEnd(6, " ").slice(0, 6))}${fg(this.theme.overlay)(String(f.value).padStart(3, " ") + " ")}`.chunks,
          ...this.statBar(f.value, fmtMax, 26, [this.theme.sky, this.theme.lavender]),
        ]),
      )
    }
    lines.push(null)

    lines.push(t`${bold(fg(this.theme.peach)(" 播放次数 Top"))}${fg(this.theme.overlay)("  (点亮的 ♪ 越多说明你越爱它)")}`)
    if (!s.topPlays.length) {
      lines.push(t`${fg(this.theme.overlay)("  (还没有播放记录喵~)")}`)
    } else {
      const topMax = Math.max(1, ...s.topPlays.map((x) => x.value))
      for (const x of s.topPlays) {
        lines.push(
          new StyledText([
            ...t`${fg(this.theme.overlay)("  ")}${fg(this.theme.text)(clipWidth(x.label, 18).padEnd(18, " "))}${fg(this.theme.pink)(String(x.value).padStart(3, " ") + " ")}`.chunks,
            ...this.statBar(x.value, topMax, 20, [this.theme.pink, this.theme.peach]),
          ]),
        )
      }
    }
    lines.push(null)

    lines.push(t`${bold(fg(this.theme.sky)(" 最近播放"))}`)
    if (!s.recent.length) {
      lines.push(t`${fg(this.theme.overlay)("  (还没有最近播放记录)")}`)
    } else {
      const now = Date.now()
      for (const x of s.recent) {
        lines.push(
          t`${fg(this.theme.overlay)("  \uF017 ")}${fg(this.theme.text)(clipWidth(x.label, 26).padEnd(26, " "))}${fg(this.theme.subtext)(fmtAgo(x.value, now))}`,
        )
      }
    }

    for (let i = 0; i < this.statsRows.length; i++) {
      const l = lines[i]
      this.statsRows[i].content = l ?? ""
    }
  }

  // =========================================================
  //  r-1.0 通知浮层 (toast)
  // =========================================================

  /** 推一条通知浮层 (仅动效循环运行时显示; 测试/静态场景只走状态栏 flash) */
  private pushToast(text: string, color: string) {
    if (!this.animTimer) return
    this.ensureToastBoxes()
    this.toasts.push({ id: ++this.toastSeq, text, color, at: Date.now() })
    while (this.toasts.length > TOAST_MAX) this.toasts.shift()
  }

  /** 每帧重画通知浮层 (右侧滑入 + 淡出) */
  private updateToasts() {
    if (!this.animTimer) {
      for (const tb of this.toastBoxes) tb.box.visible = false
      return
    }
    if (this.toasts.length && !this.toastBoxes.length) this.ensureToastBoxes()
    if (!this.toastBoxes.length) return
    const now = Date.now()
    this.toasts = this.toasts.filter((t) => now - t.at < TOAST_MS)
    for (let i = 0; i < this.toastBoxes.length; i++) {
      const tb = this.toastBoxes[i]
      // 最新的一条在最下 (i=0)
      const item = this.toasts[this.toasts.length - 1 - i]
      if (!item) {
        tb.box.visible = false
        continue
      }
      const age = now - item.at
      const enter = Math.min(1, age / 170)
      const ease = 1 - (1 - enter) * (1 - enter)
      const fade = Math.min(1, Math.max(0, (TOAST_MS - age) / 280))
      tb.box.visible = true
      tb.box.opacity = Math.max(0, Math.min(1, fade * ease))
      tb.box.right = Math.round(2 + (1 - ease) * 12)
      tb.box.borderColor = item.color
      tb.text.content = t`${fg(item.color)("\uF0A1 ")}${fg(this.theme.text)(clipWidth(item.text, 40))}`
    }
  }

  // =========================================================
  //  r-1.0 装饰动效 (每帧)
  // =========================================================

  /** 顶栏 logo: 渐变流动 + 高光扫过 */
  private updateLogo() {
    if (!this.logoText) return
    const chars = [..."\uF025 蓝汐音乐"]
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink, this.theme.peach, this.theme.yellow, this.theme.green]
    const now = Date.now()
    const flow = (now / 1000) * 0.14
    const sweep = (((now / 1000) * 0.5) % 1.7) - 0.35
    const parts: TextChunk[] = chars.map((ch, i) => {
      const u = i / Math.max(1, chars.length - 1)
      let col = paletteAt(pal, u * 0.7 + flow)
      const d = Math.abs(u - sweep)
      if (d < 0.22) col = mixHex(col, this.theme.white, (1 - d / 0.22) * 0.7)
      return bold(fg(col)(ch))
    })
    this.logoText.content = new StyledText(parts)
  }

  /** 程序化频谱可视化 (非真实 FFT, 无 cava 依赖): 对称条形 + 峰值闪光 */
  private updateSpectrum() {
    if (!this.spectrumText) return
    const p = this.p
    if (p.currentPath !== this.spectrumSeedPath) this.refreshSpectrumSeed()
    const W = typeof this.spectrumText.width === "number" && this.spectrumText.width > 8 ? this.spectrumText.width : 48
    const cols = Math.max(8, Math.min(56, W - 1))
    if (this.spectrumPeaks.length !== cols) this.spectrumPeaks = new Array(cols).fill(0)
    const now = Date.now() / 1000
    const playing = p.playing && !p.paused
    const energy = playing
      ? 0.5 + 0.5 * Math.abs(Math.sin(now * 1.55 + this.spectrumSeed))
      : p.playing
        ? 0.18
        : 0.06
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink, this.theme.peach]
    const half = Math.max(4, Math.floor(cols / 2))
    const parts: TextChunk[] = []
    const s = this.spectrumSeed
    for (let i = 0; i < cols; i++) {
      const x = i < half ? i : cols - 1 - i
      const lowBias = 1 - (x / half) * 0.5
      const raw =
        Math.sin(now * 3.1 + x * 0.52 + s) * 0.5 +
        Math.sin(now * 5.9 + x * 1.31 + s * 2.3) * 0.32 +
        Math.sin(now * 1.27 + x * 0.17 + s * 0.7) * 0.18
      const level = Math.max(0, Math.min(1, Math.abs(raw) * lowBias * energy * 1.7))
      const idx = Math.round(level * (BLOCK_CHARS.length - 1))
      const pk = Math.max(this.spectrumPeaks[i] - 0.014, level)
      this.spectrumPeaks[i] = pk
      let col = paletteAt(pal, x / half * 0.8 + now * 0.04)
      if (level > pk - 0.07) col = mixHex(col, this.theme.white, 0.5)
      parts.push(fg(col)(BLOCK_CHARS[idx]))
    }
    this.spectrumText.content = new StyledText(parts)
  }

  /** 换歌时重置频谱种子 (波形换样) */
  private refreshSpectrumSeed() {
    const path = this.p.currentPath ?? ""
    this.spectrumSeedPath = this.p.currentPath
    let h = 2166136261
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    this.spectrumSeed = ((h >>> 0) % 1000) / 1000
  }

  /** tab 激活指示条: 在 tab 之间平滑滑动, 渐变流动 + 两端淡出 */
  private updateTabIndicator() {
    if (!this.tabIndicator || !this.tabIndBox) return
    const target = TAB_KEYS.indexOf(this.view)
    if (this.animTimer) this.tabIndicatorPos += (target - this.tabIndicatorPos) * 0.24
    else this.tabIndicatorPos = target
    if (Math.abs(this.tabIndicatorPos - target) < 0.01) this.tabIndicatorPos = target
    const i0 = Math.max(0, Math.min(TAB_KEYS.length - 1, Math.floor(this.tabIndicatorPos)))
    const i1 = Math.min(TAB_KEYS.length - 1, i0 + 1)
    const f = this.tabIndicatorPos - i0
    const a = this.tabBtns[i0]
    const b = this.tabBtns[i1] ?? a
    const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt)
    const ax = num(a?.screenX, 1)
    const aw = Math.max(1, num(a?.width, 10))
    const bx = num(b?.screenX, ax)
    const bw = Math.max(1, num(b?.width, aw))
    const x = ax + (bx - ax) * f
    const w = Math.max(1, Math.round(aw + (bw - aw) * f))
    const boxX = num(this.tabIndBox?.screenX, x)
    this.tabIndicator.left = Math.max(0, Math.round(x - boxX))
    const pal = RAINBOW_KEYS.map((k) => this.theme[k])
    const flow = (Date.now() / 1000) * 0.22
    const parts: TextChunk[] = []
    for (let i = 0; i < w; i++) {
      let col = paletteAt(pal, (i / Math.max(1, w - 1)) * 1.1 + flow)
      const edge = Math.min(i, w - 1 - i) / Math.max(1, (w - 1) * 0.3)
      if (edge < 1) col = mixHex(this.theme.mantle, col, edge)
      parts.push(fg(col)("▀"))
    }
    this.tabIndicator.content = new StyledText(parts)
  }

  /**
   * 推进选中行的跑马灯 (tick 10fps 调用)。
   * 只改选中行的标题文本, 不碰底色 — 底色唯一由 updatePlaylist 写,
   * 避免两处同时写同一节点导致快速上下切换时闪来闪去。
   */
  private advanceMarquee() {
    const m = this.selMarquee
    if (!m) return
    const row = this.plRows[this.sel]
    if (!row) return
    const phase = Math.floor((Date.now() - this.marqueeAnchor) / 100)
    const col =
      this.sel === this.p.idx
        ? mixHex(this.theme.green, this.theme.sky, 0.15 + 0.7 * pulse(Date.now(), 2600))
        : this.theme.text
    row.text.content = t`${bold(fg(col)(scrollText(m.text, m.width, phase)))}`
  }

  /** 视图切换过渡: 列表边框扫光 + 指示条滑动 */
  private updateViewTransition() {
    if (!this.plBox) return
    if (this.viewAnimT >= 1) {
      this.plBox.borderColor = this.theme.surface1
      return
    }
    this.viewAnimT = Math.min(1, this.viewAnimT + 0.085)
    const e = 1 - Math.pow(1 - this.viewAnimT, 3)
    this.plBox.borderColor = this.viewAnimT >= 1 ? this.theme.surface1 : mixHex(this.theme.sky, this.theme.surface1, e)
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
        paddingLeft: 1,
        backgroundColor: this.theme.base,
        onMouseDown: () => {
          this.onRowClick(rowIdx)
        },
      })
      // r-1.0: 左侧选择指示条 (选中/播放行由 updatePlaylist 上色)
      const lead = new TextRenderable(this.renderer, {
        content: " ",
        selectable: false,
        width: 1,
        wrapMode: "none",
      })
      box.add(lead)
      // 序号 / 播放标记列 (固定宽度, 右对齐)
      const num = new TextRenderable(this.renderer, { content: "", selectable: false, wrapMode: "none" })
      box.add(num)
      // 标题列 (弹性, 超长滚动)
      const text = new TextRenderable(this.renderer, {
        content: "",
        selectable: false,
        flexGrow: 1,
        wrapMode: "none",
      })
      box.add(text)
      // 右列元信息 (格式 + 时长)
      const meta = new TextRenderable(this.renderer, {
        content: "",
        selectable: false,
        paddingLeft: 1,
        paddingRight: 1,
        wrapMode: "none",
      })
      box.add(meta)
      this.scrollbox.add(box)
      this.plRows.push({ box, lead, num, text, meta })
    }
  }

  /** 行点击: 根据视图行为不同 */
  private onRowClick(i: number) {
    const p = this.p
    if (this.view === "queue") {
      this.sel = i
      this.updatePlaylist()
      this.queuePlaySel()
      return
    }
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

  /** 当前视图每行数据: { marker, num, text, meta, playing }
   *  num = 右对齐序号列; text = 标题 (超长滚动); meta = 右侧格式/时长 */
  private rowAt(i: number): { marker: string; num: string; text: string; meta: string; playing: boolean } {
    const p = this.p
    const numW = Math.max(2, String(Math.max(1, this.listCount())).length)
    const idxStr = String(i + 1).padStart(numW, " ")
    if (this.view === "settings") {
      const vol = p.volume
      const filled = Math.round((vol / 150) * 20)
      const bar = "█".repeat(filled) + "░".repeat(20 - filled)
      const mute = p.muted ? " \uF026" : ""
      const dirCount = p.scanRoots().length
      const dirLabel = dirCount > 1 ? `${dirCount} 个目录 · ${clipWidth(p.musicDir, 70)}` : clipWidth(p.musicDir, 80)
      const rows = [
        `主题        ${THEME_LABEL[this.themeName]}  (${THEME_ORDER.length} 种, ←/→ 或 Enter 切换)`,
        `音量        ${bar} ${vol}${mute}  (←/→ 或 +/- 调整, 自动保存)`,
        `倍速        ${p.speed.toFixed(2)}x  (←/→ 步进 0.25, 0.25x~4x, 自动保存)`,
        `歌词延迟    ${p.lyricDelay > 0 ? "+" : ""}${p.lyricDelay.toFixed(2)}s  (←/→ 或 , ; 步进 0.25, -5~5s, 自动保存)`,
        `睡眠定时    ${p.sleepMinutes === 0 ? "关闭" : `${p.sleepMinutes} 分钟`}  (←/→ 或 z 切换, 到点渐弱暂停)`,
        `音乐目录    ${dirLabel}  (Enter 管理多目录)`,
        `列表排序    ${SORT_LABEL[p.sortMode]}${p.sortAsc ? " ↑" : " ↓"}  (←/→ 切换字段, Enter 打开菜单, 自动保存)`,
        `缓存目录    ${clipWidth(CACHE_DIR, 90)}  (Enter 查看/清空)`,
        `版本        ${VERSION}  (只读 · 帮助 h 查看更多)`,
      ]
      return { marker: " ", num: "", text: rows[i] || "", meta: "", playing: false }
    }
    if (this.view === "queue") {
      const real = p.queue[i]
      const path = real !== undefined ? p.playlist[real] : undefined
      if (path === undefined) return { marker: " ", num: "", text: "", meta: "", playing: false }
      const isCur = real === p.idx
      return {
        marker: isCur ? "\uF04B" : " ",
        num: idxStr,
        text: `${titleOf(path)}${isCur ? "  · 正在播放" : ""}`,
        meta: metaOf(path, p.durationOf(path)),
        playing: isCur,
      }
    }
    if (this.view === "pl") {
      if (this.plLevel === "list") {
        const list = p.playlists
        const pl = list[i]
        if (!pl) return { marker: " ", num: "", text: "", meta: "", playing: false }
        return { marker: " ", num: idxStr, text: `${pl.name}  (${pl.paths.length} 首)`, meta: "", playing: false }
      }
      if (this.plPickerMode) {
        const path = p.playlist[i]
        if (!path) return { marker: " ", num: "", text: "", meta: "", playing: false }
        const inPl = this.plCurrent ? p.playlistPaths(this.plCurrent).includes(path) : false
        return {
          marker: inPl ? "\uF067" : " ",
          num: idxStr,
          text: titleOf(path),
          meta: metaOf(path, p.durationOf(path)),
          playing: i === p.idx,
        }
      }
      // detail
      if (!this.plCurrent) return { marker: " ", num: "", text: "", meta: "", playing: false }
      const paths = p.playlistPaths(this.plCurrent)
      const path = paths[i]
      if (!path) return { marker: " ", num: "", text: "", meta: "", playing: false }
      const realIdx = p.playlist.indexOf(path)
      return {
        marker: " ",
        num: idxStr,
        text: titleOf(path),
        meta: metaOf(path, p.durationOf(path)),
        playing: realIdx === p.idx,
      }
    }
    // list / fav
    const useQueue = this.searchActive || this.view === "fav" || p.favMode
    const orig = useQueue ? p.queue[i] : i
    if (orig === undefined || !p.playlist[orig]) return { marker: " ", num: "", text: "", meta: "", playing: false }
    const path = p.playlist[orig]
    const fav = p.favorites.includes(path)
    const cnt = p.playCountOf(path)
    const cntStr = cnt > 0 ? ` \uF001 ${cnt}` : ""
    return {
      marker: orig === p.idx ? "\uF04B" : " ",
      num: idxStr,
      text: `${titleOf(path)}${fav ? " \uF004" : ""}${cntStr}`,
      meta: metaOf(path, p.durationOf(path)),
      playing: orig === p.idx,
    }
  }

  updatePlaylist() {
    const p = this.p
    const n = this.listCount()
    if (this.plRows.length !== n) this.rebuildPlaylistRows(n)
    // 选中变化: 重置跑马灯锚点 → 新选中行从第 0 帧平滑开始滚动
    // (旧实现直接用全局 tickCount 当相位, 快速上下切换时文字会随机跳位, 看起来闪来闪去)
    if (this.sel !== this.lastMarqueeSel) {
      this.lastMarqueeSel = this.sel
      this.marqueeAnchor = Date.now()
    }
    const mPhase = Math.floor((Date.now() - this.marqueeAnchor) / 100)
    this.selMarquee = null
    // 行可用宽度: 布局前未知则用 100 兜底 (滚动/截断自适应)
    const availW = typeof this.scrollbox.width === "number" && this.scrollbox.width > 1 ? this.scrollbox.width : 100
    for (let i = 0; i < n; i++) {
      const row = this.plRows[i]
      const { marker, num, text, meta, playing } = this.rowAt(i)
      const isSel = i === this.sel
      const hasMark = marker.trim() !== ""
      const metaW = displayWidth(meta)
      const numW2 = displayWidth(num) + (num ? 1 : 0) + (hasMark ? 2 : 0) + 1
      const nameW = Math.max(8, availW - metaW - numW2 - 4)
      // 标题超长时滚动 (marquee); 仅选中/播放行滚动, 其余截断
      const shown = isSel || playing ? scrollText(text, nameW, mPhase) : clipWidth(text, nameW)
      if (isSel) this.selMarquee = displayWidth(text) > nameW ? { text, width: nameW } : null
      const box = row.box
      const markStr = hasMark ? `${marker} ` : ""
      const numCol = num ? `${num} ` : ""
      if (isSel) {
        box.backgroundColor = this.theme.surface1
        row.lead.content = t`${fg(this.theme.sky)("▌")}`
        row.num.content = t`${fg(this.theme.green)(markStr)}${bold(fg(this.theme.sky)(numCol))}`
        row.text.content = t`${bold(fg(this.theme.text)(shown))}`
        row.meta.content = t`${fg(this.theme.text)(meta)}`
      } else if (playing) {
        box.backgroundColor = this.theme.base
        // 播放行: 绿色标识随播放呼吸 (10fps tick 驱动, 周期 2.6s 足够平滑)
        const markCol = mixHex(this.theme.green, this.theme.sky, 0.15 + 0.7 * pulse(Date.now(), 2600))
        row.lead.content = t`${fg(this.theme.green)("▌")}`
        row.num.content = t`${fg(markCol)(markStr)}${fg(this.theme.overlay)(numCol)}`
        row.text.content = t`${bold(fg(markCol)(shown))}`
        row.meta.content = t`${fg(this.theme.green)(meta)}`
      } else {
        box.backgroundColor = this.theme.base
        row.lead.content = " "
        row.num.content = t`${fg(this.theme.overlay)(numCol)}`
        row.text.content = t`${fg(this.theme.text)(shown)}`
        row.meta.content = t`${fg(this.theme.overlay)(meta)}`
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
    if (this.view === "queue") {
      const pos = p.queuePos()
      const at = pos >= 0 ? `第 ${pos + 1}/${p.queue.length} 位` : `不在队列 (${p.queue.length} 首)`
      return ` \uF0CA 播放队列 · ${at} · w 插队 · e 加队 · J/K 移动 · x 移除 · c 清空 `
    }
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

    // 睡眠定时器到点: 渐弱 7 秒后暂停 (而非突然静音)
    if (p.sleepExpired()) {
      p.fadeState = null
      this.sleepFading = true
      this.sleepFadeFrom = p.volume
      this.sleepFadeAt = Date.now()
      this.flash("\uF017 睡眠定时到点啦喵~ 正在渐弱…", 3)
      this.updatePlaylist()
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
        this.flash("\uF017 睡眠定时已暂停播放喵~", 3)
      }
    }

    // 布局维护: 歌词区无内容时自动收起 (让列表更大); 列表标题分隔线宽度更新
    const lyricOn = p.showLyrics && p.lyrics.length > 0
    if (this.lyricsBox.visible !== lyricOn) this.lyricsBox.visible = lyricOn
    const plW = Math.max(0, Math.floor(this.scrollbox.width || 0))
    if (plW !== this.lastPlDivW) {
      this.lastPlDivW = plW
      // 右端渐隐的细线 (纯装饰, 宽度变化时才重画)
      const parts: TextChunk[] = []
      for (let i = 0; i < plW - 1; i++) {
        parts.push(fg(mixHex(this.theme.surface2, this.theme.base, Math.pow(i / Math.max(1, plW - 2), 0.8)))("─"))
      }
      this.plDivider.content = plW > 2 ? new StyledText(parts) : ""
    }

    // 装饰动效 (等化器/彩虹条/频谱/指示条/高亮): 动效循环运行时由 animTick 以 30fps 重画, 这里兜底刷新
    this.updateLogo()
    this.updateEq()
    this.updateAccent()
    this.updateSpectrum()
    this.updateTabIndicator()
    this.advanceMarquee()
    this.updateViewTransition()
    if (this.showStats) this.updateStats()
    if (this.showSort) this.updateSortMenu()
    if (this.showDirManager) this.updateDirManager()
    if (this.animTimer) this.syncAnimRate()

    // 头部信息: 视图 + 模式
    const mode =
      this.view === "settings" ? "\uF013 设置" :
      this.view === "queue" ? "\uF0CA 队列" :
      p.isShuffle ? "\uF074 随机" :
      this.searchActive ? "\uF002 搜索" :
      this.view === "fav" ? "\uF004 收藏" :
      this.view === "pl" ? "\uF1C5 歌单" : "\uF001 列表"
    this.headModeText.content = ` ${mode} `
    const volStr = p.muted ? "\uF026 静音" : `音量 ${p.volume}`
    const sleepStr = p.sleepUntil ? ` \uF017 ${fmt(p.sleepRemaining())}` : ""
    this.headRightText.content = clipWidth(
      `${sleepStr} ┊ ${REPEAT_LABEL[p.repeat]} ┊ ${volStr}${p.speed !== 1 ? " ┊ ×" + p.speed.toFixed(2) : ""} `,
      52,
    )

    // 导航栏播放统计 (仅总量变化时写)
    if (p.totalPlayCount !== this.playsTotal) {
      this.playsTotal = p.totalPlayCount
      this.playsStat.content = ` \uF001 共播放 ${p.totalPlayCount} 次 `
    }

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

    // 底部状态 (窄终端下截断防溢出)
    if (!this.searchMode) {
      if (Date.now() < this.msgUntil) {
        this.statusLeft.content = clipWidth(this.msg, 120)
        this.statusLeft.fg = this.theme.pink
      } else {
        this.statusLeft.content = clipWidth(
          "空格 播放 · n/p 切歌 · f 收藏 · R 改名 · D 删除 · 1/2/3/4 视图 · / 搜索 · M 静音 · h 帮助 · q 退出",
          120,
        )
        this.statusLeft.fg = this.theme.subtext
      }
    }
    const volGlyphStr = p.muted ? "\uF026 静音" : `${volGlyph(p.volume)} ${p.volume}`
    this.statusRight.content = p.playing
      ? clipWidth(` ${p.currentBase()} · ${String(p.idx + 1)}/${p.playlist.length} · ${volGlyphStr} `, 60)
      : clipWidth(` 共 ${p.playlist.length} 首 · ${volGlyphStr} `, 60)

    // 淡入淡出
    // 淡入淡出 (睡眠渐弱期间交给 sleepFading 逻辑, 避免两处同时写 mpv volume)
    if (!this.sleepFading) p.updateFade()

    // duration 兜底
    if (p.playing && p.duration <= 0 && this.tickCount % 10 === 0) {
      p.mpv.getProperty<number>("duration").then((d) => {
        if (typeof d === "number" && Number.isFinite(d) && d > 0) p.duration = d
      })
    }

    // 全屏歌词刷新
    if (this.fullLyrics) this.updateFullLyrics()
  }

  // =========================================================
  //  装饰动效循环 (独立于 100ms tick; 入口调用 startAnimLoop)
  // =========================================================

  /** 启动装饰动效循环; 由 index.ts 在 renderer 就绪后调用 (测试不调用 → 无定时器) */
  startAnimLoop() {
    this.syncAnimRate(true)
  }

  /** 停止动效循环 (退出清理; 必须在 renderer.destroy 前调用) */
  stopAnimLoop() {
    clearInterval(this.animTimer)
    this.animTimer = undefined
    this.animMs = 0
  }

  /** 动效帧率自适应: 播放/全屏歌词 30fps, 待机降频省电 */
  private syncAnimRate(force = false) {
    const want = (this.p.playing && !this.p.paused) || this.fullLyrics ? ANIM_FAST_MS : ANIM_IDLE_MS
    if (!force && want === this.animMs) return
    this.animMs = want
    clearInterval(this.animTimer)
    this.animTimer = setInterval(() => this.animTick(), want)
  }

  /**
   * 一帧动效: 只重画装饰 (LOGO/等化器/彩虹条/频谱/进度条/tab/通知)。
   * 不碰列表行底色/文本 — 那由 updatePlaylist 独占, 避免两份真相源互踩闪烁。
   * 跑马灯由 tick 的 advanceMarquee 推进 (10fps 足够顺滑)。
   */
  private animTick() {
    this.updateLogo()
    this.updateEq()
    this.updateAccent()
    this.updateSpectrum()
    this.updateNowPlaying()
    this.stepTabAnim()
    this.updateTabIndicator()
    this.updateViewTransition()
    this.updateToasts()
    if (this.showStats) this.updateStats()
    if (this.showSort) this.updateSortMenu()
    if (this.showDirManager) this.updateDirManager()
    if (this.fullLyrics) this.updateFullLyrics()
  }

  /** 头部伪频谱等化器 (播放时按秒级相位跳动, 否则静止) */
  private updateEq() {
    const p = this.p
    if (!p.playing || p.paused) {
      this.eqText.content = t`${fg(this.theme.overlay)("▁ ▁ ▁ ▁ ▁ ▁")}`
      return
    }
    const now = Date.now() / 1000
    const cols = [this.theme.sky, this.theme.lavender, this.theme.pink, this.theme.peach, this.theme.yellow, this.theme.sky]
    const parts: TextChunk[] = EQ_CHARS.map((_, i) => {
      const v = Math.abs(Math.sin(now * 3.5 + i * 1.7) * Math.cos(now * 1.8 + i * 0.9))
      return fg(cols[i])(EQ_CHARS[Math.min(EQ_CHARS.length - 1, Math.floor(v * EQ_CHARS.length))])
    })
    this.eqText.content = new StyledText(parts)
  }

  /** 顶部彩虹条: 居中缩窄的细条, 渐变缓慢流动 + 两端淡出 (播放时轻微呼吸/增亮) */
  private updateAccent() {
    const termW = this.renderer.width || 80
    const w = Math.max(8, Math.min(56, Math.floor(termW * 0.42), Math.max(8, termW - 2)))
    const pal = RAINBOW_KEYS.map((k) => this.theme[k])
    const now = Date.now()
    const flow = (now / 1000) * 0.07 // 走完一轮彩虹 ≈ 14s
    const energy = this.p.playing && !this.p.paused ? 0.78 + 0.22 * pulse(now, 2600) : 0.62
    const parts: TextChunk[] = []
    for (let i = 0; i < w; i++) {
      let col = paletteAt(pal, i / Math.max(1, w - 1) + flow)
      const edge = Math.min(i, w - 1 - i) / Math.max(1, (w - 1) * 0.17)
      if (edge < 1) col = mixHex(this.theme.base, col, edge)
      col = mixHex(this.theme.base, col, energy)
      parts.push(fg(col)("▄"))
    }
    this.accentText.content = new StyledText(parts)
  }

  /** 更新"正在播放"卡片与进度条 (含动效: 渐变流动/光点/分隔线/边框呼吸) */
  updateNowPlaying() {
    const p = this.p
    const status = p.playing ? (p.paused ? "\uF04C 已暂停" : "\uF04B 播放中") : "\uF04D 待机"
    this.nowStatusText.content = status
    this.nowStatusText.fg = p.playing ? (p.paused ? this.theme.yellow : this.theme.green) : this.theme.subtext
    let title = p.currentTitle()
    const artist = p.currentArtist()
    if (artist) title += ` ┊ ${artist}`
    // 当前歌曲累计播放次数 (仅播过时显示)
    const cnt = p.playCountOf(p.currentPath)
    if (cnt > 0) title += `  · 已播放 ${cnt} 次`
    // 终端尺寸自适应: 窄终端下截断长标题, 防溢出
    this.nowTitleText.content = clipWidth(title, 80)

    const innerW = (this.timeBox.width || 20) - (this.timeText.width || 18) - 3
    const barw = Math.max(6, Math.min(60, innerW))
    const dur = p.duration
    const tpos = p.timePos
    const pct = dur > 0 ? Math.max(0, Math.min(1, tpos / dur)) : 0
    const now = Date.now()
    const playing = p.playing && !p.paused
    // 8x 高分辨率: 用 9 段分数块 ▏▎▍▌▋▊▉█ 平滑填充
    const FRAC = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
    const units = Math.round(barw * 8 * pct)
    const full = Math.floor(units / 8)
    const rem = units % 8
    const tail = Math.max(barw - full - (rem ? 1 : 0), 0)
    // 填充段: 三色渐变随时间流动 (暂停时降速并去饱和), 播放时有光点沿进度扫过
    const PROG_PAL = [this.theme.sky, this.theme.lavender, this.theme.pink]
    const flow = (now / 1000) * (playing ? 0.3 : 0.06)
    const shine = playing ? (((now / 1000) * 0.42) % 1.5) - 0.25 : -1
    const parts: TextChunk[] = []
    for (let j = 0; j < full; j++) {
      const u = j / Math.max(1, full)
      let col = paletteAt(PROG_PAL, u + flow)
      const d = Math.abs(u - shine)
      if (d < 0.09) col = mixHex(col, this.theme.text, (1 - d / 0.09) * 0.75)
      if (!playing) col = mixHex(col, this.theme.surface1, 0.5)
      parts.push(fg(col)("█"))
    }
    if (rem > 0) {
      const col = paletteAt(PROG_PAL, (full + 0.5) / Math.max(1, full) + flow)
      parts.push(fg(playing ? col : mixHex(col, this.theme.surface1, 0.5))(FRAC[rem]))
    }
    if (tail > 0) parts.push(fg(this.theme.surface1)("░".repeat(tail)))
    this.progressText.content = new StyledText(parts)
    const durText = dur > 0 ? fmt(dur) : "--:--"
    const pctText = dur > 0 ? String(Math.round(pct * 100)).padStart(3) : "---"
    this.timeText.content = ` ${fmt(tpos)} / ${durText}  ${pctText}% `
    // 卡片底部渐变分隔线: 居中缩窄 + 渐变流动 + 两端淡出到卡片底色
    const cardInner = Math.max(10, (this.nowPlayBox.width || 80) - 6)
    const dib = Math.max(6, Math.round(cardInner * 0.62))
    const dflow = (now / 1000) * 0.12
    const dparts: TextChunk[] = []
    for (let i = 0; i < dib; i++) {
      let col = paletteAt(PROG_PAL, i / Math.max(1, dib - 1) + dflow)
      const edge = Math.min(i, dib - 1 - i) / Math.max(1, (dib - 1) * 0.28)
      if (edge < 1) col = mixHex(this.theme.crust, col, edge)
      dparts.push(fg(col)("╸"))
    }
    this.nowDivider.content = new StyledText(dparts)
    // 卡片边框呼吸: 播放时在 surface1↔lavender 之间缓慢脉动, 暂停偏黄, 待机静止
    const glow = p.playing ? (p.paused ? 0.22 : 0.16 + 0.48 * pulse(now, 3200)) : 0
    this.nowPlayBox.borderColor = glow > 0 ? mixHex(this.theme.surface1, p.paused ? this.theme.yellow : this.theme.lavender, glow) : this.theme.surface1
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
    // 歌词延迟: 匹配时间 = 播放位置 - 延迟 (延迟>0 时歌词滞后于声音)
    const lyricTime = p.timePos - p.lyricDelay
    for (let i = 0; i < p.lyrics.length; i++) {
      if (p.lyrics[i].time <= lyricTime) cur = i
      else break
    }
    if (cur < 0) cur = 0
    // 同一时间戳的多句 (和声/重复词) 一起高亮
    const curTime = p.lyrics[cur].time
    if (this.lyricRows.length !== H) this.buildLyricRows(H)
    const center = Math.floor(H / 2)
    for (let r = 0; r < H; r++) {
      const lineIdx = cur + (r - center)
      const row = this.lyricRows[r]
      if (lineIdx >= 0 && lineIdx < p.lyrics.length) {
        const maxW = (this.lyricInner.width || 40) - 4
        const isCur = p.lyrics[lineIdx].time === curTime
        // 当前句: 超长时行内滚动; 其它句: 截断
        const txt = isCur
          ? scrollText(p.lyrics[lineIdx].text, maxW, this.tickCount)
          : clipWidth(p.lyrics[lineIdx].text, maxW)
        if (isCur) {
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
    const tpos = p.timePos - p.lyricDelay
    const pct = dur > 0 ? Math.max(0, Math.min(1, tpos / dur)) : 0
    const barw = Math.max(10, (this.fullOverlay.width || 40) - 24)
    const filled = Math.round(barw * pct)
    const durText = dur > 0 ? fmt(dur) : "--:--"
    // 三色渐变随时间流动 (与卡片进度条同一套观感)
    const pal = [this.theme.sky, this.theme.lavender, this.theme.pink]
    const flow = (Date.now() / 1000) * 0.3
    const barParts: TextChunk[] = []
    for (let j = 0; j < filled; j++) {
      barParts.push(fg(paletteAt(pal, j / Math.max(1, filled) + flow))("█"))
    }
    if (barw - filled > 0) barParts.push(fg(this.theme.surface1)("░".repeat(barw - filled)))
    barParts.push(fg(this.theme.subtext)(` ${fmt(Math.max(0, tpos))} / ${durText}`))
    this.fullProgress.content = new StyledText(barParts)
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
    // 同一时间戳的多句一起高亮
    const curTime = p.lyrics[cur].time
    const MID = Math.floor(this.fullLyricRows.length / 2)
    const ow = this.fullOverlay.width
    const fullMaxW = Math.max(30, (typeof ow === "number" && ow > 30 ? ow : this.renderer.width || 100) - 14)
    for (let r = 0; r < this.fullLyricRows.length; r++) {
      const offset = r - MID
      const idx = cur + offset
      const row = this.fullLyricRows[r]
      if (idx >= 0 && idx < p.lyrics.length && p.lyrics[idx].time === curTime) {
        // 当前句: 超长时行内滚动
        const txt = scrollText(p.lyrics[idx].text, fullMaxW, this.tickCount)
        row.content = t`${fg(this.theme.sky)(bold("\uF001     " + txt))}`
      } else if (idx >= 0 && idx < p.lyrics.length) {
        const col = Math.abs(offset) <= 1 ? this.theme.subtext : this.theme.overlay
        row.content = t`${fg(col)("      " + clipWidth(p.lyrics[idx].text, fullMaxW))}`
      } else {
        row.content = ""
      }
    }
  }
}
