// ============================================================================
// 结论层：把技术指标翻译成家属看得懂的三句话
// ============================================================================
//
// 【为什么需要这一层】
// 在这之前数据流是断的：
//
//     传感器 → 原始信号 → 技术指标(RMS/GF/TCR/ROM) ──✂── 直接甩给用户
//
// 家属看到 `GF=2.4`、`TCR=-0.019/°C`、`采样率 10 Hz`，这些对他没有任何
// 意义。他要的是三句话：恢复得怎么样 / 有没有危险 / 我该做什么。
//
// 这一层补的就是中间那段断裂。
//
// 【设计原则：可解释，不玄学】
// 所有输出都能当场展开讲清楚依据 —— 答辩时评委问"为什么是 82 分"，
// 要能一项一项翻给他看，而不是答"模型算的"。
//
// 具体做法：总分由四个**可独立解释**的分量加权，每个分量都能说清
// "它是什么、怎么算的、这次为什么是这个值"。
//
// 【全是纯函数】
// 不依赖 Vue、不依赖 Supabase、不依赖当前时间（now 由调用方传入），
// 所以能被 node 直接跑（见 scripts/check-insight.ts）。
// 评分这种东西的边界情况（没有历史、只有一次、全都不达标）用眼睛是
// 看不出来的，必须有断言钉住。
// ============================================================================

import { REHAB_EXERCISES, metricFor, targetFor } from './assessment.ts'
import type { ExerciseName } from './assessment.ts'
import type { Alert, RehabSession } from '@/types'

// ---------------------------------------------------------------------------
// 时间窗口
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** 本周：最近 7 天。评分看的是这一段 */
const WINDOW_DAYS = 7

/**
 * 基线：本周之前的那 14 天。
 *
 * 取 14 天是为了让"进步"有个稍微稳定的参照。只取 7 天的话，
 * 上周恰好练得少就会让本周显得进步神速，反过来也一样。
 */
const BASELINE_DAYS = 14

/**
 * 认为基线"够用"的最少会话数。
 *
 * 少于这个数就不给进步度打分，而是取中性值 —— 用两三次记录算出来的
 * "进步 300%" 只会误导人，不如老实说"数据还不够"。
 */
const MIN_BASELINE_SESSIONS = 3

/**
 * 康复方案建议的每周训练天数。
 *
 * ⚠️ 这个值按常见膝关节术后康复方案拟定，**真实产品里应该按患者个体
 *    设定**（术后不同阶段的推荐频率不一样）。这里没有患者-方案表，
 *    先用一个统一值，团队应按实际方案核定。
 */
const RECOMMENDED_DAYS_PER_WEEK = 5

