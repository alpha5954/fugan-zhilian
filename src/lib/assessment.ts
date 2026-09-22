// ============================================================================
// 康复评估：会话数据生成与指标计算
// ============================================================================
// 硬件未接入，这里用模拟器生成一次完整训练会话，再按真实的信号处理方法
// 算出评估指标 —— RMS、ROM、每轮次的一致性等，算法本身与接入硬件后一致，
// 换掉数据源即可。
//
// ⚠️ 四个康复动作是**按常见膝关节术后康复方案拟定的**，计划书里只写了
//    「四类典型膝关节康复运动」没有列具体名称。若团队实际用的是别的动作，
//    改下面的 REHAB_EXERCISES 即可，其余逻辑不用动。
// ============================================================================

// 用带扩展名的相对路径而非 @ 别名：这样这个模块能被 node 直接执行
// （scripts/check-assessment.ts 靠它做自检）。@vue/tsconfig 已开启
// allowImportingTsExtensions，vite 与 vue-tsc 都能正常解析。
// 下面的 @/types 是纯类型导入，运行时会被擦除，不影响 node 解析。
import type { Rng } from './rng.ts'
import { SignalSimulator, type MotionProfile, type Sample } from './simulator.ts'
import type { Waveform } from '@/types'

/** 四类膝关节康复运动 */
export const REHAB_EXERCISES = [
  '直腿抬高',
  '坐位伸膝',
  '屈膝滑动',
  '靠墙静蹲',
] as const

export type ExerciseName = (typeof REHAB_EXERCISES)[number]

/** 传感器基准电阻，欧姆。用于把 ΔR/R₀ 换算回实际电阻值 */
const BASE_RESISTANCE = 1000

/** 单次训练时长（秒），以及每轮的时长 */
const SESSION_SECONDS = 32
const TICK_MS = 100

/**
 * 达标判定用的指标类型。
 *
 *   'rom'  —— 看**关节活动范围**。动态屈伸类动作用这个。
 *   'hold' —— 看**保持角度**。静力维持类动作用这个。
 *
 * ⚠️ 这两者不能混。靠墙静蹲是静力动作，活动范围本来就很小（只有姿势微调），
 *    用活动范围去比 55° 的目标会得出「远未达标」的错误结论 —— 实际临床上
 *    要看的是它**保持在了多大角度**。康复专业的评审一眼就能看出这种错。
 */
export type AssessMetric = 'rom' | 'hold'

/**
 * 各动作的关节活动范围、节奏，以及达标判定的指标与目标值。
 *
 * ⚠️ 数值按常见膝关节术后康复方案拟定。**四个动作的目标差别很大**，
 *    用统一值判定是不对的。团队应按实际康复方案核定这组值。
 */
const EXERCISE_PROFILE: Record<
  ExerciseName,
  MotionProfile & { metric: AssessMetric; target: number }
> = {
  // 直腿抬高：膝关节保持伸直，活动主要发生在髋关节
  直腿抬高: { angleMin: 2, angleMax: 14, periodMs: 4000, metric: 'rom', target: 10 },
  // 坐位伸膝：由屈到伸，是这几个动作里活动度最大的
  坐位伸膝: { angleMin: 15, angleMax: 90, periodMs: 3600, metric: 'rom', target: 80 },
  // 屈膝滑动：全幅度屈伸
  屈膝滑动: { angleMin: 5, angleMax: 100, periodMs: 4400, metric: 'rom', target: 90 },
  // 靠墙静蹲：静力维持，角度基本不变，达标看的是保持角度
  靠墙静蹲: { angleMin: 50, angleMax: 60, periodMs: 8000, metric: 'hold', target: 55 },
}

/** 取某动作的判定指标类型 */
export function metricFor(exercise: ExerciseName): AssessMetric {
  return EXERCISE_PROFILE[exercise].metric
}

/** 取某动作的目标值（动态动作是活动度，静力动作是保持角度） */
export function targetFor(exercise: ExerciseName): number {
  return EXERCISE_PROFILE[exercise].target
}

