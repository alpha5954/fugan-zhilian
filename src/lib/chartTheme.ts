// ============================================================================
// 图表视觉语言
// ============================================================================
// 四张图表（实时信号、柱状、饼图、相位环路）在这里统一外观。
//
// 【为什么单独一个文件】
// 之前每张图各写各的 option，结果同样是坐标轴，四张图的字号、颜色、
// 网格线样式都不完全一样 —— 单看每张都没问题，摆在一起就"散"。
// 而"散"正是廉价感的来源：高级感很大程度上就是**处处一致**。
//
// 【设计取向：精密仪器，不是霓虹灯】
// 这一层的目标不是"好看"，是**让数据自己说话**：
//
//   * 坐标系往后退（更淡、更细、更少），数据往前进
//   * 数字用等宽字形，纵向严格对齐
//   * 不留装饰性的东西 —— 没有渐变背景、没有发光、没有多余网格
//
// 【取值都要用 token()】
// ECharts 画在 canvas 上，不解析 CSS 变量。详见 lib/theme.ts。
// ⚠️ 同样不能在模块顶层调用 token()，按需引入的 CSS 是之后才注入的。
// ============================================================================

import { token } from './theme.ts'

// ---------------------------------------------------------------------------
// 尺寸常量
// ---------------------------------------------------------------------------

/**
 * 坐标轴字号。
 *
 * 比正文（13px）小一档 —— 坐标是**参照物**，不是内容。
 * 做得和正文一样大，视觉上就和数据抢注意力了。
 */
const AXIS_FONT_SIZE = 10

/**
 * 一条轴上最多显示几个标签。
 *
 * ECharts 自己的 `interval: 'auto'` 会按可用宽度算，但算得偏保守 ——
 * 实测一屏能塞下二十几个刻度，密集到读不出来。这里直接限个数。
 */
const MAX_AXIS_LABELS = 8

// ---------------------------------------------------------------------------
// 坐标轴
// ---------------------------------------------------------------------------

/**
 * 轴标签样式。
 *
 * 用 `--ink-400`（比弱化文字再深一档）：太淡了读不清，太深了抢戏。
 * 走等宽数字，刻度值纵向能对齐。
 */
export function axisLabelStyle(extra: Record<string, unknown> = {}) {
  return {
    color: token('--ink-400'),
    fontSize: AXIS_FONT_SIZE,
    fontFamily: token('--font-num'),
    ...extra,
  }
}

/**
 * 类目轴的抽稀间隔。
 *
 * ECharts 的 `interval` 语义是"每 N 个显示一个"，所以 N-1。
 * 返回 0 表示全部显示（点少的时候没必要抽）。
 */
export function categoryInterval(count: number): number {
  if (count <= MAX_AXIS_LABELS) return 0
  return Math.ceil(count / MAX_AXIS_LABELS) - 1
}

/**
 * 数值轴的网格线。
 *
 * 用**虚线**而不是实线：实线铺满之后会织成一张网，把数据压下去；
 * 虚线在同样的浓度下"存在感"低得多，而且更像工程图纸而不是网页。
 */
export function splitLineStyle() {
  return {
    lineStyle: {
      color: token('--line-soft'),
      type: 'dashed' as const,
      width: 1,
    },
  }
}

/** 数值轴的轴线。不画 —— 网格线已经表达了刻度，再加一条竖线是重复 */
export function valueAxisLineStyle() {
  return { show: false }
}

/** 类目轴的轴线。保留一条淡的，作为数据的基线 */
export function categoryAxisLineStyle() {
  return {
    lineStyle: { color: token('--line'), width: 1 },
  }
}

// ---------------------------------------------------------------------------
// 提示框
// ---------------------------------------------------------------------------

/**
 * 提示框样式。
 *
 * ECharts 默认是圆角白框 + 深色粗体，一眼就是"没调过的图表"。
 * 这里改成和项目其他浮层一致：细描边、圆角小、阴影浅、数字等宽。
 */
