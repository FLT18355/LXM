/**
 * UI 组件构建器 — 只负责搭节点树, 不持有 UI 状态。
 *
 * 所有 builder 都返回节点引用, 由 PlayerUI 在 tick/animTick 中写内容。
 * 主题在 applyTheme 时整树重建, 因此这里一律从当前 theme 取色, 不缓存颜色。
 */
import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type StyledText,
} from "@opentui/core"
import type { Theme } from "../theme"

export type RowNodes = {
  box: BoxRenderable
  lead: TextRenderable
  num: TextRenderable
  title: TextRenderable
  tag: TextRenderable
  meta: TextRenderable
}

/** 面板通用参数 */
type PanelOpts = {
  title?: string
  titleColor: string
  borderColor: string
  bottomTitle?: string
  height?: number | `${number}%`
  flexGrow?: number
  flexBasis?: number
  minHeight?: number
  marginTop?: number
}

/** 圆角面板: 背景 base, 圆角边框, 标题在左上, 提示在左下 */
export function panel(r: CliRenderer, th: Theme, o: PanelOpts): BoxRenderable {
  return new BoxRenderable(r, {
    flexDirection: "column",
    flexGrow: o.flexGrow ?? 0,
    flexBasis: o.flexBasis,
    minHeight: o.minHeight,
    height: o.height,
    marginLeft: 1,
    marginRight: 1,
    marginTop: o.marginTop ?? 1,
    backgroundColor: th.base,
    borderStyle: "rounded",
    borderColor: o.borderColor,
    title: o.title,
    titleColor: o.titleColor,
    titleAlignment: "left",
    bottomTitle: o.bottomTitle,
    bottomTitleAlignment: "left",
  })
}

// ── 顶栏 ─────────────────────────────────────────────────────

export type HeaderNodes = {
  box: BoxRenderable
  logo: TextRenderable
  mode: TextRenderable
  right: TextRenderable
}

export function buildHeader(r: CliRenderer, th: Theme): HeaderNodes {
  const box = new BoxRenderable(r, {
    height: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: th.mantle,
  })
  const left = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1, flexShrink: 1 })
  const logo = new TextRenderable(r, {
    content: "蓝汐音乐",
    fg: th.text,
    attributes: 1, // BOLD
    selectable: false,
    wrapMode: "none",
  })
  left.add(logo)
  // 视图/模式徽标: 内容由 tick 写 (带背景色的小胶囊)
  const mode = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
  left.add(mode)
  box.add(left)
  const right = new TextRenderable(r, {
    content: "",
    fg: th.overlay,
    selectable: false,
    wrapMode: "none",
    flexShrink: 1,
    textAlign: "right",
  })
  box.add(right)
  return { box, logo, mode, right }
}

// ── 正在播放卡片 ──────────────────────────────────────────────

export type PlayerNodes = {
  box: BoxRenderable
  status: TextRenderable
  title: TextRenderable
  sub: TextRenderable
  bar: TextRenderable
  time: TextRenderable
  spec: TextRenderable
  divider: TextRenderable
}

export function buildPlayer(r: CliRenderer, th: Theme): PlayerNodes {
  const box = new BoxRenderable(r, {
    flexDirection: "column",
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
    backgroundColor: th.crust,
    borderStyle: "rounded",
    borderColor: th.surface1,
    title: " 正在播放 ",
    titleColor: th.sky,
    paddingLeft: 1,
    paddingRight: 1,
    gap: 0,
  })
  const row1 = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1, height: 1 })
  const status = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", flexShrink: 0 })
  row1.add(status)
  const title = new TextRenderable(r, {
    content: "—",
    fg: th.text,
    selectable: false,
    wrapMode: "none",
    flexGrow: 1,
    flexShrink: 1,
  })
  row1.add(title)
  box.add(row1)

  // 艺术家 · 播放次数 · 曲序
  const sub = new TextRenderable(r, { content: "", fg: th.overlay, selectable: false, wrapMode: "none", height: 1 })
  box.add(sub)

  const row2 = new BoxRenderable(r, { flexDirection: "row", alignItems: "center", gap: 1, height: 1 })
  const bar = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", flexGrow: 1 })
  row2.add(bar)
  const time = new TextRenderable(r, { content: "00:00 / 00:00", fg: th.subtext, selectable: false, wrapMode: "none" })
  row2.add(time)
  box.add(row2)

  const spec = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1, flexShrink: 1 })
  box.add(spec)

  const divRow = new BoxRenderable(r, { flexDirection: "row", justifyContent: "center", height: 1 })
  const divider = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none" })
  divRow.add(divider)
  box.add(divRow)
  return { box, status, title, sub, bar, time, spec, divider }
}

