// ============================================================================
// AI 上下文：发给模型的那一份「事实」
// ============================================================================
// 【这个模块是什么】
// 把页面上已经算好的结论，压成一份**能安全发出去**的结构化事实，供
// Edge Function 拼进提示词。
//
// 它是纯函数、不碰网络、不发请求 —— 所以 scripts/check-ai.ts 能直接跑它，
// 把「有没有夹带个人信息」「有没有超长」这类最容易出事的地方钉住。
//
// ============================================================================
// 【为什么不是把原始记录发过去】
// ============================================================================
// 三个理由，每个单独都足够：
//
//   1. **隐私**。RehabSession 上有 patient_id、device_id；notes 还是用户
//      自己敲的自由文本。发出去就是不可撤回的数据出境。
//   2. **成本**。分析页一次取 500 条。token 按输入量计费，把 500 条记录
//      的波形和逐次明细发过去，单次成本能翻几十倍。
//   3. **没意义**。模型要回答的是「这段时间怎么样、接下来注意什么」，
//      它需要的是聚合量，不是逐条明细。
//
// 所以这里只发：动作名、目标、均值、趋势前后段、达标状态、依从天数、
// 评分与分项、温度统计、置信度。**不发** notes、waveform、姓名、邮箱、id。
//
// ============================================================================
// 【derived 块：为什么必须预先算好交给它】
// ============================================================================
// 配套的数值闸门（见 aiReply.ts）只放行「上下文里出现过的数字」。如果只给
// 原始值，AI 想说「达标率 61.5%」就得自己做一次除法 —— 而 61.5 不在输入
// 里，那条结论会被拒。
//
//   上下文：onTargetCount 8, totalSessions 13
//   AI 写： 「达标率 61.5%」        → 61.5 不在允许集 → 拒
//
// 与其把闸门放宽（那就挡不住幻觉了），不如**把规则层已经算得出的派生值
// 一并给它**：达不达标率、每个动作差多少度、依从率、次数差。这些都是确定
// 的量，由我们算、由我们背书，AI 只负责引用。
//
// 于是提示词里那条硬约束「所有数值必须取自给定内容，不要自行计算」才真的
// 做得到 —— 想做算术的时候，答案已经在手边了。
// ============================================================================

import { metricLabel } from './assessment.ts'
import type { Insight, RiskBand } from './insight.ts'
import type { TrendReport } from './trend.ts'
import type { AnalysisSummary } from './analysis.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type AiPage = 'dashboard' | 'analysis'

export interface AiScoreFact {
  /** 有没有分数。**不用 null 表示没有** —— 见下面 round 的说明 */
  available: boolean
  value: number | null
  /** 调整前的分。没有调整时与 value 相同 */
  raw: number | null
  /** 档位名，如「恢复良好」 */
  level: string | null
  /** 风险等级（预警+评分合成），与 rating 是**两个轴**，别混 */
  band: RiskBand | null
  /** 只看评分的等级，用于给分数上色 */
  rating: RiskBand | null
}

export interface AiPartFact {
  label: string
  /** 0~1 */
  value: number
  weight: number
  detail: string
  /** 这一项查到的具体短板 */
  weakest: { exercise: string; actual: number; target: number } | null
}

export interface AiItemFact {
  exercise: string
  /** 「关节活动度」或「保持角度」 */
  metric: string
  target: number
  latest: number
  onTarget: boolean
  band: RiskBand
  /** 参与统计的天数 */
  points: number
  /**
   * 方向。**判不出来时是 null** —— 提示词里据此要求「只描述现状，不得推断
   * 方向」。原先直接 JSON 序列化 null，模型会把它读成一个不存在的方向。
   */
  direction: 'up' | 'flat' | 'down' | null
  before: number | null
  after: number | null
}

export interface AiFindingFact {
  label: string
  band: RiskBand
  /** 依据。**含具体数值** —— 数值闸门的允许集一大半来自这里 */
  evidence: string
  action: string
}