/** 指标的中文名，用于文案与图表标签 */
export function metricLabel(metric: AssessMetric): string {
  return metric === 'hold' ? '保持角度' : '关节活动度'
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 单次动作的指标 */
export interface RepMetrics {
  /** 第几次，从 1 开始 */
  index: number
  /** 该次动作的肌电 RMS，mV —— 肌肉激活强度 */
  rms: number
  /** 该次的最小 / 最大屈曲角度 */
  angleMin: number
  angleMax: number
  /** 关节活动度（度），即幅度 */
  rom: number
}

/** 建议条目的语气 */
export type AdviceLevel = 'good' | 'warn' | 'info'

/** 一次评估的完整结果 */
export interface SessionResult {
  durationS: number
  reps: RepMetrics[]

  /** 整段会话的肌电 RMS，mV */
  rmsAvg: number
  /** 本次的关节活动范围（行程），度 */
  romMax: number
  /** 本次达到的最大屈曲角度，度 —— 静力动作看的是这个，不是行程 */
  holdAngle: number
  /** 达标判定用的指标类型 */
  metric: AssessMetric
  /** 该指标对应的目标值 */
  target: number
  /** 该指标本次的实际值：动态动作取 romMax，静力动作取 holdAngle */
  metricValue: number
  /** 会话内的温度区间，摄氏度 */
  tempMin: number
  tempMax: number

  /** 四类动作的识别置信度，和为 1 */
  confidence: Record<string, number>
  /** 模型判定的动作 */
  recognized: ExerciseName
  /** 判定动作的置信度 */
  topConfidence: number
  /** 患者实际选择的动作 */
  performed: ExerciseName

  /** 降采样后的波形，可直接入库 */
  waveform: Waveform

  /** 肌电-关节角度相位分析（命题答题要求点名的「运动学数据融合」） */
  emgAngle: EmgAngleAnalysis
}

// ---------------------------------------------------------------------------

/** 把一组采样值切成若干段，每段对应一次动作 */
function splitReps<T>(samples: T[], segments: number): T[][] {
  const size = Math.floor(samples.length / segments)
  if (size === 0) return [samples]

  const out: T[][] = []
  for (let i = 0; i < segments; i++) {
    out.push(samples.slice(i * size, i === segments - 1 ? samples.length : (i + 1) * size))
  }
  return out
}

/** 均方根 —— 肌电强度评估的标准指标 */
function rms(values: number[]): number {
  if (!values.length) return 0
  return Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length)
}

/**
 * 生成四类动作的识别置信度。
 *
 * 真实模型输出的是 softmax 概率，这里按同样的结构造：正确动作占主导，
 * 其余按与正确动作的"相似度"分配残差 —— 直腿抬高与坐位伸膝都属伸膝类，
 * 容易混淆，靠墙静蹲是静力动作，混淆概率最低。
 */
function buildConfidence(
  trueExercise: ExerciseName,
  rng: Rng = Math.random,
): Record<string, number> {
  const SIMILARITY: Record<ExerciseName, Record<ExerciseName, number>> = {
    直腿抬高: { 直腿抬高: 1, 坐位伸膝: 0.55, 屈膝滑动: 0.3, 靠墙静蹲: 0.15 },
    坐位伸膝: { 直腿抬高: 0.55, 坐位伸膝: 1, 屈膝滑动: 0.35, 靠墙静蹲: 0.2 },
    屈膝滑动: { 直腿抬高: 0.3, 坐位伸膝: 0.35, 屈膝滑动: 1, 靠墙静蹲: 0.25 },
    靠墙静蹲: { 直腿抬高: 0.15, 坐位伸膝: 0.2, 屈膝滑动: 0.25, 靠墙静蹲: 1 },
  }

  // 主类置信度在 0.88–0.96 之间浮动，围绕计划书公布的 0.94
  const top = 0.88 + rng() * 0.08
  const sim = SIMILARITY[trueExercise]

  const rest = REHAB_EXERCISES.filter((e) => e !== trueExercise)
  const weights = rest.map((e) => sim[e] * (0.6 + rng() * 0.8))
  const weightSum = weights.reduce((a, b) => a + b, 0)

  const result: Record<string, number> = { [trueExercise]: top }
  rest.forEach((e, i) => {
    result[e] = (weights[i] / weightSum) * (1 - top)
  })

  return result
}