/** 把时间归到当天 0 点（本地时区） */
function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function localDateKey(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 风险等级。
 *
 * 界面上一律用 🟢🟡🔴 表达，不出现纯数字 —— 家属看不懂"风险指数 0.7"，
 * 但看得懂一个黄灯。
 */
export type RiskBand = 'green' | 'yellow' | 'red'

export const BAND_LABEL: Record<RiskBand, string> = {
  green: '正常',
  yellow: '需要注意',
  red: '需要处理',
}

/** 评分分量。每一项都能单独展开解释 */
export interface ScorePart {
  key: 'target' | 'progress' | 'stability' | 'adherence'
  /** 家属语言的分量名 */
  label: string
  /** 0~1 的得分 */
  value: number
  /** 权重，四项之和为 1 */
  weight: number
  /** 一句话依据。展开"为什么是这个分"时显示 */
  detail: string
}

/** 首页那三张家属语言卡片 */
export interface SummaryCard {
  key: 'today' | 'risk' | 'advice'
  /** 一个 emoji，家属扫一眼就知道是哪一类 */
  icon: string
  title: string
  /** 一句话结论，尽量短 */
  headline: string
  /** 补充说明，可以是空的 */
  detail: string
  band: RiskBand
}

export interface Insight {
  /** 0~100 的整数。没有数据时为 null */
  score: number | null
  /**
   * 风险等级。由「预警事件」与「评分」合成，用于卡片与提示条。
   *
   * ⚠️ 不要拿它给**评分数字**上色，两者是不同的轴：
   *    分数说的是"恢复得怎么样"，风险说的是"有没有危险"。
   *    一个患者可能恢复得很好（92 分）但有一次温度超标需要留意。
   *    用风险色去染分数，会出现"92 分显示成橙色"这种自相矛盾的画面 ——
   *    实测截图时就是这么发现的。评分数字请用 scoreBand。
   */
  band: RiskBand
  /**
   * 只看评分本身的等级，用于给分数上色。
   *
   * 阈值与 bandFor 里的评分分支保持一致（80 / 60），改动时要一起改。
   */
  scoreBand: RiskBand
  /** 评分下面那句解释 */
  headline: string
  parts: ScorePart[]
  cards: SummaryCard[]
  stats: {
    /** 本周会话数 */
    weekSessions: number
    /** 本周训练天数 */
    weekDays: number
    /** 基线够不够 —— 不够时进度分量取中性值，界面上要说明 */
    hasBaseline: boolean
    /** 有没有任何数据 */
    hasAnyData: boolean
  }
}

// ---------------------------------------------------------------------------
// 一、达标度
// ---------------------------------------------------------------------------

/**
 * 一次训练相对它的目标完成了多少（0~1）。
 *
 * ⚠️ **静力动作（靠墙静蹲）不计入**。
 *
 * 它的目标 55° 指的是「保持角度」，而 rehab_sessions 表里只存了 rom_deg
 * （活动范围）。靠墙静蹲的活动范围天然只有 5~10°，拿它去比 55 会得出
 * 接近 0 的完成度，把总分拖垮 —— 而患者其实做得完全正确。
 *
 * 这与 analysis.ts 里 summarize() 的处理保持一致：那里同样跳过静力动作。
 * 根治的办法是给表加一列 hold_deg，前端这两处再改成读它。
 */
function completionOf(session: RehabSession): number | null {
  if (session.exercise === '靠墙静蹲') return null
  if (typeof session.rom_deg !== 'number') return null

  const exercise = session.exercise as ExerciseName
  if (!REHAB_EXERCISES.includes(exercise)) return null
  if (metricFor(exercise) !== 'rom') return null

  const target = targetFor(exercise)
  if (target <= 0) return null

  return clamp01(session.rom_deg / target)
}

// ---------------------------------------------------------------------------
// 二、各分量的得分
// ---------------------------------------------------------------------------

interface PartInput {
  week: RehabSession[]
  baseline: RehabSession[]
  weekDays: number
}

function targetPart(input: PartInput): ScorePart {
  const ratios = input.week
    .map(completionOf)
    .filter((r): r is number => r !== null)

  if (!ratios.length) {
    return {
      key: 'target',
      label: '动作达标',
      value: 0,
      weight: 0.4,
      detail: '本周没有可判定的动态动作记录（静力动作不参与达标判定）',
    }
  }

  const value = mean(ratios)
  const pct = Math.round(value * 100)

  // 找出做得最差的那个动作，具体说是谁比"本周完成 73%"有用得多
  const worst = weakestExercise(input.week)

  return {
    key: 'target',
    label: '动作达标',
    value,
    weight: 0.4,
    detail: worst
      ? `本周达到康复目标的 ${pct}%，其中「${worst.exercise}」差距最大（${worst.actual}° / 目标 ${worst.target}°）`
      : `本周达到康复目标的 ${pct}%`,
  }
}

/** 本周完成度最低的动作 */
function weakestExercise(
  week: RehabSession[],
): { exercise: string; actual: number; target: number } | null {
  let worst: { exercise: string; actual: number; target: number; ratio: number } | null =
    null

  for (const s of week) {
    const ratio = completionOf(s)
    if (ratio === null) continue
    if (!worst || ratio < worst.ratio) {
      worst = {
        exercise: s.exercise,
        actual: Math.round(s.rom_deg ?? 0),
        target: targetFor(s.exercise as ExerciseName),
        ratio,
      }
    }
  }

  return worst
    ? { exercise: worst.exercise, actual: worst.actual, target: worst.target }
    : null
}

function progressPart(input: PartInput): ScorePart {
  const weekRatios = input.week
    .map(completionOf)
    .filter((r): r is number => r !== null)
  const baseRatios = input.baseline
    .map(completionOf)
    .filter((r): r is number => r !== null)

  const hasBaseline = input.baseline.length >= MIN_BASELINE_SESSIONS

  if (!hasBaseline || !weekRatios.length || !baseRatios.length) {
    return {
      key: 'progress',
      label: '进步情况',
      value: 0.5,
      weight: 0.3,
      detail: hasBaseline
        ? '本周还没有可比较的记录'
        : `历史记录还不够（需要 ${MIN_BASELINE_SESSIONS} 次以上），暂时按"持平"计分`,
    }
  }

  const now = mean(weekRatios)
  const before = mean(baseRatios)
  // before 为 0 时无从算变化率（会除零）。这种情况只能是基线全是 0 分，
  // 那本周任何进展都是改善，直接给满
  const change = before > 0 ? (now - before) / before : now > 0 ? 1 : 0

  // 变化 ±20% 分别对应满分和零分，0% 对应中间值。
  // 之所以不用"正比"映射，是因为康复本来就有平台期，
  // 原地踏步不该被判成不及格
  const value = clamp01(0.5 + change * 2.5)

  const pct = Math.round(change * 100)
  const dir = pct > 0 ? '提升' : pct < 0 ? '下降' : '持平'

  return {
    key: 'progress',
    label: '进步情况',
    value,
    weight: 0.3,
    detail:
      pct === 0
        ? '和之前两周相比基本持平'
        : `比之前两周${dir} ${Math.abs(pct)}%`,
  }
}

function stabilityPart(input: PartInput): ScorePart {
  const ratios = input.week
    .map(completionOf)
    .filter((r): r is number => r !== null)

  if (ratios.length < 2) {
    return {
      key: 'stability',
      label: '动作稳定',
      value: 0.5,
      weight: 0.15,
      detail: '本周记录太少，还看不出动作是否稳定',
    }
  }

  const m = mean(ratios)
  // 变异系数：标准差 ÷ 均值。用它而不是光看标准差，是因为
  // 不同动作的完成度尺度不同，只有相对波动才可比
  const cv = m > 0 ? stdDev(ratios) / m : 0

  // CV 到 0.3 就算很不稳定了。这个阈值是经验值，康复科可调
  const value = clamp01(1 - cv / 0.3)

  return {
    key: 'stability',
    label: '动作稳定',
    value,
    weight: 0.15,
    detail:
      cv < 0.1
        ? '每次动作幅度都很接近，发挥稳定'
        : cv < 0.2
          ? '动作幅度偶有起伏，总体可控'
          : '动作幅度忽大忽小，建议放慢速度、组间多休息',
  }
}

function adherencePart(input: PartInput): ScorePart {
  const value = clamp01(input.weekDays / RECOMMENDED_DAYS_PER_WEEK)

  return {
    key: 'adherence',
    label: '训练坚持',
    value,
    weight: 0.15,
    detail: `本周训练了 ${input.weekDays} 天，建议每周 ${RECOMMENDED_DAYS_PER_WEEK} 天`,
  }
}

// ---------------------------------------------------------------------------
// 三、风险等级
// ---------------------------------------------------------------------------

/**
 * 红黄绿。
 *
 * 两个来源合成：**已发生的预警事件** 和 **评分本身**。
 *
 * 只看预警的话，一个动作全面退步但没触发任何阈值的患者会显示绿灯 ——
 * 那是最危险的情况，因为没人会去看。只看评分的话，一次温度超标会被
 * 平均掉。两者都要。
 */
function bandFor(score: number, weekAlerts: Alert[]): RiskBand {
  const hasCritical = weekAlerts.some((a) => a.severity === 'critical')
  const hasWarning = weekAlerts.some((a) => a.severity === 'warning')

  if (hasCritical || score < 60) return 'red'
  if (hasWarning || score < 80) return 'yellow'
  return 'green'
}

/**
 * 只看分数的等级。
 *
 * 阈值和 bandFor 的分数分支是同一组，改一处必须改另一处 ——
 * 两处漂了的话，会出现"数字是绿的、角标说需要处理"这种矛盾。
 */
function scoreBandFor(score: number): RiskBand {
  if (score < 60) return 'red'
  if (score < 80) return 'yellow'
  return 'green'
}

// ---------------------------------------------------------------------------
// 四、三张家属语言卡片
// ---------------------------------------------------------------------------

/** 动作标准度：识别出来的动作和患者实际做的是不是同一个 */
function standardRate(sessions: RehabSession[]): number | null {
  const withRecognized = sessions.filter((s) => s.recognized !== null)
  if (!withRecognized.length) return null
  const matched = withRecognized.filter(
    (s) => s.recognized === s.exercise,
  ).length
  return matched / withRecognized.length
}

/**
 * 「今天的康复情况」。
 *
 * 标准度取的是**本周**而不是当天：当天往往只有一次训练，识别结果非对即错，
 * 算出来只能是 0% 或 100%。一个恒定的 100% 摆在 "动作标准度" 四个字下面，
 * 不但没有信息量，还显得是在糊弄人。
 */
function todayCard(
  today: RehabSession[],
  week: RehabSession[],
): SummaryCard {
  if (!today.length) {
    return {
      key: 'today',
      icon: '📋',
      title: '今天的康复情况',
      headline: '今天还没有训练记录',
      detail: '建议按康复方案完成今天的训练',
      band: 'yellow',
    }
  }

  const reps = today.reduce((sum, s) => sum + (s.rep_count ?? 0), 0)
  const standard = standardRate(week)

  return {
    key: 'today',
    icon: '📋',
    title: '今天的康复情况',
    headline: `今天完成了 ${today.length} 次训练，共 ${reps} 组`,
    detail:
      standard === null
        ? '动作识别结果正常'
        : `本周动作标准度 ${Math.round(standard * 100)}%`,
    band: 'green',
  }
}

function riskCard(weekAlerts: Alert[]): SummaryCard {
  const pending = weekAlerts.filter((a) => a.acknowledged_at === null)

  if (!weekAlerts.length) {
    return {
      key: 'risk',
      icon: '🛡️',
      title: '有没有需要注意的',
      headline: '本周没有异常',
      detail: '温度和信号都在正常范围内',
      band: 'green',
    }
  }

  // 挑最严重的一条来说，其余的数量带过 —— 家属要的是"最该关心什么"，
  // 而不是一份清单
  const worst = [...weekAlerts].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  )[0]!

  const extra = weekAlerts.length > 1 ? `，另有 ${weekAlerts.length - 1} 条` : ''
  // 处理状态**总要**说。原先只在有未处理项时才提，导致"已处理"的预警
  // 看起来和"没处理"一模一样 —— 家属不知道该不该再做什么
  const suffix = pending.length ? '（尚未处理）' : '（已处理）'

  return {
    key: 'risk',
    icon: '⚠️',
    title: '有没有需要注意的',
    headline: `${describeAlert(worst)}${extra}`,
    detail: `${alertAdvice(worst)}${suffix}`,
    band: worst.severity === 'critical' ? 'red' : 'yellow',
  }
}