export function tooltipStyle() {
  return {
    backgroundColor: token('--surface'),
    borderColor: token('--line'),
    borderWidth: 1,
    padding: [8, 12] as [number, number],
    textStyle: {
      color: token('--ink-700'),
      fontSize: 12,
      fontFamily: token('--font-num'),
    },
    // 提示框是 DOM 元素（不是 canvas），所以这里能直接用 CSS 变量
    extraCssText:
      `border-radius: ${token('--r-sm')};` +
      `box-shadow: ${token('--shadow-md')};`,
  }
}

/**
 * 十字准线。
 *
 * 虚线细线 + 一个小圆点。默认的实线太"硬"，而且和数据线容易混淆。
 */
export function axisPointerStyle() {
  return {
    type: 'line' as const,
    animation: false,
    lineStyle: {
      color: token('--line-strong'),
      width: 1,
      type: 'dashed' as const,
    },
  }
}

// ---------------------------------------------------------------------------
// 网格
// ---------------------------------------------------------------------------

/**
 * 统一的绘图区边距。
 *
 * 四张图用同一组数字，横向并排时上下边线才能对齐。
 *
 * ⚠️ `top` 要同时容纳**两样**东西，取能盖住两者的那个值：
 *
 *   1. **标线标签**（"预警 50 °C"那种）—— 不预留就被裁掉
 *   2. **坐标轴名称**（`ΔR/R₀ (%)` 那种）—— ECharts 把它画在轴的顶端
 *      **上方**，而且 `containLabel` **不管轴名**（它只管刻度数字），
 *      不留就同样被裁
 *
 * 原先只考虑了第 1 条：有标线给 26，否则给 12。于是"应变-温度解耦"
 * 那张图的轴名被裁掉一半 —— 它是四张图里**唯一有轴名**的，而它没有标线，
 * 拿到的正是 12px。实测：把 top 调到 30，两个轴名（左 `ΔR/R₀ (%)`、
 * 右 `温度分量 (%)`）就都出来了。
 *
 * 既然横向并排的四张图必须共用同一个 top，就只能取能满足所有图的那一个值。
 */
export function gridStyle(opts: { axes?: number } = {}) {
  const { axes = 1 } = opts
  return {
    left: 8,
    right: axes > 1 ? 8 : 12,
    top: 30,
    bottom: 4,
    containLabel: true,
  }
}

// ---------------------------------------------------------------------------
// 数值格式
// ---------------------------------------------------------------------------

/**
 * 数值的默认展示精度。
 *
 * 与 --font-num 的等宽字形配合，位数固定之后纵向才对得齐。
 * 超过 3 位小数在传感器读数里没有意义（噪声量级）。
 */
export function formatValue(v: unknown, digits: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

// ---------------------------------------------------------------------------
// 面积渐变
// ---------------------------------------------------------------------------

/**
 * 折线下方的渐变填充。
 *
 * 从 22% 透明度渐隐到 0。比常见的 50%→0 更克制 —— 面积色一旦重，
 * 折线本身就看不见了，而这条线才是要读的东西。
 */
export function areaGradient(color: string) {
  return {
    color: {
      type: 'linear' as const,
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: `${color}38` },
        { offset: 1, color: `${color}00` },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// 分类色
// ---------------------------------------------------------------------------

/** 分类色的个数。与 tokens.css 里的 --chart-N 一一对应 */
const SERIES_COLOR_COUNT = 4

/**
 * 取第 index 个分类色的**字面值**。
 *
 * 为什么要绕这一道：色值的单一来源必须是 tokens.css，但 ECharts 在
 * canvas 上画图、不解析 CSS 变量，而数据层（lib/analysis.ts）是纯函数、
 * 运行时没有 DOM 也读不了令牌。
 *
 * 所以数据层只回一个**索引**，颜色在这里解析 —— 数据层保持纯净，
 * 颜色仍然只有 tokens.css 一个来源。
 */
export function seriesColor(index: number): string {
  const n = (index % SERIES_COLOR_COUNT) + 1
  return token(`--chart-${n}` as `--${string}`)
}