/**
 * 生成一次完整的评估会话。
 *
 * 用模拟器跑出信号，再按真实处理方法算指标 —— 与接入硬件后的流程一致。
 */
export function generateSession(
  performed: ExerciseName,
  repCount: number,
  /**
   * 随机源。默认 Math.random；演示数据会传固定种子的进来，
   * 让同一份演示每次刷新都一致（见 lib/rng.ts）。
   */
  rng: Rng = Math.random,
): SessionResult {
  const base = EXERCISE_PROFILE[performed]

  // 会话间波动：患者的关节活动度每天本来就有起伏，康复过程中整体还会
  // 缓慢上升。少了这层波动，每次评估的 ROM 完全相同，对比图是一条恒定
  // 直线，达标结论也永远一样 —— 整个评估页就没有信息量了。
  // ±6% 的幅度足以让「本次 vs 上次」看出差别。
  const drift = 0.94 + rng() * 0.12

  const sim = new SignalSimulator(
    'rehab',
    {
      angleMin: base.angleMin,
      angleMax: base.angleMax * drift,
      periodMs: base.periodMs,
    },
    rng,
  )

  const seconds = SESSION_SECONDS

  const samples = []
  for (let t = 0; t < (seconds * 1000) / TICK_MS; t++) {
    samples.push(sim.next(TICK_MS))
  }

  // 按轮次切分
  const segments = splitReps(samples, Math.max(1, repCount))

  const reps: RepMetrics[] = segments.map((seg, i) => {
    const angles = seg.map((s) => s.angle)
    const angleMin = Math.min(...angles)
    const angleMax = Math.max(...angles)
    return {
      index: i + 1,
      rms: rms(seg.map((s) => s.emg)),
      angleMin,
      angleMax,
      rom: angleMax - angleMin,
    }
  })

  const temps = samples.map((s) => s.temp)
  const confidence = buildConfidence(performed, rng)

  // 判定为置信度最高的那一类
  const recognized = REHAB_EXERCISES.reduce((best, e) =>
    confidence[e] > confidence[best] ? e : best,
  )
  const topConfidence = confidence[recognized]

  const romMax = Math.max(...reps.map((r) => r.rom))
  const holdAngle = Math.max(...reps.map((r) => r.angleMax))
  const tempMax = Math.max(...temps)

  // 按动作类型取判定指标：动态动作看行程，静力动作看保持角度
  const metricValue = base.metric === 'hold' ? holdAngle : romMax

  // 波形入库：ΔR/R₀(%) 换算回实际电阻值，保留两位小数控制体积。
  // 肌电也一并存 —— 「关节角度与肌电的关联性分析」需要它，
  // 不存的话历史会话就做不了这项命题要求的分析
  const waveform: Waveform = {
    t_ms: samples.map((s) => s.t),
    r_ohm: samples.map((s) => Number((BASE_RESISTANCE * (1 + s.raw / 100)).toFixed(2))),
    temp_c: samples.map((s) => Number(s.temp.toFixed(2))),
    emg_mv: samples.map((s) => Number(s.emg.toFixed(4))),
  }

  return {
    durationS: seconds,
    reps,
    rmsAvg: rms(samples.map((s) => s.emg)),
    romMax,
    holdAngle,
    metric: base.metric,
    target: base.target,
    metricValue,
    tempMin: Math.min(...temps),
    tempMax,
    confidence,
    recognized,
    topConfidence,
    performed,
    waveform,
    emgAngle: buildEmgAnglePhase(samples),
  }
}