export interface AiContext {
  page: AiPage
  /**
   * 窗口的说法，如「本周」「近 30 天」。
   *
   * ⚠️ **由调用方传入**，不在这里推 —— `Insight` 上没有窗口标签，而两页
   *    的窗口本来就不同（首页是「本周」，分析页可选 7/30/90 天）。这个
   *    字段会原样出现在面板标题上，用户要能看出 AI 谈的是哪一段。
   */
  window: string
  /** 数据是不是演示数据。演示数据下 AI 的输出要双重标注 */
  demo: boolean
  score: AiScoreFact | null
  parts: AiPartFact[]
  /** 首页那三张家属语言卡片 */
  cards: { title: string; headline: string; detail: string; band: RiskBand }[]
  items: AiItemFact[]
  findings: AiFindingFact[]
  /** 数据够不够支撑"方向"的判断 */
  enough: {
    hasEnoughData: boolean
    /** 窗口短到趋势不可信 */
    shortWindow: boolean
    sessions: number
    activeDays: number
  }
  /**
   * 系统已经算好的派生值。
   *
   * 键是中文短语（直接进提示词给模型读），值是数字。AI **只许引用**这里的
   * 和上面那些字段里的数字，不许自己算 —— 见文件头。
   */
  derived: Record<string, number>
}

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

/**
 * 各部分的条数上限。
 *
 * ⚠️ `max_tokens` 封的是**输出**，输入没人管。分析页一次取 500 条记录，
 *    不做截断的话这份上下文能膨胀到几十 KB。
 *
 * 上限值不需要精确 —— 它们只在数据多到"看不过来"时才生效，而那种情况下
 * 多几条少几条对结论没有影响。
 */
const MAX_ITEMS = 20
const MAX_FINDINGS = 8
const MAX_CARDS = 3

/**
 * 序列化后的字节数上限。
 *
 * 这个数字由 scripts/check-ai.ts 断言。定得比实测宽裕（演示数据下约
 * 1.5~2 KB），留出真实数据比演示数据更啰嗦的余地，同时远低于会让成本
 * 失控的量级。
 */
export const MAX_CONTEXT_CHARS = 4000

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 保留一位小数。
 *
 * 【为什么不直接发原始浮点】
 * 上下文里是 `78.44444444`，AI 为了好读会写成 `78.4` —— 而 78.4 不等于
 * 78.44444444，数值闸门会把这**条**结论拒掉。先在这里按界面同样的精度
 * 收干净，模型抄的就是这个数，能对上。
 *
 * （闸门那边还留了一道小数位容差兜底，见 aiReply.ts。两处一起才够稳。）
 */
function round(v: number): number {
  return Number.isFinite(v) ? Number(v.toFixed(1)) : 0
}

/** 比率保留三位 —— 它是 0~1 的小数，一位就全没了 */
function ratio(v: number, digits = 3): number {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : 0
}

// ---------------------------------------------------------------------------
// 首页
// ---------------------------------------------------------------------------

export interface InsightContextOptions {
  /** 窗口的说法，如「本周」 */
  window: string
  /** 是不是演示数据 */
  demo: boolean
}

/**
 * 由首页的 `Insight` 构造上下文。
 *
 * ⚠️ `insight` 必须是**页面正在显示的那一份** —— 演示态就传演示态那份。
 *    另算一份的话，AI 会对着和卡片上不一样的数字讲话。
 */
