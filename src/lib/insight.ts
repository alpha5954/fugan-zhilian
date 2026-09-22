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
import type { AssessMetric, ExerciseName } from './assessment.ts'
import {
  BASELINE_DAYS,
  MIN_BASELINE_SESSIONS,
  NEUTRAL_SCORE,
  PROGRESS_FULL_SWING,
  PROGRESS_NEUTRAL,
  RECOMMENDED_DAYS_PER_WEEK,
  SAFETY_PENALTY,
  SCORE_LEVELS,
  STABILITY_CV_LIMIT,
  STABILITY_CONCERN_SCORE,
  STABILITY_FAIR_CV,
  STABILITY_GOOD_CV,
  STABILITY_NEUTRAL,
  SUFFICIENT_SESSIONS,
  WEIGHTS,
  WINDOW_DAYS,
} from './scoreConfig.ts'
import type { ScoreLevel } from './scoreConfig.ts'
import type { Alert, RehabSession } from '@/types'

// ---------------------------------------------------------------------------
// 时间窗口
// ---------------------------------------------------------------------------
// 窗口长度、四项权重、各种阈值全部在 scoreConfig.ts 里 —— 那些是**该由
// 康复科核定**的数字，不该混在算法实现里。这里只留推导出来的常量。

const DAY_MS = 86_400_000

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
  /**
   * 这一项**查到的具体短板**，供建议直接引用。
   *
   * 【为什么要有这个字段】
   * 建议原先是拿四个分量的**分值**比大小，挑最低的那个说。但四个分量的
   * "正常水平"根本不同：训练坚持要么够要么不够、动作达标通常接近满分、
   * 而动作稳定天然带波动，89 分是常态而不是问题。
   *
   * 实测后果（demo 数据）：稳定 89 分被挑中，建议说「把动作放慢一些」；
   * 而同一份数据里真正该说的是「坐位伸膝差 8°」—— 这件事
   * 「动作达标」那一项**已经算出来了**（见 weakestExercise），
   * 只是分值 99 让它排不到前面，于是证据被丢掉、结论指错了方向。
   *
   * 现在把短板原样带出来，建议就能直接指名道姓。
   */
  weakest?: { exercise: string; actual: number; target: number }
}

/**
 * 卡片的图标标识。
 *
 * ⚠️ **是名字，不是图形。** 这一层是纯函数模块，能被 node 直接跑
 *    （见 scripts/check-insight.ts），**不能 import Vue 组件**。
 *    所以这里只给标识，由视图映射成具体的图标组件
 *    （见 Dashboard.vue 的 CARD_ICON）。
 *
 * 原先这里存的是 emoji 字面量（'📋' / '🛡️' / '💡'）。那种做法把
 * "显示什么"和"长什么样"混在了一起 —— 换图标库要改到算法层来。
 */
export type SummaryIcon =
  /** 今天做了什么 */
  | 'clipboard'
  /** 一切正常 */
  | 'shield-check'
  /** 有需要注意的 */
  | 'triangle-alert'
  /** 下一步该做什么 */
  | 'lightbulb'

/** 首页那三张家属语言卡片 */
export interface SummaryCard {
  key: 'today' | 'risk' | 'advice'
  /** 图标标识。理由见 SummaryIcon */
  icon: SummaryIcon
  title: string
  /** 一句话结论，尽量短 */
  headline: string
  /** 补充说明，可以是空的 */
  detail: string
  band: RiskBand
}

/**
 * 一次评分调整。
 *
 * 带 `delta` 是为了让界面能说清"掉了多少分"。原来只有一句话
 * （"评分已下调"）加一个调整前的分数，家属要自己减 —— 实测 demo 的
 * 情况是 raw 94 → score 80，**中间跨了一个档位**（≥90 是"优秀"、
 * ≥80 是"良好"），展开详情看到 94 的人会问"那我到底是多少分"。
 */
export interface ScoreAdjustment {
  /** 家属语言，说明为什么调整 */
  text: string
  /** 这一步让分数变化了多少。负数表示下调 */
  delta: number
}