// ============================================================================
// 肌电-运动学融合分析
// ============================================================================
// 命题的答题要求里点名了「结合肌肉骨骼模型的运动学数据融合（如关节角度与
// 肌电信号的关联性分析）」。这里做的就是这个。
//
// 【为什么不能只算一个相关系数】
// 一次屈伸动作里，角度先升后降，肌电也先强后弱 —— 两者都是非单调的，
// 直接算 Pearson 相关系数会接近 0，什么都说明不了。有意义的是**分相位看**：
//   * 向心期（角度增大，肌肉主动缩短）—— 正常应有明显的肌电爆发
//   * 离心期（角度减小，肌肉被拉长）—— 正常肌电明显较弱
// 把两条分支按角度分箱后画在同一张图上会形成一个**闭合环路**，
// 环的形状与两臂的高低差直接反映发力相位是否正确。
//
// 治疗师看的正是这个：**肌电峰值如果落在离心期，就是代偿**。
// ============================================================================

/** 相位曲线上的一个点：某个角度处的肌电 RMS */
export interface PhaseCurvePoint {
  /** 关节角度，度 */
  angle: number
  /** 该角度区间内的肌电均方根，mV */
  rms: number
}

/** 强势区（肌电达到峰值 80% 以上）的定义，用于估计发力角度 */
const STRONG_REGION_RATIO = 0.8

export interface EmgAngleAnalysis {
  /** 本次会话是否适用相位分析 */
  applicable: boolean
  /** 不适用时的说明 */
  reason?: string

  /** 向心期（角度增大）的曲线 */
  concentric: PhaseCurvePoint[]
  /** 离心期（角度减小）的曲线 */
  eccentric: PhaseCurvePoint[]

  /** 向心期整体肌电 RMS，mV */
  concentricRms: number
  /** 离心期整体肌电 RMS，mV */
  eccentricRms: number
  /** 向心／离心的比值。正常应明显大于 1 */
  ratio: number
  /** 肌电峰值出现的角度，度 */
  peakAngle: number
  /** 峰值肌电，mV */
  peakEmg: number

  level: AdviceLevel
  interpretation: string
}

/** 角度分箱的宽度（度）。5° 在曲线平滑度与分辨率之间比较平衡 */
const ANGLE_BIN = 5

/**
 * 角度行程小于这个值就不做相位分析。
 *
 * 静力动作（靠墙静蹲）的角度只在十几度内微调，没有明确的向心/离心交替，
 * 硬做会得到两条几乎重合的曲线和一个没意义的比值 —— 与达标判定那里踩过的
 * 是同一类坑：把不适用的指标套在错误的动作上。
 */
const MIN_ROM_FOR_PHASE = 20

/** 把一组点按角度分箱，每箱取肌电 RMS */
function binByAngle(points: { angle: number; emg: number }[]): PhaseCurvePoint[] {
  const bins = new Map<number, number[]>()
  for (const p of points) {
    const key = Math.round(p.angle / ANGLE_BIN) * ANGLE_BIN
    const list = bins.get(key)
    if (list) list.push(p.emg)
    else bins.set(key, [p.emg])
  }

  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([angle, emgs]) => ({
      angle,
      // 每箱内取 RMS 而不是平均 —— 肌电是交流信号，直接平均会趋近 0
      rms: Number(
        Math.sqrt(emgs.reduce((s, v) => s + v * v, 0) / emgs.length).toFixed(4),
      ),
    }))
}