export function buildInsightContext(
  insight: Insight,
  opts: InsightContextOptions,
): AiContext {
  const score = insight.score

  const parts: AiPartFact[] = insight.parts.map((p) => ({
    label: p.label,
    value: ratio(p.value),
    weight: ratio(p.weight, 2),
    detail: p.detail,
    weakest: p.weakest
      ? {
          exercise: p.weakest.exercise,
          actual: round(p.weakest.actual),
          target: round(p.weakest.target),
        }
      : null,
  }))

  const cards = insight.cards.slice(0, MAX_CARDS).map((c) => ({
    title: c.title,
    headline: c.headline,
    detail: c.detail,
    band: c.band,
  }))

  // 评分调整要讲清楚，否则 AI 会拿"调整前 94"当结论说 —— 那正是首页
  // 特意带 delta 要避免的误读
  const derived: Record<string, number> = {
    本周训练次数: insight.stats.weekSessions,
    本周训练天数: insight.stats.weekDays,
  }
  if (score !== null) derived.本周恢复评分 = score
  if (insight.rawScore !== null) derived.调整前评分 = insight.rawScore
  if (insight.adjustments.length) {
    derived.评分共调整 =
      round(insight.adjustments.reduce((a, x) => a + x.delta, 0))
  }
  for (const p of insight.parts) {
    if (p.weakest) {
      derived[`${p.weakest.exercise}达标缺口`] = round(
        p.weakest.target - p.weakest.actual,
      )
    }
  }

  return {
    page: 'dashboard',
    window: opts.window,
    demo: opts.demo,
    score: {
      available: score !== null,
      value: score,
      raw: insight.rawScore,
      level: insight.level.label,
      band: insight.band,
      rating: insight.scoreBand,
    },
    parts,
    cards,
    items: [],
    findings: [],
    enough: {
      hasEnoughData: insight.stats.hasAnyData,
      shortWindow: false,
      sessions: insight.stats.weekSessions,
      activeDays: insight.stats.weekDays,
    },
    derived,
  }
}

// ---------------------------------------------------------------------------
// 分析页
// ---------------------------------------------------------------------------

export interface TrendContextOptions {
  /** 窗口的说法。**AI 用固定窗口，不跟随图表筛选器** —— 理由见下 */
  window: string
  demo: boolean
  /** 概要统计。达标率之类的派生值靠它 */
  summary: AnalysisSummary
}

/**
 * 由分析页的 `TrendReport` 构造上下文。
 *
 * ⚠️ **窗口要固定，不要跟随页面上的筛选器。**
 *    分析页的 rangeDays / exerciseFilter 直接驱动 filtered → trendReport。
 *    若 AI 上下文跟着筛选器走：(1) 每动一次筛选器缓存全失效、重复计费；
 *    (2) 面板上显示的可能是用户已经改掉的窗口。
 *    所以调用方传一个**固定的** window（并让面板标题显示它）。
 */
export function buildTrendContext(
  report: TrendReport,
  opts: TrendContextOptions,
): AiContext {
  const items: AiItemFact[] = report.items.slice(0, MAX_ITEMS).map((it) => ({
    exercise: it.exercise,
    metric: it.metricName || metricLabel(it.metric),
    target: round(it.target),
    latest: round(it.latest),
    onTarget: it.onTarget,
    band: it.band,
    points: it.points,
    direction: it.trend ? it.trend.direction : null,
    before: it.trend ? round(it.trend.before) : null,
    after: it.trend ? round(it.trend.after) : null,
  }))

  const findings: AiFindingFact[] = report.findings
    .slice(0, MAX_FINDINGS)
    .map((f) => ({
      label: f.label,
      band: f.band,
      evidence: f.evidence,
      action: f.action,
    }))

  const s = opts.summary
  const derived: Record<string, number> = {
    训练次数: s.totalSessions,
    覆盖天数: s.activeDays,
    平均每组次数: s.avgReps,
    达标次数: s.onTargetCount,
    温度越阈值次数: s.overTempCount,
    平均识别置信度: s.avgConfidence,
  }
  // ★ 达标率 —— 这正是 AI 最爱说、而它自己要算的那个数
  if (s.totalSessions > 0) {
    derived.达标率 = ratio(s.onTargetCount / s.totalSessions, 3)
  }
  if (s.activeDays > 0) {
    derived.平均每天训练次数 = ratio(s.totalSessions / s.activeDays, 2)
  }
  // ★ 每个动作差多少度 —— 同样是最容易被 AI 自己算出来的那个数
  for (const it of report.items) {
    if (!it.onTarget) {
      derived[`${it.exercise}达标缺口`] = round(it.target - it.latest)
    }
  }

  return {
    page: 'analysis',
    window: opts.window,
    demo: opts.demo,
    score: null,
    parts: [],
    cards: [],
    items,
    findings,
    enough: {
      hasEnoughData: report.hasEnoughData,
      shortWindow: report.shortWindow,
      sessions: report.sessionCount,
      activeDays: report.activeDays,
    },
    derived,
  }
}
