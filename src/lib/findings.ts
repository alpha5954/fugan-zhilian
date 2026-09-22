// ============================================================================
// 评估结论
// ============================================================================
//
// 【这个模块是什么】
// 把技术指标变成**有名字的功能结论**。原来的「评估建议」已经在做类似的事，
// 但它把依据和建议揉在一句话里、用的是另一套语气分级、而且覆盖的类型少。
//
// 这一层的输出结构刻意是三个独立字段：
//
//   label     结论。**家属能读** —— 一句话说清这次做得怎么样
//   evidence  依据。**医生能核** —— 具体到数值，一行灰字
//   action    该做什么。给训练动作，不给治疗方案
//
// 「结论要简单，依据要完整」—— 和恢复评分是同一条原则。
//
// ============================================================================
// ⚠️ 合规边界（改文案之前先读这一段）
// ============================================================================
//
// 这个产品**不是医疗器械**，没有 NMPA 注册。所以结论的措辞有一条硬线：
//
//   ✗ 不能给疾病名称      「膝关节僵硬症」「股四头肌萎缩」
//   ✗ 不能说「诊断为…」
//   ✗ 不能给治疗方案     药物、剂量、手术指征
//   ✓ 可以描述测量结果    「活动度 62°，低于康复目标 90°」
//   ✓ 可以描述功能状态    「本次屈曲幅度不足」
//   ✓ 可以给训练建议      「在无痛范围内逐步增加幅度」
//   ✓ 可以报安全风险      「皮温接近阈值」
//
// **一条可操作的判据：结论的主语必须是「数据」或「训练」，不能是「患者」。**
//
//   ✗  你的膝关节僵硬了            ← 对患者下判断
//   ✓  本次膝关节屈曲活动度低于目标   ← 对测量结果下判断
//
// 另外界面上这一块的标题用「评估结论」而不是「诊断结果」——
// 名字本身就在划界。
//
// ============================================================================

import { metricLabel, type SessionResult } from './assessment.ts'
import { TEMP_ALERT_THRESHOLD } from './simulator.ts'
import type { RiskBand } from './insight.ts'
import type { RehabSession } from '@/types'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type FindingKey =
  | 'temp_high'
  | 'recognition_mismatch'
  | 'rom_short'
  | 'hold_short'
  | 'phase_late'
  | 'rom_unstable'
  | 'fatigue'
  | 'low_confidence'
  | 'progress_down'
  | 'rom_ok'
  | 'hold_ok'
  | 'fatigue_rising'
  | 'progress_up'
  | 'progress_flat'

export interface Finding {
  key: FindingKey
  /** 结论。白话，主语是"数据/训练"而不是"患者" */
  label: string
  /** 严重程度。与全局同一套红黄绿，不另立分级 */
  band: RiskBand
  /** 依据：具体数值。界面上一行灰字，医生核对用 */
  evidence: string
  /** 该做什么 */
  action: string
  /** 同级别内的排序，越小越先看 */
  priority: number
}

/** 认为基线够用的最少同动作历史条数 */
const MIN_HISTORY = 3

/** 变化超过这个幅度才算"有进步/退步"，否则算持平 */
const PROGRESS_THRESHOLD = 0.05

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** 变异系数：标准差 ÷ 均值 */
function cv(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  if (m <= 0) return 0
  const v = mean(xs.map((x) => (x - m) ** 2))
  return Math.sqrt(v) / m
}

/** 红黄绿的排序权重。红的最先看 */
const BAND_ORDER: Record<RiskBand, number> = { red: 0, yellow: 1, green: 2 }

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 产出本次训练的评估结论。
 *
 * @param result  本次会话的评估结果
 * @param history 该患者**此前**的训练记录（用于与历史对比）。
 *                传空数组时只是少几条结论，不会出错
 */