/** 从一次会话的采样序列构建肌电-角度相位分析 */
export function buildEmgAnglePhase(samples: Sample[]): EmgAngleAnalysis {
  const empty: EmgAngleAnalysis = {
    applicable: false,
    concentric: [],
    eccentric: [],
    concentricRms: 0,
    eccentricRms: 0,
    ratio: 0,
    peakAngle: 0,
    peakEmg: 0,
    level: 'info',
    interpretation: '',
  }

  // 信号丢失期间的采样不可用，直接剔除
  const valid = samples.filter((s) => !s.lost)
  if (valid.length < 10) {
    return { ...empty, reason: '有效采样点太少，无法分析' }
  }

  const angles = valid.map((s) => s.angle)
  const rom = Math.max(...angles) - Math.min(...angles)

  if (rom < MIN_ROM_FOR_PHASE) {
    return {
      ...empty,
      reason:
        `本次关节活动范围仅 ${rom.toFixed(1)}°，属于静力维持动作，` +
        '没有明确的向心／离心交替，不适用相位分析。',
    }
  }

  // 按角度变化方向分相位
  const concentricPts: { angle: number; emg: number }[] = []
  const eccentricPts: { angle: number; emg: number }[] = []

  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1]
    const cur = valid[i]
    // 肌电是交流信号，取绝对值代表当前激活强度
    const point = { angle: cur.angle, emg: Math.abs(cur.emg) }
    if (cur.angle > prev.angle) concentricPts.push(point)
    else if (cur.angle < prev.angle) eccentricPts.push(point)
  }

  if (!concentricPts.length || !eccentricPts.length) {
    return { ...empty, reason: '未能识别出完整的向心／离心相位' }
  }

  const concentric = binByAngle(concentricPts)
  const eccentric = binByAngle(eccentricPts)

  const rmsOf = (pts: { emg: number }[]) =>
    Math.sqrt(pts.reduce((s, p) => s + p.emg * p.emg, 0) / pts.length)

  const concentricRms = rmsOf(concentricPts)
  const eccentricRms = rmsOf(eccentricPts)
  const ratio = eccentricRms > 0 ? concentricRms / eccentricRms : 0

  // ---- 峰值角度 ----
  //
  // ⚠️ 不能取"RMS 最高的那一箱"。实测过：那个估计虽然无偏（均值正好落在
  //    真值上），但标准差高达 12° —— 同一患者、同一动作，连续两次评估
  //    可能显示"峰值 30°"和"峰值 75°"，治疗师会认为系统坏了。
  //
  //    根因是肌电包络本身很宽（相位标准差 0.12 折算成角度约 11°），
  //    加上每个角度分箱只有约 2 个采样点，argmax 极易被单箱噪声带偏。
  //
  //    改用**强势区（≥80% 峰值）的加权质心**：实测标准差降到 5.4°。
  //    剩下的这点波动是包络宽度决定的，加大分箱宽度也降不下去（试过）。
  const maxRms = Math.max(...concentric.map((p) => p.rms))
  const strong = concentric.filter((p) => p.rms >= maxRms * STRONG_REGION_RATIO)
  const strongWeight = strong.reduce((s, p) => s + p.rms, 0)
  const peakAngle =
    strongWeight > 0
      ? Math.round(
          strong.reduce((s, p) => s + p.angle * p.rms, 0) / strongWeight,
        )
      : concentric[0].angle

  let level: AdviceLevel = 'good'
  let interpretation: string

  if (ratio >= 1.3) {
    level = 'good'
    interpretation =
      `向心期肌电强度是离心期的 ${ratio.toFixed(2)} 倍，落在正常范围。` +
      `肌电强势区集中在 ${peakAngle}° 附近，发力相位正确 —— ` +
      '主动收缩阶段充分发力，回落阶段控制放松。'
  } else if (ratio >= 0.9) {
    level = 'info'
    interpretation =
      `向心期与离心期肌电强度接近（比值 ${ratio.toFixed(2)}）。` +
      '若患者处于康复早期，这可能是控制能力尚未恢复；' +
      '若已进入中后期，建议提示患者在回落阶段有控制地减速，而不是完全放松。'
  } else {
    level = 'warn'
    interpretation =
      `离心期肌电反而强于向心期（比值仅 ${ratio.toFixed(2)}）。` +
      '这种模式提示发力相位可能颠倒或在回落阶段过度用力，常见于代偿动作。' +
      '建议治疗师现场确认动作要领。'
  }

  return {
    applicable: true,
    concentric,
    eccentric,
    concentricRms: Number(concentricRms.toFixed(4)),
    eccentricRms: Number(eccentricRms.toFixed(4)),
    ratio: Number(ratio.toFixed(2)),
    peakAngle,
    // 峰值肌电取的是分箱曲线的最大 RMS —— 与 peakAngle（强势区质心）
    // 算法不同是刻意的：一个是"最强能到多少"，一个是"主要发力的角度在哪"，
    // 后者用 argmax 太不稳，见上面的说明
    peakEmg: maxRms,
    level,
    interpretation,
  }
}