export interface Insight {
  /** 0~100 的整数。没有数据时为 null */
  score: number | null
  /**
   * **调整前**的加权分。
   *
   * 留着它是为了把调整讲清楚：界面上要说"本周有安全事件，评分已下调
   * （原 85 分）"。只给最终分的话，家属没法判断下调了多少。
   * 没有调整时与 score 相同。
   */
  rawScore: number | null
  /** 档位。比颜色细一档，主要作用是**解释**分数意味着什么 */
  level: ScoreLevel
  /**
   * 分数经过了哪些调整。
   *
   * 空数组表示没调整过。有内容时必须展示出来 —— 悄悄改分而不说明
   * 是这个界面最不能做的事。每一项都带 delta，界面要说清掉了多少分。
   */
  adjustments: ScoreAdjustment[]
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

/** 一次训练相对它的目标完成了多少 */
interface Completion {
  /** 0~1 的完成度，**已封顶**。用于"动作达标" */
  ratio: number
  /**
   * 未封顶的完成度。达标时大于 1。
   *
   * 【为什么必须留着它】
   * 封顶会让"达标之后继续变好"在数学上消失。实测过：固定基线 90°，
   * 本周分别做到 90° / 95° / 120° / 140°，**四种情况得到完全相同的
   * 得分和完全相同的一句"基本持平"** —— 因为两边都被读成 1.0，
   * 变化率恒为 0。
   *
   * 而康复中后期的主要目标恰恰就是"达标之后继续改善"，
   * 那段时间里 30% 的权重等于不存在。
   *
   * 所以两个口径分开：
   *   算**达标度**用 ratio   —— 达标就是达标，多做不该补别的短板
   *   算**变化趋势**用 raw   —— 变没变好必须看得见
   */
  raw: number
  /** 判定用的实测值（动态动作是活动范围，静力动作是保持角度） */
  actual: number
  /** 判定用的是哪个量 */
  metric: AssessMetric
  /** 该动作的康复目标 */
  target: number
}

/**
 * 算一次训练相对它自己的目标完成了多少。
 *
 * 【判定指标按动作类型分】
 *   动态屈伸（坐位伸膝等）→ 看**关节活动范围**（行程）
 *   静力维持（靠墙静蹲）  → 看**保持角度**
 *
 * ⚠️ 这两者不能混。靠墙静蹲的活动范围天然只有 5~10°（只有姿势微调），
 *    拿它去比 55° 的目标会得出接近 0 的完成度，把做得完全正确的患者
 *    判成 0 分。
 *
 *    早先表里只存了 rom_deg，所以那版**整个跳过了静力动作** ——
 *    等于这类动作在评分里完全不存在。给 rehab_sessions 加了 hold_deg
 *    之后才算真正接上（迁移见 20260922090000_add_hold_deg）。
 *
 *    老记录没有 hold_deg（那列是后加的），这时返回 null 而不是拿
 *    rom_deg 去硬凑 —— 宁可少算，也不要算错。
 */
function completionOf(session: RehabSession): Completion | null {
  const exercise = session.exercise as ExerciseName
  if (!REHAB_EXERCISES.includes(exercise)) return null

  const target = targetFor(exercise)
  if (target <= 0) return null

  const metric = metricFor(exercise)

  if (metric === 'hold') {
    const h = session.hold_deg
    if (typeof h !== 'number') return null
    return { ratio: clamp01(h / target), raw: h / target, actual: h, metric, target }
  }

  const rom = session.rom_deg
  if (typeof rom !== 'number') return null
  return { ratio: clamp01(rom / target), raw: rom / target, actual: rom, metric, target }
}

/** 取完成度，只要封顶后的比值。用于达标度 */
function ratioOf(session: RehabSession): number | null {
  return completionOf(session)?.ratio ?? null
}

/**
 * 取**未封顶**的完成度。用于一切"和以前比"的计算。
 *
 * 进步度和稳定性都必须用它，理由见 Completion.raw 的注释 ——
 * 用封顶值的话，达标之后的变化会被抹平。
 */
function rawRatioOf(session: RehabSession): number | null {
  return completionOf(session)?.raw ?? null
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
  const ratios = input.week.map(ratioOf).filter((r): r is number => r !== null)

  if (!ratios.length) {
    return {
      key: 'target',
      label: '动作达标',
      value: 0,
      weight: WEIGHTS.target,
      detail: '本周还没有可用于判定的训练记录',
    }
  }

  const value = mean(ratios)
  const pct = Math.round(value * 100)

  // 找出做得最差的那个动作。具体说是谁，比"本周完成 73%"有用得多
  const worst = weakestExercise(input.week)

  return {
    key: 'target',
    label: '动作达标',
    value,
    weight: WEIGHTS.target,
    detail: worst
      ? `本周达到康复目标的 ${pct}%，其中「${worst.exercise}」差距最大` +
        `（${Math.round(worst.actual)}° / 目标 ${worst.target}°，` +
        `差 ${Math.round(worst.target - worst.actual)}°）`
      : `本周达到康复目标的 ${pct}%`,
    ...(worst ? { weakest: worst } : {}),
  }
}

/**
 * 本周**未达标**里差距最大的那个动作。全都达标时返回 null。
 *
 * 【为什么必须排除已达标的】
 * 原先是拿所有动作比大小，封顶之后所有达标的比值都是 1.0，
 * `<` 比较会**随便挑一个**。实测挑出过这样的句子：
 *
 *     本周达到康复目标的 100%，其中「屈膝滑动」差距最大（120° / 目标 90°）
 *
 * 120° 比目标高 33%，被称为"差距最大"。答辩时被问到这句很难解释。
 *
 * 没有差距的时候就不该说"差距最大" —— 返回 null，让上面少说一句。
 */
function weakestExercise(
  week: RehabSession[],
): { exercise: string; actual: number; target: number } | null {
  let worst: { exercise: string; actual: number; target: number; raw: number } | null =
    null

  for (const c of week) {
    const done = completionOf(c)
    if (!done) continue
    // 达标的（含刚好达标）不参与"差距最大"的评选
    if (done.actual >= done.target) continue
    if (!worst || done.raw < worst.raw) {
      worst = {
        exercise: c.exercise,
        actual: done.actual,
        target: done.target,
        raw: done.raw,
      }
    }
  }

  return worst
    ? { exercise: worst.exercise, actual: worst.actual, target: worst.target }
    : null
}

function progressPart(input: PartInput): ScorePart {
  // ⚠️ 这里用**未封顶**的完成度。用封顶值的话，一个已经达标的患者
  //    无论继续进步多少，两边都读成 1.0，变化率恒为 0 —— 这一项
  //    对他永久失效。见 Completion.raw 的注释。
  const weekRatios = input.week.map(rawRatioOf).filter((r): r is number => r !== null)
  const baseRatios = input.baseline.map(rawRatioOf).filter((r): r is number => r !== null)

  const hasBaseline = input.baseline.length >= MIN_BASELINE_SESSIONS

  if (!hasBaseline || !weekRatios.length || !baseRatios.length) {
    return {
      key: 'progress',
      label: '进步情况',
      value: PROGRESS_NEUTRAL,
      weight: WEIGHTS.progress,
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

  // 变化 ±PROGRESS_FULL_SWING 分别对应满分和零分，0 对应中间值。
  // 不按正比映射，是因为康复本来就有平台期，原地踏步不该被判成不及格。
  const value = clamp01(PROGRESS_NEUTRAL + (change / PROGRESS_FULL_SWING) * (1 - PROGRESS_NEUTRAL))

  const pct = Math.round(change * 100)
  const dir = pct > 0 ? '提升' : pct < 0 ? '下降' : '持平'

  return {
    key: 'progress',
    label: '进步情况',
    value,
    weight: WEIGHTS.progress,
    detail:
      pct === 0
        ? '和之前两周相比基本持平'
        : `比之前两周${dir} ${Math.abs(pct)}%`,
  }
}

/** 变异系数：标准差 ÷ 均值。看不见波动时返回 0 */
function cvOf(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return m > 0 ? stdDev(xs) / m : 0
}

/**
 * 动作稳定 —— 同一个动作**每次做得一不一样**。
 *
 * 【为什么必须按动作分组】
 * 原先把一周里所有动作的完成度混在一起算变异系数。但那样算出来的
 * 量的是**动作之间**的差异，不是动作内部的波动 —— 两件完全不同的事。
 *
 * 实测对照（同一台机器、同一组构造）：
 *
 *   同一动作 6 次完全一致（零抖动）+ 一次坐位伸膝 72°  → 稳定 **88**
 *   同一动作抖动 88~98（±5%），无跨动作               → 稳定 **97**
 *
 * **零抖动的那一组分数反而更低。** 因为它其实在测"你有个动作没达标"，
 * 而这件事已经由「动作达标」那一项说了，在这里再说一遍是重复计分。
 *
 * 【为什么用未封顶的完成度】
 * 封顶会把接近满分时的波动压平 —— 一个在 130°~140° 之间波动的患者
 * 曾经因为全部封顶到 1.0 而显示"发挥稳定"。天花板不该制造稳定性。
 *
 * 【怎么加权】
 * 按每个动作的会话数加权：练了 5 次的动作比只练 1 次的动作更能说明
 * 这个人的稳定性，而只有 ≥2 次的动作才估得出组内波动。
 */
function stabilityPart(input: PartInput): ScorePart {
  const groups = new Map<string, number[]>()
  for (const s of input.week) {
    const done = completionOf(s)
    if (!done) continue
    const arr = groups.get(s.exercise) ?? []
    arr.push(done.raw)
    groups.set(s.exercise, arr)
  }

  // 只有练过两次以上的动作才能估波动。全都只练了一次就无从谈起
  const usable = [...groups.values()].filter((a) => a.length >= 2)

  if (!usable.length) {
    return {
      key: 'stability',
      label: '动作稳定',
      value: STABILITY_NEUTRAL,
      weight: WEIGHTS.stability,
      detail: '本周记录太少，还看不出动作是否稳定',
    }
  }

  const total = usable.reduce((sum, a) => sum + a.length, 0)
  const cv = usable.reduce((sum, a) => sum + cvOf(a) * a.length, 0) / total

  const value = clamp01(1 - cv / STABILITY_CV_LIMIT)
  // 挑波动最大的那个动作说。具体到动作名，患者才知道该盯哪一个
  const jumpiest = usable.reduce((a, b) => (cvOf(b) > cvOf(a) ? b : a))
  const jumpiestCv = cvOf(jumpiest)

  return {
    key: 'stability',
    label: '动作稳定',
    value,
    weight: WEIGHTS.stability,
    detail:
      cv < STABILITY_GOOD_CV
        ? '每次训练的水平都很接近，发挥稳定'
        : cv < STABILITY_FAIR_CV
          ? '每次训练之间有起伏，总体可控'
          : `每次训练之间的水平忽高忽低（${Math.round(jumpiestCv * 100)}% 的波动），` +
            '建议放慢动作速度、保证组间休息',
  }
}

function adherencePart(input: PartInput): ScorePart {
  const value = clamp01(input.weekDays / RECOMMENDED_DAYS_PER_WEEK)

  return {
    key: 'adherence',
    label: '训练坚持',
    value,
    weight: WEIGHTS.adherence,
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

/** 分数对应的档位。分档表在 scoreConfig.ts 里，从高到低第一个命中的即结果 */
function levelFor(score: number): ScoreLevel {
  const hit = SCORE_LEVELS.find((l) => score >= l.min) ?? SCORE_LEVELS.at(-1)!
  return { key: hit.key, label: hit.label, detail: hit.detail }
}

/**
 * 本周最严重的预警等级。没有预警时返回 null。
 *
 * 按**最严重的**那一条算，不累加 —— 3 次一般提醒不等于比 1 次严重 3 倍。
 * 次数会写在提示文案里，不藏。
 */
function worstSeverity(alerts: Alert[]): Alert['severity'] | null {
  let worst: Alert['severity'] | null = null
  for (const a of alerts) {
    if (worst === null || severityRank(a.severity) > severityRank(worst)) {
      worst = a.severity
    }
  }
  return worst
}

/**
 * 把加权分调整成最终分，并记录调了什么。
 *
 * 两步，顺序不能反：
 *
 *   ① 数据充分度收缩 —— 样本少时把分数拉向中性值。
 *      放在前面，是因为"测出来多少分"本来就该先按可信度打折。
 *
 *   ② 安全下调 —— 用乘数而不是扣分项。
 *      安全事件的影响**不该是线性的**，它不能被"动作做得好"补回来。
 *      放在最后，保证它永远足额生效，不会被收缩稀释。
 */
function adjustScore(
  rawScore: number,
  weekSessions: number,
  weekAlerts: Alert[],
): { score: number; adjustments: ScoreAdjustment[] } {
  const adjustments: ScoreAdjustment[] = []
  const before = Math.round(rawScore)
  let score = rawScore

  // ① 数据充分度
  const sufficiency = clamp01(weekSessions / SUFFICIENT_SESSIONS)
  if (sufficiency < 1) {
    score = sufficiency * score + (1 - sufficiency) * NEUTRAL_SCORE
    adjustments.push({
      text: `本周只有 ${weekSessions} 次记录，数据偏少，评分已向中间值收敛`,
      delta: Math.round(score) - before,
    })
  }

  // ② 安全下调
  const worst = worstSeverity(weekAlerts)
  if (worst === 'critical' || worst === 'warning') {
    const n = weekAlerts.filter((a) => a.severity === worst).length
    const from = Math.round(score)
    score *= SAFETY_PENALTY[worst]
    adjustments.push({
      text:
        worst === 'critical'
          ? `本周有 ${n} 次严重安全事件（温度超过安全阈值或信号中断），评分已下调`
          : `本周有 ${n} 次安全提醒，评分已下调`,
      delta: Math.round(score) - from,
    })
  }

  return { score: Math.round(score), adjustments }
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
      icon: 'clipboard',
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
    icon: 'clipboard',
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
      icon: 'shield-check',
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
    icon: 'triangle-alert',
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
 * 生成"下一步建议"。
 *
 * 【为什么不按分值挑最弱的那一项】
 * 原先是拿四个分量的分值比大小、挑最低的说。这个规则看着公平，实际
 * 是错的 —— **四个分量的"正常水平"根本不同**：
 *
 *   训练坚持  要么够要么不够，满分是常态
 *   动作达标  康复中的患者通常接近满分
 *   动作稳定  天然带波动，89 分是正常发挥而不是问题
 *
 * 拿它们的绝对值比大小，低分永远出在稳定项上。实测（demo 数据）：
 * 稳定 89 被挑中，建议说「把动作放慢一些」；而同一份数据里真正该说的
 * 是「坐位伸膝差 8°」—— 证据就在「动作达标」那一项里，因为分值 99
 * 排不到前面，被丢掉了。
 *
 * 【现在的规则】
 * 固定优先级，每一档各自有"够不够格被提"的条件：
 *
 *   ① 未处理的严重预警   —— 安全问题永远第一
 *   ② 动作确实不稳       —— 门槛与文案同一套阈值（见 scoreConfig）
 *   ③ 训练频次不够       —— 依从性是一切的前提
 *   ④ 有具体动作没达标   —— 指名道姓 + 说清差多少
 *   ⑤ 其余               —— 保住成果
 *
 * 【为什么"不稳"要排在"没达标"前面】
 * 稳定性差的时候，"平均值差多少度"是**误导性的描述**。一个在 45° 和
 * 90° 之间反复横跳、目标 90° 的患者，平均完成度只有 50%，按第 ④ 档
 * 会告诉他"还差 45°" —— 可他明明三次做到了 90°，真正的问题是他稳不住。
 * 照"再放开一点"去练没有用，该做的是放慢。
 *
 * 所以第 ④ 档加了一条限制：**只有在动作本身不稳时才会被前面的档位拦下**，
 * 否则"差多少度"才是对当前状态的准确描述。
 *
 * 规则驱动而不是大模型：每一条都能被治疗师审核，答辩时也能说清依据。
 * 将来若要用大模型润色文案，改的应该是措辞，不是"说什么" —— 决定
 * 说什么的必须是这张表。
 */
function adviceFor(
  parts: ScorePart[],
  weekAlerts: Alert[],
  stats: Insight['stats'],
): SummaryCard {
  // 标注类型，否则 'lightbulb' 会被推断成 string 而收窄不到 SummaryIcon
  const base: Pick<SummaryCard, 'key' | 'icon' | 'title'> = {
    key: 'advice',
    icon: 'lightbulb',
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

  // ① 有未处理的严重预警时，建议围绕它展开 —— 这比谈分数重要得多
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

  const partOf = (k: ScorePart['key']) => parts.find((p) => p.key === k)!
  const target = partOf('target')

  // ② 动作确实不稳。门槛与稳定项文案用的是同一套阈值 ——
  //    文案说"偶有起伏，总体可控"的时候，不该同时在建议里让人放慢。
  //
  //    排在"没达标"前面：不稳的时候"平均差多少度"会误导人。
  //    一个在 45° 和 90° 之间横跳、目标 90° 的患者，平均完成度只有 50%，
  //    但"还差 45°"不是对他状态的准确描述 —— 他三次做到了 90°，
  //    问题是他稳不住，该放慢而不是再放开
  if (partOf('stability').value < STABILITY_CONCERN_SCORE) {
    return {
      ...base,
      headline: '把动作放慢一些，让每次幅度更接近',
      detail: '动作忽大忽小会影响康复效果，建议组间多休息一会儿',
      band: 'yellow',
    }
  }

  // ③ 训练频次不够。练得太少时，"某个动作差几度"还不足以说明问题
  if (partOf('adherence').value < 1) {
    return {
      ...base,
      headline: `这周训练了 ${stats.weekDays} 天，建议补到 ${RECOMMENDED_DAYS_PER_WEEK} 天`,
      detail: '康复训练靠的是频次稳定，隔太久效果会打折',
      band: 'yellow',
    }
  }

  // ④ 有具体动作没达标。指名道姓 + 说清差多少 —— 家属知道该盯哪一个
  if (target.weakest) {
    const w = target.weakest
    const gap = Math.round(w.target - w.actual)
    return {
      ...base,
      headline: `「${w.exercise}」还差 ${gap}°，下次再放开一点`,
      detail:
        `本周实测 ${Math.round(w.actual)}°，目标 ${w.target}°。` +
        '在无痛范围内逐步增加幅度，不要硬拉',
      band: 'yellow',
    }
  }

  // ⑤ 动作都达标、练得也够，但比之前有回落 —— 说说这件事
  if (partOf('progress').value < 0.4) {
    return {
      ...base,
      headline: '最近进步放缓，别着急',
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
      rawScore: null,
      level: levelFor(0),
      adjustments: [],
      band: 'yellow',
      // 没有分数就谈不上等级。给绿而不是黄：这不是"需要注意"，
      // 只是"还没开始"，家属第一次打开不该看到一个警告色
      scoreBand: 'green',
      headline: '还没有训练数据，完成第一次训练后这里会显示恢复情况',
      parts,
      cards: [
        todayCard([], []),
        riskCard(weekAlerts),
        adviceFor(parts, weekAlerts, stats),
      ],
      stats,
    }
  }

  const weighted = parts.reduce((sum, p) => sum + p.value * p.weight, 0)
  const rawScore = Math.round(weighted * 100)
  const { score, adjustments } = adjustScore(rawScore, week.length, weekAlerts)
  // 风险等级用**调整后**的分数：一个被安全事件压到 51 分的患者，
  // 不该因为原始加权分是 85 就显示绿灯
  const band = bandFor(score, weekAlerts)

  return {
    score,
    rawScore,
    level: levelFor(score),
    adjustments,
    band,
    scoreBand: scoreBandFor(score),
    headline: headlineFor(score, parts, stats),
    parts,
    cards: [
      todayCard(today, week),
      riskCard(weekAlerts),
      adviceFor(parts, weekAlerts, stats),
    ],
    stats,
  }
}

/**
 * 评分下面那句解释。
 *
 * 只给**具体证据**，不复述定性评价 —— "恢复情况良好"这类话已经由
 * level 那一行说了（「恢复良好 · 保持得很好」），再说一遍是重复。
 * 这里回答的是"凭什么给这个分"：提升了多少，或者达标到几成。
 */
function headlineFor(
  _score: number,
  parts: ScorePart[],
  stats: Insight['stats'],
): string {
  const progress = parts.find((p) => p.key === 'progress')!
  const target = parts.find((p) => p.key === 'target')!

  // 有明确进步时优先说幅度 —— 这是家属最想看到的数字
  if (stats.hasBaseline && progress.value > 0.6) {
    const m = /提升 (\d+)%/.exec(progress.detail)
    if (m) return `动作完成度比之前两周提升 ${m[1]}%`
  }

  const pct = Math.round(target.value * 100)
  return `动作完成度达到康复目标的 ${pct}%`
}
