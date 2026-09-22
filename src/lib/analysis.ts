// ============================================================================
// 数据分析：历史训练记录的聚合
// ============================================================================
// 全是纯函数，输入 RehabSession[]，输出图表直接能用的结构。
// 不依赖 Vue 也不依赖 Supabase —— 这样能被 node 直接跑（见
// scripts/check-analysis.ts），聚合逻辑里的边界情况（空数据、单点、
// 缺日期、跨时区）用眼睛看代码是看不出来的。
// ============================================================================

import { REHAB_EXERCISES, metricFor, targetFor } from './assessment.ts'
import { formatDate } from './format.ts'
import type { RehabSession } from '@/types'

// 温度预警阈值只在 simulator.ts 定义一处，这里再导出给调用方用。
// 原先两个文件各写一份 45 —— 改了一处忘了另一处，监测页和分析页就会
// 对"什么算超标"给出不同答案，而且不会有任何报错。
//
// 注意必须先 import 再 export：`export { X } from '...'` 只做转发，
// 不会把 X 引入本模块作用域，文件内部用不了。
import { TEMP_ALERT_THRESHOLD } from './simulator.ts'
export { TEMP_ALERT_THRESHOLD }

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/**
 * 按本地日期分组。
 *
 * ⚠️ 必须用**本地**日期而不是 ISO 字符串前 10 位 —— 后者是 UTC 日期，
 *    东八区用户在凌晨到早上 8 点之间的记录会被归到前一天。
 */
function groupByLocalDate(sessions: RehabSession[]): Map<string, RehabSession[]> {
  const map = new Map<string, RehabSession[]>()
  for (const s of sessions) {
    // formatDate 内部用的是本地时区，正好是我们要的
    const key = formatDate(s.started_at)
    const list = map.get(key)
    if (list) list.push(s)
    else map.set(key, [s])
  }
  return map
}