// ── 歌词面板 ─────────────────────────────────────────────────

export type LyricNodes = {
  box: BoxRenderable
  inner: BoxRenderable
  rows: TextRenderable[]
}

export function buildLyrics(r: CliRenderer, th: Theme): LyricNodes {
  const box = new BoxRenderable(r, {
    id: "lyricsBox",
    flexDirection: "column",
    height: 7,
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
    backgroundColor: th.base,
    borderStyle: "rounded",
    borderColor: th.surface0,
    title: " 歌词 ",
    titleColor: th.lavender,
    paddingLeft: 2,
    paddingRight: 2,
  })
  const inner = new BoxRenderable(r, { flexDirection: "column", flexGrow: 1, justifyContent: "center" })
  box.add(inner)
  const rows: TextRenderable[] = []
  for (let i = 0; i < 5; i++) {
    const row = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", height: 1, width: "100%" })
    inner.add(row)
    rows.push(row)
  }
  return { box, inner, rows }
}

// ── tab 栏 + 指示条 ───────────────────────────────────────────

export type TabNodes = {
  bar: BoxRenderable
  btns: BoxRenderable[]
  texts: TextRenderable[]
  indicatorBox: BoxRenderable
  indicator: TextRenderable
  right: TextRenderable
}

export function buildTabs(r: CliRenderer, th: Theme, labels: string[], onPick: (i: number) => void): TabNodes {
  const bar = new BoxRenderable(r, {
    height: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
    backgroundColor: th.mantle,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const btns: BoxRenderable[] = []
  const texts: TextRenderable[] = []
  for (let i = 0; i < labels.length; i++) {
    const btn = new BoxRenderable(r, {
      id: `tab-${i}`,
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: th.mantle,
      onMouseDown: () => onPick(i),
    })
    const txt = new TextRenderable(r, { content: labels[i], selectable: false, wrapMode: "none" })
    btn.add(txt)
    bar.add(btn)
    btns.push(btn)
    texts.push(txt)
  }
  const right = new TextRenderable(r, {
    content: "",
    fg: th.overlay,
    selectable: false,
    wrapMode: "none",
    flexGrow: 1,
    textAlign: "right",
  })
  bar.add(right)
  // 指示条单独一行 (渐变), 与 tab 条同底
  const indicatorBox = new BoxRenderable(r, {
    id: "tabIndBox",
    height: 1,
    flexDirection: "row",
    marginLeft: 1,
    marginRight: 1,
    backgroundColor: th.mantle,
  })
  const indicator = new TextRenderable(r, {
    position: "absolute",
    top: 0,
    left: 0,
    content: "",
    selectable: false,
    wrapMode: "none",
  })
  indicatorBox.add(indicator)
  return { bar, btns, texts, indicatorBox, indicator, right }
}

// ── 列表面板 ─────────────────────────────────────────────────

export type ListNodes = {
  box: BoxRenderable
  scroll: ScrollBoxRenderable
  emptyArea: BoxRenderable
  empty: TextRenderable
  footer: TextRenderable
}

export function buildList(r: CliRenderer, th: Theme): ListNodes {
  const box = new BoxRenderable(r, {
    id: "plBox",
    flexDirection: "column",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 3,
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
    backgroundColor: th.base,
    borderStyle: "rounded",
    borderColor: th.surface1,
    title: " 播放列表 ",
    titleColor: th.sky,
  })
  const scroll = new ScrollBoxRenderable(r, {
    id: "scrollbox",
    flexGrow: 1,
    flexBasis: 0,
    scrollbarOptions: {
      trackOptions: { foregroundColor: th.surface1, backgroundColor: th.base },
    },
    rootOptions: { backgroundColor: th.base },
    contentOptions: { backgroundColor: th.base },
  })
  box.add(scroll)
  // 空状态提示 (列表区中央, 无数据时显示)
  const emptyArea = new BoxRenderable(r, {
    flexGrow: 0,
    flexBasis: 0,
    flexDirection: "column",
    justifyContent: "center",
  })
  const empty = new TextRenderable(r, {
    content: "",
    fg: th.overlay,
    selectable: false,
    width: "100%",
    textAlign: "center",
  })
  emptyArea.add(empty)
  box.add(emptyArea)
  const footer = new TextRenderable(r, { content: "", fg: th.overlay, selectable: false, paddingLeft: 1, wrapMode: "none" })
  box.add(footer)
  return { box, scroll, emptyArea, empty, footer }
}

/** 列表行: 选择条 + 序号 + 标题 + 尾部徽标 + 元信息 */
export function buildRow(r: CliRenderer, th: Theme, onClick: () => void): RowNodes {
  const box = new BoxRenderable(r, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: th.base,
    onMouseDown: onClick,
  })
  const lead = new TextRenderable(r, { content: " ", selectable: false, wrapMode: "none" })
  box.add(lead)
  const num = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", flexShrink: 0 })
  box.add(num)
  const title = new TextRenderable(r, {
    content: "",
    selectable: false,
    wrapMode: "none",
    flexGrow: 1,
    flexShrink: 1,
  })
  box.add(title)
  const tag = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", flexShrink: 0 })
  box.add(tag)
  const meta = new TextRenderable(r, { content: "", selectable: false, wrapMode: "none", flexShrink: 0, paddingRight: 1 })
  box.add(meta)
  return { box, lead, num, title, tag, meta }
}

// ── 状态栏 ───────────────────────────────────────────────────

export type StatusNodes = {
  box: BoxRenderable
  left: TextRenderable
  right: TextRenderable
}

export function buildStatus(r: CliRenderer, th: Theme): StatusNodes {
  const box = new BoxRenderable(r, {
    height: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: th.mantle,
  })
  const left = new TextRenderable(r, { content: "", fg: th.subtext, selectable: false, wrapMode: "none", flexShrink: 1 })
  box.add(left)
  const right = new TextRenderable(r, {
    content: "",
    fg: th.overlay,
    selectable: false,
    wrapMode: "none",
    flexShrink: 0,
    textAlign: "right",
  })
  box.add(right)
  return { box, left, right }
}

// ── 弹层通用卡片 ─────────────────────────────────────────────

export type CardNodes = {
  /** 整层容器 (显示/隐藏都操作它) */
  scrim: BoxRenderable
  card: BoxRenderable
  body: BoxRenderable
}

/**
 * 居中弹层: 全屏半透明遮罩 + 圆角卡片。
 * 遮罩用 crust + opacity, 保留背景可见性 (比纯色全屏更轻)。
 */
export function buildOverlay(
  r: CliRenderer,
  th: Theme,
  opts: {
    title: string
    color: string
    width: number | "100%" | `${number}%`
    height?: number | "100%"
    zIndex?: number
    borderStyle?: "rounded" | "double"
    paddingBottom?: number
  },
): CardNodes {
  // 遮罩与卡片是兄弟节点: 遮罩的半透明不能作用到卡片内容上
  const layer = new BoxRenderable(r, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    visible: false,
    zIndex: opts.zIndex ?? 300,
  })
  const scrim = new BoxRenderable(r, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    // 纯色遮罩: 半透明会让底层文字以混合色透出, 观感脏且难读
    backgroundColor: th.crust,
  })
  layer.add(scrim)
  const card = new BoxRenderable(r, {
    width: opts.width,
    height: opts.height,
    flexDirection: "column",
    backgroundColor: th.crust,
    borderStyle: opts.borderStyle ?? "rounded",
    borderColor: opts.color,
    title: ` ${opts.title} `,
    titleColor: opts.color,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: opts.paddingBottom ?? 1,
    zIndex: (opts.zIndex ?? 300) + 1,
    visible: false,
  })
  // 默认按内容撑开 (flexGrow 0); 全屏类弹层由调用方改为 1
  const body = new BoxRenderable(r, { flexDirection: "column", flexShrink: 0 })
  card.add(body)
  layer.add(card)
  return { scrim: layer, card, body }
}

export type { StyledText }