function severityRank(s: Alert['severity']): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0
}

/** 把预警的 kind 翻译成家属语言 */
function describeAlert(a: Alert): string {
  switch (a.kind) {
    case 'temp_high':
      return a.value !== null
        ? `皮肤温度偏高（${a.value.toFixed(1)}°C）`
        : '皮肤温度偏高'
    case 'temp_low':
      return a.value !== null ? `皮肤温度偏低（${a.value.toFixed(1)}°C）` : '皮肤温度偏低'
    case 'device_offline':
      return '设备信号中断'
    case 'motion_abnormal':
      return '动作识别异常'
    case 'low_compliance':
      return '训练次数偏少'
  }
}

/** 这类预警该怎么做。家属最需要的就是这一句 */
function alertAdvice(a: Alert): string {
  switch (a.kind) {
    case 'temp_high':
      return '请检查热敷时间是否过长，让皮肤休息一下再继续'
    case 'temp_low':
      return '注意保暖，温度过低会影响传感器读数'
    case 'device_offline':
      return '检查电极片是否贴牢、设备是否有电'
    case 'motion_abnormal':
      return '动作可能不标准，建议放慢速度、对照视频再做一次'
    case 'low_compliance':
      return '训练频次低于康复方案建议，建议保持每天两组'
  }
}

