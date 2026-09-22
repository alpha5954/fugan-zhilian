// ============================================================================
// 进展结论：这段时间里，各个动作分别往哪个方向走
// ============================================================================
//
// 【为什么需要独立一层】
// 数据分析页原先从「六个数字」直接跳到「四张图」，中间一句人话都没有 ——
// 用户得自己把曲线翻译成"在进步还是停滞"。而导出的 PDF 走 window.print()，
// 所以拿出去的报告也是四张图加六个数，没人看得出说明什么。
//
// 【它和另外两层的分工 —— 这是本模块最重要的约定】
//
//   首页 insight    —— 本周恢复得怎么样（固定 7 天 + 14 天基线，加权成一个分数）
//   评估页 findings —— 这一次训练做得怎么样（单次会话）
//   这里 trend      —— 所选窗口内，**每个动作分别**往哪个方向走
//
// ⚠️ 所以这一层**刻意不算分数、不评价单次**。再算一个分数就是首页的复读；
//    搬最后一次会话的结论过来就是评估页的复读。它独有的价值是：
//
//      首页只能给：      本周 88 分，恢复良好
//      这里能给的：      屈膝滑动 30 天从 78° 升到 93°，已达目标
//                        直腿抬高一直在 10° 附近，30 天没有变化
//                        坐位伸膝差目标 8°，是唯一还没达标的动作
//
//    "哪个动作在进步、哪个卡住了" —— 这是家属和治疗师最想知道、
//    而另外两页都给不出的事。
//
// 【合规】
// 与 findings.ts 同一套硬线：不给疾病名、不说"诊断"、不给治疗方案。
// 主语必须是"数据/训练"，不是"患者"。断言脚本里两处各钉一份。
//
// 【全是纯函数】
// 不依赖 Vue / Supabase / 当前时间，能被 node 直接跑（见 scripts/check-trend.ts）。
// 趋势判断的边界情况（点太少、全程持平、忽高忽低）用眼睛看不出来。
// ============================================================================

import { REHAB_EXERCISES, metricFor, metricLabel, targetFor } from './assessment.ts'
import type { AssessMetric, ExerciseName } from './assessment.ts'
import { formatDate } from './format.ts'
import type { Finding } from './findings.ts'
import type { RiskBand } from './insight.ts'
import { TEMP_ALERT_THRESHOLD } from './simulator.ts'
import {
  ADHERENCE_MIN_RATIO,
  CONFIDENCE_MIN,
  SHORTFALL_CRITICAL,
  SHORT_WINDOW_DAYS,
  TREND_MIN_ABS,
  TREND_MIN_POINTS,
  TREND_MIN_RATIO,
  TREND_TEMP_CRITICAL,
} from './scoreConfig.ts'
import type { RehabSession } from '@/types'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 趋势方向。只有三档 —— 家属读不出"斜率 2.3°/周" */
export type TrendDirection = 'up' | 'flat' | 'down'

/** 方向判定。**天数够的时候才有** —— 见 TrendItem.trend */
export interface TrendDirectionInfo {
  direction: TrendDirection
  /** 前半段的平均 */
  before: number
  /** 后半段的平均 */
  after: number
  /** after - before */
  delta: number
  /** 达到多少才算"有变化"。按目标的比例算，见 scoreConfig */
  threshold: number
}

export interface TrendItem {
  exercise: string
  /** 判定用的是哪个量 */
  metric: AssessMetric
  /** 该量的中文名。动态动作是「关节活动度」，静力动作是「保持角度」 */
  metricName: string
  /** 该动作的康复目标 */
  target: number
  /** 最近一天的值 */
  latest: number
  /** 最近一天是否达标 */
  onTarget: boolean
  /**
   * 这一行该显示的灯。
   *
   * **由这里算，不由视图算** —— 视图自己判断的话，同一件事会出现
   * "逐动作那一行是黄的、下面那条结论是红的"。等级规则只留一处。
   */
  band: RiskBand
  /** 参与统计的天数 */
  points: number
  /**
   * 方向。**可能是 null**。
   *
   * 【为什么可空，而不是没方向就整条不出现】
   * "在往哪个方向走"和"现在达没达标"是**两件事**：
   *
   *   方向  需要 ≥ TREND_MIN_POINTS 天，两三个点连不出趋势
   *   达标  一次训练就能回答
   *
   * 原先天数不够时整条丢掉，于是一个刚练了三天、或者选了「近 7 天」
   * 的用户，界面上**一个动作都不显示** —— 连"哪个达标了"都看不到。
   * 而那是数据完全支持回答的问题。
   *
   * 现在分开：方向答不了就明说答不了，达标该给照给。
   */
  trend: TrendDirectionInfo | null
}

