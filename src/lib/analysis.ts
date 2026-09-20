// ============================================================================
// 数据分析：历史训练记录的聚合
// ============================================================================
// 全是纯函数，输入 RehabSession[]，输出图表直接能用的结构。
// 不依赖 Vue 也不依赖 Supabase —— 这样能被 node 直接跑（见
// scripts/check-analysis.ts），聚合逻辑里的边界情况（空数据、单点、
// 缺日期、跨时区）用眼睛看代码是看不出来的。
// ============================================================================

import { REHAB_EXERCISES, targetFor } from './assessment.ts'
import { formatDate } from './format.ts'
import type { RehabSession } from '@/types'

/** 温度预警阈值，与实时监测页保持一致 */
export const TEMP_ALERT_THRESHOLD = 45

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
  color: string
}

export interface TrendResult {
  dates: string[]
  series: TrendSeries[]
}

const SERIES_COLOR = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c'] as const

/**
 * 按动作分别画出活动度趋势。
 *
 * 刻意**不把不同动作平均成一条线** —— 直腿抬高的活动度只有 10° 上下，
 * 屈膝滑动接近 100°，平均出来的数字既不代表任何一个动作，也看不出
 * 任何趋势。每个动作单独一条线才能反映各自是否在进步。
 *
 * 某天没做某个动作时该点为 null，折线断开。
 */
export function buildTrendByExercise(sessions: RehabSession[]): TrendResult {
  const byDate = groupByLocalDate(sessions)
  const dates = sortedDates(byDate)

  // 只画实际出现过的动作，避免图例里堆一串空线
  const present = REHAB_EXERCISES.filter((e) =>
    sessions.some((s) => s.exercise === e),
  )

  const series: TrendSeries[] = present.map((exercise, i) => ({
    name: exercise,
    color: SERIES_COLOR[i % SERIES_COLOR.length],
    data: dates.map((date) => {
      const daySessions = (byDate.get(date) ?? []).filter(
        (s) => s.exercise === exercise,
      )
      const roms = pluck(daySessions, 'rom_deg')
      return roms.length ? Number(mean(roms).toFixed(2)) : null
    }),
  }))

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

  const avgRom = names.map((e) => {
    const roms = pluck(
      sessions.filter((s) => s.exercise === e),
      'rom_deg',
    )
    return Number(mean(roms).toFixed(2))
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
  color: string
}

export function buildExerciseDistribution(sessions: RehabSession[]): DistributionItem[] {
  return REHAB_EXERCISES.map((exercise, i) => ({
    name: exercise,
    value: sessions.filter((s) => s.exercise === exercise).length,
    color: SERIES_COLOR[i % SERIES_COLOR.length] as string,
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
    if (typeof s.rom_deg !== 'number') return false
    const target = targetFor(s.exercise as (typeof REHAB_EXERCISES)[number])
    // 静力动作的活动度本就很小，不能用活动度判定达标；
    // 这里没有保存保持角度，所以静力动作一律不计入达标统计
    if (s.exercise === '靠墙静蹲') return false
    return s.rom_deg >= target
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