export function buildFindings(
  result: SessionResult,
  history: RehabSession[] = [],
): Finding[] {
  const out: Finding[] = []
  const label = metricLabel(result.metric)

  // -------------------------------------------------------------------------
  // 1. 达标判定
  // -------------------------------------------------------------------------
  // 指标按动作类型选：动态屈伸看活动范围，静力维持看保持角度。
  // 混用会得出错误结论 —— 靠墙静蹲的活动范围本就只有几度。
  if (result.metricValue >= result.target) {
    out.push({
      key: result.metric === 'hold' ? 'hold_ok' : 'rom_ok',
      label: `本次${label}达到康复目标`,
      band: 'green',
      evidence: `实测 ${result.metricValue.toFixed(1)}°，目标 ${result.target}°`,
      action: '维持当前训练方案即可',
      priority: 100,
    })
  } else {
    const gap = result.target - result.metricValue
    const shortfall = result.target > 0 ? gap / result.target : 0

    out.push({
      key: result.metric === 'hold' ? 'hold_short' : 'rom_short',
      label: `本次${label}未达康复目标`,
      // 差距小的算"需要注意"，差距大的算"需要处理" ——
      // 差 3° 和差 40° 不该是同一句话
      band: shortfall > 0.3 ? 'red' : 'yellow',
      evidence:
        `实测 ${result.metricValue.toFixed(1)}°，目标 ${result.target}°，` +
        `差 ${gap.toFixed(1)}°（完成 ${Math.round((1 - shortfall) * 100)}%）`,
      action:
        result.metric === 'hold'
          ? '在无痛前提下逐步延长保持时间、加深下蹲角度'
          : '在无痛范围内逐步增加活动幅度，避免强行牵拉',
      priority: shortfall > 0.3 ? 2 : 30,
    })
  }

  // -------------------------------------------------------------------------
  // 2. 发力时机（肌电-运动学融合给出的结论）
  // -------------------------------------------------------------------------
  // 这是命题点名要求的那项分析能给出的**唯一一条有动作含义的结论**。
  // 静力动作会被 buildEmgAnglePhase 判为不适用，这里自然跳过。
  const phase = result.emgAngle
  if (phase.applicable && phase.ratio < 0.9) {
    out.push({
      key: 'phase_late',
      label: '肌电峰值落在离心期，发力时机偏晚',
      band: 'yellow',
      evidence:
        `向心期 ${phase.concentricRms.toFixed(4)} mV / ` +
        `离心期 ${phase.eccentricRms.toFixed(4)} mV，比值 ${phase.ratio.toFixed(2)}` +
        `（正常应明显大于 1）；肌电强势区在 ${phase.peakAngle}° 附近`,
      action: '注意在屈曲一开始就主动发力，而不是靠回落时被动带动',
      priority: 20,
    })
  }

  // -------------------------------------------------------------------------
  // 3. 各轮次幅度是否稳定
  // -------------------------------------------------------------------------
  const roms = result.reps.map((r) => r.rom).filter((x) => Number.isFinite(x))
  if (roms.length >= 4) {
    const c = cv(roms)
    if (c > 0.15) {
      out.push({
        key: 'rom_unstable',
        label: '各轮次动作幅度差异较大',
        band: 'yellow',
        evidence:
          `最大 ${Math.max(...roms).toFixed(1)}° / 最小 ${Math.min(...roms).toFixed(1)}°，` +
          `轮次间波动 ${(c * 100).toFixed(0)}%`,
        action: '放慢动作速度，每组之间休息一下再继续',
        priority: 40,
      })
    }
  }

  // -------------------------------------------------------------------------
  // 4. 疲劳趋势
  // -------------------------------------------------------------------------
  if (result.reps.length >= 4) {
    const half = Math.floor(result.reps.length / 2)
    const early = mean(result.reps.slice(0, half).map((r) => r.rms))
    const late = mean(result.reps.slice(half).map((r) => r.rms))
    const drop = early > 0 ? (early - late) / early : 0

    if (drop > 0.25) {
      out.push({
        key: 'fatigue',
        label: '后半程肌电强度明显下降，存在疲劳迹象',
        band: 'yellow',
        evidence: `后半程较前半程下降 ${(drop * 100).toFixed(0)}%`,
        action: '缩短单组次数，或延长组间休息，避免疲劳后动作变形',
        priority: 50,
      })
    } else if (drop < -0.2) {
      out.push({
        key: 'fatigue_rising',
        label: '后半程肌电强度高于前半程',
        band: 'green',
        evidence: `后半程较前半程上升 ${(-drop * 100).toFixed(0)}%`,
        action: '可能是随熟练度提升发力更充分；若伴随动作变形则需降低强度',
        priority: 95,
      })
    }
  }

  // -------------------------------------------------------------------------
  // 5. 动作识别
  // -------------------------------------------------------------------------
  if (result.recognized !== result.performed) {
    out.push({
      key: 'recognition_mismatch',
      label: '识别出的动作与实际所选不一致',
      band: 'yellow',
      evidence:
        `判定为「${result.recognized}」，置信度 ${(result.topConfidence * 100).toFixed(1)}%；` +
        `实际所选「${result.performed}」`,
      action: '核对动作要领是否到位；也可以重新采集一次',
      priority: 10,
    })
  } else if (result.topConfidence < 0.7) {
    out.push({
      key: 'low_confidence',
      label: '动作识别置信度偏低',
      band: 'yellow',
      evidence: `本次判定置信度仅 ${(result.topConfidence * 100).toFixed(1)}%`,
      action: '确保电极贴合、动作完整；必要时降低训练强度重新采集',
      priority: 70,
    })
  }

  // -------------------------------------------------------------------------
  // 6. 温度
  // -------------------------------------------------------------------------
  if (result.tempMax >= TEMP_ALERT_THRESHOLD) {
    out.push({
      key: 'temp_high',
      label: '本次局部皮温超过安全阈值',
      band: 'red',
      evidence:
        `峰值 ${result.tempMax.toFixed(1)} °C，阈值 ${TEMP_ALERT_THRESHOLD} °C`,
      action: '缩短单次热敷时长；若正在热敷，先移开热源让皮肤恢复',
      priority: 1,
    })
  }

  // -------------------------------------------------------------------------
  // 7. 与个人历史对比
  // -------------------------------------------------------------------------
  // 只比**同一个动作**。直腿抬高的活动度只有 10° 上下、屈膝滑动接近 100°，
  // 跨动作平均出来的数不代表任何一个动作，也看不出趋势。
  out.push(...progressFinding(result, history))

  // 先按红黄绿，再按优先级
  return out.sort(
    (a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || a.priority - b.priority,
  )
}

/** 与同动作历史对比。历史不够时返回空数组，不编结论 */
function progressFinding(
  result: SessionResult,
  history: RehabSession[],
): Finding[] {
  // 静力动作看保持角度，动态动作看活动范围 —— 与达标判定同一套口径
  const field = result.metric === 'hold' ? 'hold_deg' : 'rom_deg'

  const past = history
    .filter((h) => h.exercise === result.performed)
    .map((h) => h[field])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

  // 样本不够就不给结论。用两三条记录算出来的"进步 30%"只会误导人
  if (past.length < MIN_HISTORY) return []

  const baseline = mean(past)
  if (baseline <= 0) return []

  const change = (result.metricValue - baseline) / baseline
  const pct = Math.abs(Math.round(change * 100))
  const n = past.length

  if (change > PROGRESS_THRESHOLD) {
    return [
      {
        key: 'progress_up',
        label: '较以往同动作有进步',
        band: 'green',
        evidence: `本次 ${result.metricValue.toFixed(1)}°，此前 ${n} 次平均 ${baseline.toFixed(1)}°，提升 ${pct}%`,
        action: '保持当前节奏',
        priority: 90,
      },
    ]
  }

  if (change < -PROGRESS_THRESHOLD) {
    return [
      {
        key: 'progress_down',
        label: '较以往同动作有所回落',
        band: 'yellow',
        evidence: `本次 ${result.metricValue.toFixed(1)}°，此前 ${n} 次平均 ${baseline.toFixed(1)}°，下降 ${pct}%`,
        // 不写"退步了" —— 单次波动很常见，说成退步会引起不必要的焦虑
        action: '先看是否与当天的状态、疼痛或疲劳有关；连续几次都低再联系治疗师',
        priority: 60,
      },
    ]
  }

  return [
    {
      key: 'progress_flat',
      label: '较以往同动作基本持平',
      band: 'green',
      evidence: `本次 ${result.metricValue.toFixed(1)}°，此前 ${n} 次平均 ${baseline.toFixed(1)}°`,
      action: '康复有平台期是正常的，按当前方案继续',
      priority: 110,
    },
  ]
}

/**
 * 只取最靠前的几条。
 *
 * 一次评估冒五条并列的结论，等于一条都没说 —— 用户会全部略过。
 * 默认给 3 条，其余由界面折起来。
 */
export function topFindings(findings: Finding[], n = 3): Finding[] {
  return findings.slice(0, Math.max(1, n))
}

/** 供界面判断"还有几条被折起来了" */
export { clamp01 }