export interface TrendReport {
  /** 窗口的说法，如「近 30 天」「全部时间」 */
  windowLabel: string
  /** 一句话总结。**总是有值**，数据不够时说明数据不够 */
  headline: string
  /** 逐动作的方向。有数据的动作都在里面，按"最该看的"排前面 */
  items: TrendItem[]
  /** 需要注意 + 建议。与评估页同一套结构 */
  findings: Finding[]
  /**
   * 有没有至少一个动作的方向是能判的。
   *
   * ⚠️ 与 `items.length > 0` **不是一回事** —— items 里也包含那些
   * "记录太少、只有达标状态、没有方向"的动作。判断"能不能谈趋势"
   * 要看这个字段，判断"有没有东西可显示"看 items。
   */
  hasEnoughData: boolean
  /** 窗口是不是短到趋势不可信（见 scoreConfig 的 SHORT_WINDOW_DAYS） */
  shortWindow: boolean
  /** 窗口内的记录数，界面上要显示 */
  sessionCount: number
  /** 窗口内的训练天数 */
  activeDays: number
}

export interface TrendOptions {
  /** 窗口天数。0 表示"全部时间" */
  days: number
  /**
   * 当前时间。传进来而不是内部取，是为了让自检脚本能构造确定的"今天" ——
   * 否则覆盖率之类的断言会随运行时刻漂移（insight.ts 的 now 同理）。
   */
  now?: Date
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** 本地日期键。与 analysis.ts 同一个口径 —— 用 UTC 日期会让凌晨的记录归错天 */
function dateKey(s: RehabSession): string {
  return formatDate(s.started_at)
}

/**
 * 一条记录参与趋势判定的值。
 *
 * ⚠️ **必须走 metricFor**，不能一律取 rom_deg。靠墙静蹲是静力维持，
 *    达标看的是**保持角度**；它的活动范围天然只有几度（只有姿势微调），
 *    拿活动范围去比 55° 的目标会把做得完全正确的患者判成没进展。
 *
 *    这个坑本项目已经踩过三次（completionOf、summarize、findings 各一次），
 *    这里是第四处。老记录没有 hold_deg（那一列是后加的），取不到就跳过 ——
 *    不拿 rom_deg 去硬凑。
 */
function valueOf(s: RehabSession): number | null {
  const exercise = s.exercise as ExerciseName
  if (!REHAB_EXERCISES.includes(exercise)) return null

  const raw = metricFor(exercise) === 'hold' ? s.hold_deg : s.rom_deg
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}

/** 某动作"有变化"的门槛 */
function thresholdFor(exercise: ExerciseName): number {
  return Math.max(TREND_MIN_ABS, targetFor(exercise) * TREND_MIN_RATIO)
}

// ---------------------------------------------------------------------------
// 一、逐动作的趋势
// ---------------------------------------------------------------------------

/**
 * 算一个动作的方向。
 *
 * 【怎么判断方向】
 * 按时间排序后，**前半段均值 vs 后半段均值**。
 *
 * 不用首尾两个点 —— 两端各一次异常值就足以把结论翻过来，而康复数据里
 * 单次波动很常见（患者当天状态、疼痛、疲劳都会影响）。
 * 也不用最小二乘斜率 —— 那个数（"每周上升 2.3°"）家属读不出，
 * 而且它对异常值同样敏感。
 *
 * 前后半段均值是**同一批真实数据**的平均，方向和图上的数字天然一致，
 * 不会出现"显示从 78° 到 76°、却说在上升"这种自相矛盾。
 * （findings.ts 判断疲劳趋势用的是同一个办法，口径一致。）
 *
 * 【为什么要先按日期合并】
 * 一天练三次的动作不应该在趋势里占三倍的权重。先按天取均值，
 * 每天一个点 —— 也和趋势图（analysis.ts 的 buildTrendByExercise）一致，
 * 结论和曲线不会打架。
 */
function trendOfExercise(
  exercise: ExerciseName,
  sessions: RehabSession[],
): TrendItem | null {
  // 按天聚合成一个点。同一天多条取均值
  const byDay = new Map<string, number[]>()
  for (const s of sessions) {
    if (s.exercise !== exercise) continue
    const v = valueOf(s)
    if (v === null) continue
    const key = dateKey(s)
    const list = byDay.get(key)
    if (list) list.push(v)
    else byDay.set(key, [v])
  }

  // 一点数据都没有就真的没什么可说 —— 这个动作在窗口内没出现过
  if (!byDay.size) return null

  // 按日期升序取点。日期键是 YYYY-MM-DD，字典序就是时间序
  const days = [...byDay.keys()].sort()
  const points = days.map((d) => mean(byDay.get(d)!))

  // 最近一天的值，不是全窗口的 mean —— "现在能不能达标"问的是最近的状态，
  // 不是历史平均。这一项**一天记录就成立**，所以放在天数门槛之前算
  const latest = points[points.length - 1]!
  const target = targetFor(exercise)
  const onTarget = latest >= target

  // ⚠️ 天数不够时给 trend: null 而不是整条丢掉。
  //    "方向"答不了，"现在达没达标"照答 —— 见 TrendItem.trend 的注释
  let trend: TrendDirectionInfo | null = null
  if (byDay.size >= TREND_MIN_POINTS) {
    const half = Math.floor(points.length / 2)
    const before = mean(points.slice(0, half))
    const after = mean(points.slice(half))
    const delta = after - before
    const threshold = thresholdFor(exercise)

    trend = {
      direction: delta > threshold ? 'up' : delta < -threshold ? 'down' : 'flat',
      before,
      after,
      delta,
      threshold,
    }
  }

  return {
    exercise,
    metric: metricFor(exercise),
    metricName: metricLabel(metricFor(exercise)),
    target,
    latest,
    onTarget,
    band: bandOfItem(trend, onTarget, latest, target),
    points: byDay.size,
    trend,
  }
}

/**
 * 一条趋势该配什么灯。
 *
 * 与下面 buildFindings 里那条 `trend_stuck` 用的是**同一套判据** ——
 * 差得超过 SHORTFALL_CRITICAL 算"需要处理"，否则"需要注意"。
 * 两处规则必须一致，否则同一件事在逐动作列表里和在结论列表里
 * 会显示成两个等级。
 */
function bandOfItem(
  trend: TrendDirectionInfo | null,
  onTarget: boolean,
  latest: number,
  target: number,
): RiskBand {
  // 在回落：达标了也要留意，没达标就是要处理
  if (trend?.direction === 'down') return onTarget ? 'yellow' : 'red'
  if (onTarget) return 'green'
  // 没达标。方向未知时按"差多少"判 —— 那件事不需要趋势也看得清
  const shortfall = target > 0 ? (target - latest) / target : 0
  return shortfall > SHORTFALL_CRITICAL ? 'red' : 'yellow'
}

/**
 * 逐动作的趋势，按"最该看的"排在前面。
 *
 * 排序：先看达标情况（没达标的排前面），再看方向（下降 > 持平 > 上升）。
 * 家属打开这一页最先要看到的是"哪个还没做好"，不是"哪个做得最好"。
 */
function directionRank(t: TrendDirection | null): number {
  if (t === 'down') return 0
  // 方向和"持平"一起排：判不出来不等于更紧急
  if (t === null || t === 'flat') return 1
  return 2
}

function sortItems(items: TrendItem[]): TrendItem[] {
  return [...items].sort((a, b) => {
    if (a.onTarget !== b.onTarget) return a.onTarget ? 1 : -1
    return directionRank(a.trend?.direction ?? null) - directionRank(b.trend?.direction ?? null)
  })
}

// ---------------------------------------------------------------------------
// 二、需要处理和该做什么
// ---------------------------------------------------------------------------

const BAND_ORDER: Record<RiskBand, number> = { red: 0, yellow: 1, green: 2 }

function buildFindings(
  items: TrendItem[],
  sessions: RehabSession[],
  windowLabel: string,
  now: Date,
): Finding[] {
  const out: Finding[] = []

  // -------------------------------------------------------------------------
  // 1. 温度
  // -------------------------------------------------------------------------
  // ⚠️ 这一条**不是**无条件排第一。排序是先按红黄绿分档的（全项目一致），
  //    而温度只在反复越阈值（≥ TREND_TEMP_CRITICAL 次）时才是红灯。
  //    所以：
  //      越阈 1~2 次 → 黄灯，排在红灯的条目之后，但在同档里最靠前（priority 1）
  //      越阈 ≥3 次   → 红灯，排最前
  //
  //    实测过一个"坐位伸膝差 30°（红）+ 2 次温度越阈（黄）"的构造，
  //    温度排在第二条。这是接受的 —— 两条都看得见，没有被埋。
  //    如果哪天要求"安全必须压过一切"，那要改的是排序规则本身
  //    （让 band 不再是第一排序键），不是给这里塞一个特殊分值。
  const temps = sessions
    .map((s) => s.temp_c)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const over = temps.filter((t) => t >= TEMP_ALERT_THRESHOLD)

  if (over.length) {
    const worst = Math.max(...over)
    out.push({
      key: 'trend_temp_over',
      label: `${windowLabel}有 ${over.length} 次皮温超过安全阈值`,
      // 偶尔一次可能是热敷久了一点；反复出现说明做法有问题
      band: over.length >= TREND_TEMP_CRITICAL ? 'red' : 'yellow',
      evidence:
        `阈值 ${TEMP_ALERT_THRESHOLD} °C，最高一次 ${worst.toFixed(1)} °C，` +
        `共 ${over.length} 次`,
      action: '缩短单次热敷时长；若反复出现，先移开热源让皮肤恢复再继续',
      priority: 1,
    })
  }

  // -------------------------------------------------------------------------
  // 2. 卡住不动的动作 —— 这一层最该说的一件事
  // -------------------------------------------------------------------------
  // "没达标"和"没达标而且一直没变化"是两回事。后者才是真正需要换做法的，
  // 而另外两页都说不出来（首页只看本周，评估页只看单次）。
  const stuck = items.filter(
    (it) => !it.onTarget && it.trend && it.trend.direction !== 'up',
  )
  for (const it of stuck) {
    const gap = it.target - it.latest
    const shortfall = it.target > 0 ? gap / it.target : 0
    const flat = it.trend!.direction === 'flat'

    out.push({
      key: 'trend_stuck',
      label: flat
        ? `「${it.exercise}」${windowLabel}没有明显变化，且未达目标`
        : `「${it.exercise}」${windowLabel}有所回落，且未达目标`,
      // 差得少（三成以内）算"需要注意"，差得多算"需要处理"
      band: shortfall > 0.3 ? 'red' : 'yellow',
      evidence:
        `${it.points} 天记录，${it.metricName}由 ${it.trend!.before.toFixed(1)}° ` +
        `${flat ? '维持' : '降至'} ${it.trend!.after.toFixed(1)}°；` +
        `最近一次 ${it.latest.toFixed(1)}°，目标 ${it.target}°，差 ${gap.toFixed(1)}°`,
      action:
        it.metric === 'hold'
          ? '在无痛前提下逐步延长保持时间、加深下蹲角度；连续几次都无改善请联系治疗师'
          : '在无痛范围内逐步增加活动幅度；连续几次都无改善请联系治疗师',
      priority: 5,
    })
  }

  // -------------------------------------------------------------------------
  // 2b. 记录太少、判不出方向，但最近一次没达标
  // -------------------------------------------------------------------------
  // 和上面那条分开：那条说的是"一直没变化"（我们确实看出来了），
  // 这条说的是"看不出来，而且现在也没达标"。**不能混** ——
  // 用"没有明显变化"去描述一个只有两天记录的动作，是编结论。
  const unknown = items.filter((it) => !it.onTarget && !it.trend)
  if (unknown.length) {
    out.push({
      key: 'trend_insufficient',
      label:
        unknown.map((it) => `「${it.exercise}」`).join('') +
        `记录还太少，看不出变化，且最近一次未达目标`,
      band: 'yellow',
      evidence: unknown
        .map(
          (it) =>
            `${it.exercise} 最近 ${it.latest.toFixed(1)}° / 目标 ${it.target}°` +
            `（仅 ${it.points} 天记录）`,
        )
        .join('；'),
      action: `多练几次再回这一页看趋势；单次未达标很常见，先按方案继续`,
      priority: 30,
    })
  }

  // -------------------------------------------------------------------------
  // 3. 整体回落
  // -------------------------------------------------------------------------
  // 上面那条只管"未达标且没在好"。这一条管"本来达标了，最近在退"——
  // 那比一直没达标更值得警觉
  const falling = items.filter(
    (it) => it.trend?.direction === 'down' && it.onTarget,
  )
  for (const it of falling) {
    out.push({
      key: 'trend_down',
      label: `「${it.exercise}」近期较前期有所回落`,
      band: 'yellow',
      evidence:
        `${it.metricName}由 ${it.trend!.before.toFixed(1)}° 降至 ${it.trend!.after.toFixed(1)}°` +
        `（${Math.abs(it.trend!.delta).toFixed(1)}°），目前 ${it.latest.toFixed(1)}° 仍在目标 ${it.target}° 以上`,
      action: '先看是否与当天的状态、疼痛或疲劳有关；连续几次都低再联系治疗师',
      priority: 40,
    })
  }

  // -------------------------------------------------------------------------
  // 4. 练得太少
  // -------------------------------------------------------------------------
  const activeDays = new Set(sessions.map(dateKey)).size
  const spanDays = observedSpanDays(sessions, now)
  if (spanDays > 0) {
    const coverage = activeDays / spanDays
    if (coverage < ADHERENCE_MIN_RATIO) {
      out.push({
        key: 'trend_low_adherence',
        label: `${windowLabel}训练天数偏少`,
        band: 'yellow',
        evidence: `${spanDays} 天里训练了 ${activeDays} 天（${Math.round(coverage * 100)}%）`,
        action: '康复靠的是频次稳定，隔太久效果会打折；建议固定到每天的同一时段',
        priority: 60,
      })
    }
  }

  // -------------------------------------------------------------------------
  // 5. 识别质量
  // -------------------------------------------------------------------------
  const confs = sessions
    .map((s) => s.confidence)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const avgConf = mean(confs)
  if (confs.length && avgConf < CONFIDENCE_MIN) {
    out.push({
      key: 'trend_low_confidence',
      label: `${windowLabel}动作识别置信度偏低`,
      band: 'yellow',
      evidence: `平均置信度 ${(avgConf * 100).toFixed(1)}%（低于 ${(CONFIDENCE_MIN * 100).toFixed(0)}%）`,
      action: '确保电极片贴合、动作完整；必要时重新采集',
      priority: 70,
    })
  }

  // -------------------------------------------------------------------------
  // 6. 好消息也要说
  // -------------------------------------------------------------------------
  // 只报问题的话，一个恢复得很好的患者打开这一页会看到"没有任何结论"，
  // 那比说一句"在稳定改善"更让人不安
  const rising = items.filter((it) => it.trend?.direction === 'up')
  if (rising.length) {
    const names = rising.map((it) => `「${it.exercise}」`).join('')
    const total = rising.reduce((s, it) => s + it.trend!.delta, 0)
    out.push({
      key: 'trend_up',
      label: `${names}${windowLabel}在稳定改善`,
      band: 'green',
      evidence: rising
        .map(
          (it) =>
            `${it.exercise} ${it.trend!.before.toFixed(1)}° → ${it.trend!.after.toFixed(1)}°`,
        )
        .join('；') + `，合计提升 ${total.toFixed(1)}°`,
      action: '保持当前训练方案',
      priority: 90,
    })
  } else if (
    items.length &&
    items.every((it) => it.trend?.direction === 'flat')
  ) {
    out.push({
      key: 'trend_flat_all',
      label: `${windowLabel}各动作基本持平`,
      band: 'green',
      evidence: items
        .map((it) => `${it.exercise} ${it.trend!.after.toFixed(1)}°（目标 ${it.target}°）`)
        .join('；'),
      action: '康复有平台期是正常的，按当前方案继续',
      priority: 100,
    })
  }

  return out.sort(
    (a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || a.priority - b.priority,
  )
}

/**
 * 从窗口内**第一次记录**到今天的天数，至少 1。
 *
 * 分母刻意不是窗口长度：一个三天前才开始训练、每天都练的患者覆盖率是
 * 100%，不该被说成"练得太少"。问的是"他能练的日子里练了多少"。
 */
function observedSpanDays(sessions: RehabSession[], now: Date): number {
  if (!sessions.length) return 0
  const times = sessions
    .map((s) => new Date(s.started_at).getTime())
    .filter((t) => Number.isFinite(t))
  if (!times.length) return 0

  const first = new Date(Math.min(...times))
  first.setHours(0, 0, 0, 0)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  return Math.max(1, Math.round((today.getTime() - first.getTime()) / DAY_MS) + 1)
}

// ---------------------------------------------------------------------------
// 三、一句话总结
// ---------------------------------------------------------------------------

/**
 * 总结句。**任何情况下都要有话说**。
 *
 * 分成几种情形，但共同要求是：先给窗口，再给判断 ——
 * 不含窗口的结论会被误当成"整体情况"。
 */
function headlineFor(
  items: TrendItem[],
  sessions: RehabSession[],
  windowLabel: string,
): string {
  const n = sessions.length
  const days = new Set(sessions.map(dateKey)).size

  if (!n) return `${windowLabel}没有训练记录`

  if (!items.length) {
    return (
      `${windowLabel}共 ${n} 次训练、覆盖 ${days} 天，` +
      `但单个动作的记录都不到 ${TREND_MIN_POINTS} 天，还看不出趋势`
    )
  }

  const judged = items.filter((it) => it.trend !== null)
  const onTarget = items.filter((it) => it.onTarget).length

  // 一个动作的方向都判不出来 —— 说清"方向看不出"，但把**能答的答掉**。
  // 只说"看不出趋势"就停住是不对的：这一次达没达标，数据是支持回答的
  if (!judged.length) {
    return (
      `${windowLabel}共 ${n} 次训练、覆盖 ${days} 天；` +
      `单个动作的记录都不到 ${TREND_MIN_POINTS} 天，看不出方向，` +
      `其中 ${onTarget}/${items.length} 个动作最近一次达到目标`
    )
  }

  const rising = judged.filter((it) => it.trend!.direction === 'up').length
  const falling = judged.filter((it) => it.trend!.direction === 'down').length
  const stuck = judged.filter(
    (it) => !it.onTarget && it.trend!.direction !== 'up',
  ).length

  const parts: string[] = []
  if (rising) parts.push(`${rising} 个动作在改善`)
  if (stuck) parts.push(`${stuck} 个仍然没达到目标`)
  if (falling) parts.push(`${falling} 个有所回落`)

  const summary = parts.length
    ? parts.join('，')
    : `${onTarget} 个动作达到目标，其余基本持平`

  // 有动作因为记录太少而没参与方向判断，要说出来 ——
  // 不说的话"4 个动作在改善"会被当成全部动作的情况
  const skipped = items.length - judged.length
  const tail = skipped ? `（另有 ${skipped} 个动作记录太少，看不出方向）` : ''

  return `${windowLabel}共 ${n} 次训练、覆盖 ${days} 天：${summary}${tail}`
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 产出一份进展报告。
 *
 * @param sessions 已经按窗口和动作筛过的记录。这个函数不再筛 ——
 *                 视图层的筛选条件（时间范围、动作）和这里必须一致，
 *                 否则结论和图会说的不是一回事
 * @param opts.days 窗口天数，0 表示全部时间。**只用于文案和短窗口提示**，
 *                  不参与筛选
 */
export function buildTrendReport(
  sessions: RehabSession[],
  opts: TrendOptions,
): TrendReport {
  const now = opts.now ?? new Date()
  const windowLabel = opts.days > 0 ? `近 ${opts.days} 天` : '全部时间'

  const present = REHAB_EXERCISES.filter((e) =>
    sessions.some((s) => s.exercise === e),
  )

  const items = sortItems(
    present
      .map((e) => trendOfExercise(e, sessions))
      .filter((x): x is TrendItem => x !== null),
  )

  return {
    windowLabel,
    headline: headlineFor(items, sessions, windowLabel),
    items,
    findings: buildFindings(items, sessions, windowLabel, now),
    hasEnoughData: items.some((it) => it.trend !== null),
    shortWindow: opts.days > 0 && opts.days < SHORT_WINDOW_DAYS,
    sessionCount: sessions.length,
    activeDays: new Set(sessions.map(dateKey)).size,
  }
}

/** 方向的中文说法，界面与文案共用一处 */
export const DIRECTION_LABEL: Record<TrendDirection, string> = {
  up: '稳步改善',
  flat: '基本持平',
  down: '有所回落',
}