/**
 * 从"最弱的那一项"生成建议。
 *
 * 规则驱动而不是大模型：每一条都能被治疗师审核，答辩时也能说清依据。
 * 将来若要用大模型润色文案，改的应该是措辞，不是"说什么" —— 决定
 * 说什么的必须是这张表。
 */
function adviceFor(
  parts: ScorePart[],
  weekAlerts: Alert[],
  score: number,
  stats: Insight['stats'],
): SummaryCard {
  const base = {
    key: 'advice' as const,
    icon: '💡',
    title: '下一步建议',
  }

  if (!stats.hasAnyData) {
    return {
      ...base,
      headline: '还没有训练记录',
      detail: '完成第一次训练后，这里会给出针对性的康复建议',
      band: 'green',
    }
  }

  // 有未处理的严重预警时，建议围绕它展开 —— 这比谈分数重要得多
  const critical = weekAlerts.find(
    (a) => a.severity === 'critical' && a.acknowledged_at === null,
  )
  if (critical) {
    return {
      ...base,
      headline: '先处理上面那条预警',
      detail: alertAdvice(critical),
      band: 'red',
    }
  }

  const weakest = [...parts].sort((a, b) => a.value - b.value)[0]!

  if (weakest.key === 'adherence') {
    return {
      ...base,
      headline: `这周训练了 ${stats.weekDays} 天，建议补到 ${RECOMMENDED_DAYS_PER_WEEK} 天`,
      detail: '康复训练靠的是频次稳定，隔太久效果会打折',
      band: 'yellow',
    }
  }

  if (weakest.key === 'target') {
    return {
      ...base,
      headline: '继续保持，动作幅度还可以再大一点',
      detail: weakest.detail,
      band: 'yellow',
    }
  }

  if (weakest.key === 'stability') {
    return {
      ...base,
      headline: '把动作放慢一些，让每次幅度更接近',
      detail: '动作忽大忽小会影响康复效果，建议组间多休息一会儿',
      band: 'yellow',
    }
  }

  if (weakest.key === 'progress') {
    return {
      ...base,
      headline: score >= 70 ? '保持现在的节奏就好' : '最近进步放缓，别着急',
      detail: '康复有平台期是正常的，坚持训练就会继续改善',
      band: 'green',
    }
  }

  return {
    ...base,
    headline: '各项指标都不错，保持现在的节奏',
    detail: '按康复方案继续训练即可',
    band: 'green',
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把训练记录与预警合成为一页能看懂的结论。
 *
 * @param sessions 该患者的全部训练记录（顺序不限）
 * @param alerts   该患者的全部预警（顺序不限）
 * @param now      当前时间。传进来而不是内部取，是为了让自检脚本能
 *                 构造"确定的时间点"，否则断言会随运行时刻漂移
 */
export function buildInsight(
  sessions: RehabSession[],
  alerts: Alert[],
  now: Date = new Date(),
): Insight {
  const todayStart = startOfDay(now).getTime()
  const weekStart = todayStart - (WINDOW_DAYS - 1) * DAY_MS
  const baselineStart = weekStart - BASELINE_DAYS * DAY_MS

  /**
   * 上界取「今天的结束」而不是「此刻」。
   *
   * 两个原因：
   *   1. 设备时钟和浏览器时钟可能差几小时。拿"此刻"当上界的话，一条
   *      时间戳比当前时刻晚三小时的当天记录会被判成"未来"，
   *      于是今天的训练从家属眼前凭空消失 —— 而这完全不是异常情况。
   *   2. 真正荒谬的数据（比如时间戳在两天后）仍然会被挡住。
   */
  const tomorrowStart = todayStart + DAY_MS

  const ts = (s: { started_at: string }): number => new Date(s.started_at).getTime()

  const inToday = (t: number): boolean => t >= todayStart && t < tomorrowStart
  const inWeek = (t: number): boolean => t >= weekStart && t < tomorrowStart

  const week = sessions.filter((s) => inWeek(ts(s)))
  const baseline = sessions.filter(
    (s) => ts(s) >= baselineStart && ts(s) < weekStart,
  )
  const today = sessions.filter((s) => inToday(ts(s)))

  const weekAlerts = alerts.filter((a) => inWeek(new Date(a.occurred_at).getTime()))

  // 本周训练天数。用**本地**日期去重 —— 用 ISO 字符串前 10 位是 UTC 日期，
  // 东八区凌晨的记录会被算到前一天
  const weekDays = new Set(week.map((s) => localDateKey(s.started_at))).size

  const stats: Insight['stats'] = {
    weekSessions: week.length,
    weekDays,
    hasBaseline: baseline.length >= MIN_BASELINE_SESSIONS,
    hasAnyData: sessions.length > 0,
  }

  const parts = [
    targetPart({ week, baseline, weekDays }),
    progressPart({ week, baseline, weekDays }),
    stabilityPart({ week, baseline, weekDays }),
    adherencePart({ week, baseline, weekDays }),
  ]

  if (!sessions.length) {
    return {
      score: null,
      band: 'yellow',
      // 没有分数就谈不上等级。给绿而不是黄：这不是"需要注意"，
      // 只是"还没开始"，家属第一次打开不该看到一个警告色
      scoreBand: 'green',
      headline: '还没有训练数据，完成第一次训练后这里会显示恢复情况',
      parts,
      cards: [
        todayCard([], []),
        riskCard(weekAlerts),
        adviceFor(parts, weekAlerts, 0, stats),
      ],
      stats,
    }
  }

  const weighted = parts.reduce((sum, p) => sum + p.value * p.weight, 0)
  const score = Math.round(weighted * 100)
  const band = bandFor(score, weekAlerts)

  return {
    score,
    band,
    scoreBand: scoreBandFor(score),
    headline: headlineFor(score, parts, stats),
    parts,
    cards: [
      todayCard(today, week),
      riskCard(weekAlerts),
      adviceFor(parts, weekAlerts, score, stats),
    ],
    stats,
  }
}

/** 评分下面那句解释。要具体，不要"表现良好"这种废话 */
function headlineFor(
  score: number,
  parts: ScorePart[],
  stats: Insight['stats'],
): string {
  const progress = parts.find((p) => p.key === 'progress')!
  const target = parts.find((p) => p.key === 'target')!

  const overall =
    score >= 85
      ? '恢复情况很好'
      : score >= 70
        ? '恢复情况良好'
        : score >= 60
          ? '恢复情况一般'
          : '需要重点关注'

  // 有明确进步时，把进步幅度说出来 —— 这是家属最想看到的数字
  if (stats.hasBaseline && progress.value > 0.6) {
    const m = /提升 (\d+)%/.exec(progress.detail)
    if (m) return `本周${overall}，动作完成度比之前两周提升 ${m[1]}%`
  }

  const pct = Math.round(target.value * 100)
  return `本周${overall}，动作完成度达到康复目标的 ${pct}%`
}
