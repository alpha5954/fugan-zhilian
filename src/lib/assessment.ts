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
import { SignalSimulator, type MotionProfile } from './simulator.ts'
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

export interface Advice {
  level: AdviceLevel
  title: string
  detail: string
}

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

  advice: Advice[]
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
function buildConfidence(trueExercise: ExerciseName): Record<string, number> {
  const SIMILARITY: Record<ExerciseName, Record<ExerciseName, number>> = {
    直腿抬高: { 直腿抬高: 1, 坐位伸膝: 0.55, 屈膝滑动: 0.3, 靠墙静蹲: 0.15 },
    坐位伸膝: { 直腿抬高: 0.55, 坐位伸膝: 1, 屈膝滑动: 0.35, 靠墙静蹲: 0.2 },
    屈膝滑动: { 直腿抬高: 0.3, 坐位伸膝: 0.35, 屈膝滑动: 1, 靠墙静蹲: 0.25 },
    靠墙静蹲: { 直腿抬高: 0.15, 坐位伸膝: 0.2, 屈膝滑动: 0.25, 靠墙静蹲: 1 },
  }

  // 主类置信度在 0.88–0.96 之间浮动，围绕计划书公布的 0.94
  const top = 0.88 + Math.random() * 0.08
  const sim = SIMILARITY[trueExercise]

  const rest = REHAB_EXERCISES.filter((e) => e !== trueExercise)
  const weights = rest.map((e) => sim[e] * (0.6 + Math.random() * 0.8))
  const weightSum = weights.reduce((a, b) => a + b, 0)

  const result: Record<string, number> = { [trueExercise]: top }
  rest.forEach((e, i) => {
    result[e] = (weights[i] / weightSum) * (1 - top)
  })

  return result
}

/**
 * 按评估结果生成建议。
 *
 * ⚠️ 这是**基于规则的文本生成**，不是大模型输出。规则来自康复评定的常规
 *    判断逻辑（活动度是否达标、肌电是否随轮次衰减、识别置信度是否偏低）。
 *    对外展示时不要包装成"AI 诊断"，那既不准确也有合规风险。
 *    将来要接真实模型，替换这个函数即可，调用方不用改。
 */
function buildAdvice(
  performed: ExerciseName,
  topConfidence: number,
  metric: AssessMetric,
  metricValue: number,
  target: number,
  reps: RepMetrics[],
  tempMax: number,
): Advice[] {
  const out: Advice[] = []

  // ---- 动作规范性 ----
  if (topConfidence >= 0.9) {
    out.push({
      level: 'good',
      title: '动作识别置信度高',
      detail: `本次动作被判为「${performed}」的置信度为 ${(topConfidence * 100).toFixed(1)}%，动作特征清晰、完成度好。`,
    })
  } else if (topConfidence >= 0.8) {
    out.push({
      level: 'info',
      title: '动作特征基本清晰',
      detail: `置信度 ${(topConfidence * 100).toFixed(1)}%，略低于典型值。若患者感到动作别扭，可放慢节奏、加大动作幅度后重试。`,
    })
  } else {
    out.push({
      level: 'warn',
      title: '动作可能不够标准',
      detail: `置信度仅 ${(topConfidence * 100).toFixed(1)}%，模型难以明确归类。建议治疗师现场确认动作要领，或降低训练强度重新采集。`,
    })
  }

  // ---- 达标判定 ----
  // 指标按动作类型选：动态屈伸看活动范围，静力维持看保持角度。
  // 两者混用会得出错误结论 —— 靠墙静蹲的活动范围本就很小。
  const label = metricLabel(metric)

  if (metricValue >= target) {
    out.push({
      level: 'good',
      title: `${label}达到目标`,
      detail: `本次${label} ${metricValue.toFixed(1)}°，已达到「${performed}」${target}° 的康复目标。可维持当前训练方案。`,
    })
  } else {
    const gap = target - metricValue
    out.push({
      level: 'warn',
      title: `${label}未达目标`,
      detail:
        `本次${label} ${metricValue.toFixed(1)}°，距「${performed}」${target}° 的目标还差 ${gap.toFixed(1)}°。` +
        (metric === 'hold'
          ? '建议在无痛前提下逐步延长保持时间、加深下蹲角度。'
          : '建议在无痛范围内逐步增加活动幅度，避免强行牵拉。'),
    })
  }

  // ---- 疲劳趋势：看每轮的肌电 RMS 是否持续衰减 ----
  if (reps.length >= 4) {
    const firstHalf = reps.slice(0, Math.floor(reps.length / 2))
    const secondHalf = reps.slice(Math.floor(reps.length / 2))
    const avg = (xs: RepMetrics[]) => xs.reduce((a, r) => a + r.rms, 0) / xs.length

    const early = avg(firstHalf)
    const late = avg(secondHalf)
    const drop = early > 0 ? (early - late) / early : 0

    if (drop > 0.25) {
      out.push({
        level: 'warn',
        title: '存在肌肉疲劳迹象',
        detail: `后半程肌电强度较前半程下降 ${(drop * 100).toFixed(0)}%。建议缩短单组次数或组间增加休息，避免代偿动作。`,
      })
    } else if (drop < -0.2) {
      out.push({
        level: 'info',
        title: '肌电强度逐轮上升',
        detail: `后半程肌电强度较前半程上升 ${(-drop * 100).toFixed(0)}%，可能是随动作熟练度提升而发力更充分，也可能存在发力过猛。`,
      })
    } else {
      out.push({
        level: 'good',
        title: '各组发力稳定',
        detail: '前后半程肌电强度差异在正常范围内，未观察到明显疲劳或代偿。',
      })
    }
  }

  // ---- 温度 ----
  if (tempMax >= 45) {
    out.push({
      level: 'warn',
      title: '局部温度偏高',
      detail: `本次监测到局部皮温最高 ${tempMax.toFixed(1)}°C，已接近或超过 45°C。若同时在进行热敷，请缩短单次时长。`,
    })
  }

  return out
}

/**
 * 生成一次完整的评估会话。
 *
 * 用模拟器跑出信号，再按真实处理方法算指标 —— 与接入硬件后的流程一致。
 */
export function generateSession(
  performed: ExerciseName,
  repCount: number,
): SessionResult {
  const base = EXERCISE_PROFILE[performed]

  // 会话间波动：患者的关节活动度每天本来就有起伏，康复过程中整体还会
  // 缓慢上升。少了这层波动，每次评估的 ROM 完全相同，对比图是一条恒定
  // 直线，达标结论也永远一样 —— 整个评估页就没有信息量了。
  // ±6% 的幅度足以让「本次 vs 上次」看出差别。
  const drift = 0.94 + Math.random() * 0.12

  const sim = new SignalSimulator('rehab', {
    angleMin: base.angleMin,
    angleMax: base.angleMax * drift,
    periodMs: base.periodMs,
  })

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
  const confidence = buildConfidence(performed)

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

  // 波形入库：ΔR/R₀(%) 换算回实际电阻值，保留两位小数控制体积
  const waveform: Waveform = {
    t_ms: samples.map((s) => s.t),
    r_ohm: samples.map((s) => Number((BASE_RESISTANCE * (1 + s.raw / 100)).toFixed(2))),
    temp_c: samples.map((s) => Number(s.temp.toFixed(2))),
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
    advice: buildAdvice(
      performed,
      topConfidence,
      base.metric,
      metricValue,
      base.target,
      reps,
      tempMax,
    ),
  }
}