/** 升序排列的日期键 */
function sortedDates(map: Map<string, unknown>): string[] {
  return [...map.keys()].sort()
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

/**
 * RehabSession 里类型为 number | null 的字段名。
 *
 * 不能写成 `keyof RehabSession` —— 那样 `s[field]` 的类型是所有字段的
 * 联合（string | number | Waveform | null），收窄不到 number。
 * 用映射类型先把可选的字段名筛出来。
 */
type NumericField = {
  [K in keyof RehabSession]: RehabSession[K] extends number | null ? K : never
}[keyof RehabSession]

/** 取某数值字段的非空值 */
function pluck(sessions: RehabSession[], field: NumericField): number[] {
  return sessions
    .map((s) => s[field])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

// ---------------------------------------------------------------------------
// 1. 趋势图：各动作的关节活动度随时间变化
// ---------------------------------------------------------------------------

export interface TrendSeries {
  name: string
  /** 与 dates 等长，缺数据处为 null */
  data: (number | null)[]
  /**
   * 分类色的**索引**，不是色值。
   *
   * 这个模块是纯函数、运行时没有 DOM，读不了 CSS 令牌。而色值的唯一
   * 来源必须是 tokens.css —— 所以这里只回索引，由视图层用
   * chartTheme 的 seriesColor() 解析成字面值。
   *
   * （改造前这里直接写着 '#409eff' 等，那是 Element Plus 的默认调色板，
   *   和整套品牌色不是一家的。）
   */
  colorIndex: number
}

export interface TrendResult {
  dates: string[]
  series: TrendSeries[]
}

/**
 * 按动作分别画出**进展**趋势。
 *
 * 刻意**不把不同动作平均成一条线** —— 直腿抬高的活动度只有 10° 上下，
 * 屈膝滑动接近 100°，平均出来的数字既不代表任何一个动作，也看不出
 * 任何趋势。每个动作单独一条线才能反映各自是否在进步。
 *
 * ⚠️ **每条线画的是该动作自己"判定达标用的那个量"**，走 `metricFor`：
 *    动态动作画活动范围，静力动作（靠墙静蹲）画**保持角度**。
 *
 *    原先一律画 rom_deg，于是靠墙静蹲那条线一直贴在 10° 附近 ——
 *    而它达标看的是保持角度（55° 上下）。后果是**页面自己打自己**：
 *    结论区写「靠墙静蹲 61.7°/目标 55°，已明显超出目标」，
 *    旁边的图上那条紫线却在 12° 躺着。
 *
 *    这是同一个坑的**第五处**（前四处：summarize、insight 的 completionOf、
 *    findings、compareExercises），每一处都记过一笔。
 *
 *    标题也不再叫「关节活动度趋势」—— 有一条线画的不是活动度。
 *
 * 某天没做某个动作时该点为 null，由调用方决定要不要跨断点连线。
 */
export function buildTrendByExercise(sessions: RehabSession[]): TrendResult {
  const byDate = groupByLocalDate(sessions)
  const dates = sortedDates(byDate)

  // 只画实际出现过的动作，避免图例里堆一串空线
  const present = REHAB_EXERCISES.filter((e) =>
    sessions.some((s) => s.exercise === e),
  )

  const series: TrendSeries[] = present.map((exercise, i) => {
    // 静力动作画保持角度，动态动作画活动范围 —— 见函数头的说明
    const field = metricFor(exercise) === 'hold' ? 'hold_deg' : 'rom_deg'
    return {
      name: exercise,
      colorIndex: i,
      data: dates.map((date) => {
        const daySessions = (byDate.get(date) ?? []).filter(
          (s) => s.exercise === exercise,
        )
        const vs = pluck(daySessions, field)
        return vs.length ? Number(mean(vs).toFixed(2)) : null
      }),
    }
  })

  return { dates, series }
}

// ---------------------------------------------------------------------------
// 2. 对比图：各动作的平均活动度与目标值
// ---------------------------------------------------------------------------

export interface CompareResult {
  names: string[]
  /** 各动作的平均活动度 */
  avgRom: number[]
  /** 各动作的目标值，同轴对比才看得出差距 */
  targets: number[]
  /** 各动作的训练次数 */
  counts: number[]
}

export function compareExercises(sessions: RehabSession[]): CompareResult {
  const names = REHAB_EXERCISES.filter((e) =>
    sessions.some((s) => s.exercise === e),
  )

  // ⚠️ 判定指标**必须按动作类型取**，不能一律用 rom_deg。
  //
  // 这里的柱子要跟 targets（也就是 targetFor）比，而 targetFor 对靠墙静蹲
  // 返回的是**保持角度**目标 55°。拿活动范围（天然只有几度）去比，
  // 图上会读作"完成 17%"—— 而那个患者其实做得完全正确。
  //
  // 这是同一个坑的第四处（另三处是 summarize、insight 的 completionOf、
  // findings）。前三处都有断言钉着，这一处没有，所以它一直活到了
  // 2026-09-22 —— 数据分析页的结论和这张图放在一起会自相矛盾，
  // 才发现。check-analysis.ts 现在补上了断言。
  const avgRom = names.map((e) => {
    const field = metricFor(e) === 'hold' ? 'hold_deg' : 'rom_deg'
    const vs = pluck(
      sessions.filter((s) => s.exercise === e),
      field,
    )
    return Number(mean(vs).toFixed(2))
  })

  return {
    names: [...names],
    avgRom,
    targets: names.map((e) => targetFor(e)),
    counts: names.map((e) => sessions.filter((s) => s.exercise === e).length),
  }
}

// ---------------------------------------------------------------------------
// 3. 温度历史
// ---------------------------------------------------------------------------

export interface TemperatureResult {
  labels: string[]
  values: (number | null)[]
  /** 越过阈值的记录数 */
  overCount: number
}

/**
 * 每次训练的皮温峰值随时间变化。
 *
 * 用「每次一条」而不是「每天一条」—— 热敷监测场景下一天可能做好几次，
 * 平均值会把单次超标的事件抹平，而那恰恰是最该被看到的。
 */
export function buildTemperatureHistory(sessions: RehabSession[]): TemperatureResult {
  const sorted = [...sessions].sort((a, b) =>
    a.started_at.localeCompare(b.started_at),
  )

  const values = sorted.map((s) => s.temp_c)
  const overCount = values.filter(
    (v): v is number => typeof v === 'number' && v >= TEMP_ALERT_THRESHOLD,
  ).length

  return {
    labels: sorted.map((s) => {
      const date = formatDate(s.started_at)
      const time = new Date(s.started_at)
      const hh = String(time.getHours()).padStart(2, '0')
      const mm = String(time.getMinutes()).padStart(2, '0')
      return `${date.slice(5)} ${hh}:${mm}`
    }),
    values,
    overCount,
  }
}

// ---------------------------------------------------------------------------
// 4. 饼图：动作分布
// ---------------------------------------------------------------------------

export interface DistributionItem {
  name: string
  value: number
  /** 同 TrendSeries.colorIndex，由视图层解析成色值 */
  colorIndex: number
}

export function buildExerciseDistribution(sessions: RehabSession[]): DistributionItem[] {
  return REHAB_EXERCISES.map((exercise, i) => ({
    name: exercise,
    value: sessions.filter((s) => s.exercise === exercise).length,
    colorIndex: i,
  })).filter((d) => d.value > 0)
}

// ---------------------------------------------------------------------------
// 概要指标
// ---------------------------------------------------------------------------

export interface AnalysisSummary {
  totalSessions: number
  /** 覆盖的天数 */
  activeDays: number
  /** 平均每次训练的次数 */
  avgReps: number
  /** 活动度达标的次数（按各动作自己的目标判定） */
  onTargetCount: number
  /** 温度越阈值的次数 */
  overTempCount: number
  /** 平均识别置信度 */
  avgConfidence: number
}

export function summarize(sessions: RehabSession[]): AnalysisSummary {
  const byDate = groupByLocalDate(sessions)

  // 达标判定必须按动作取目标值 —— 用统一目标会得出完全错误的达标率
  const onTargetCount = sessions.filter((s) => {
    const exercise = s.exercise as (typeof REHAB_EXERCISES)[number]
    if (!REHAB_EXERCISES.includes(exercise)) return false

    const target = targetFor(exercise)

    // 判定指标也按动作类型取：动态动作看活动范围，静力动作看保持角度。
    //
    // 这两者不能混 —— 靠墙静蹲的活动范围天然只有 5~10°（只有姿势微调），
    // 拿它去比 55° 的目标会把做得完全正确的患者判成未达标。
    //
    // 在迁移 9 加上 hold_deg 之前，这里只能整个跳过静力动作，
    // 代价是那类动作在达标统计里完全不存在。现在接上了。
    // 老记录没有 hold_deg，取不到值时跳过 —— 不拿 rom_deg 去硬凑。
    const value = metricFor(exercise) === 'hold' ? s.hold_deg : s.rom_deg
    if (typeof value !== 'number') return false

    return value >= target
  }).length

  const confidences = pluck(sessions, 'confidence')

  return {
    totalSessions: sessions.length,
    activeDays: byDate.size,
    avgReps: Number(mean(pluck(sessions, 'rep_count')).toFixed(1)),
    onTargetCount,
    overTempCount: pluck(sessions, 'temp_c').filter(
      (t) => t >= TEMP_ALERT_THRESHOLD,
    ).length,
    avgConfidence: Number(mean(confidences).toFixed(3)),
  }
}
