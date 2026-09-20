// ============================================================================
// 实时监测的预警判据
// ============================================================================
// 抽成纯函数是为了能被 node 直接测（scripts/check-alerts.ts）。
// 迟滞逻辑有几个用眼睛看不出来的边界：温度在阈值上下抖动会不会反复
// 触发、回落后能不能重新武装、信号丢失期间的无效读数会不会被拿去
// 做温度判定。写错一处的结果分别是「弹窗刷屏」和「漏报」。
// ============================================================================

import type { Sample } from './simulator.ts'

/** 预警检测的跨采样点状态 */
export interface AlertState {
  /** 温度预警是否已武装（武装状态才能触发下一次） */
  tempArmed: boolean
  /** 信号丢失是否已武装 */
  dropArmed: boolean
  /** 当前温度是否处于越阈状态 */
  tempOver: boolean
  /** 当前是否处于信号丢失状态 */
  signalLost: boolean
  /** 本次丢失开始时的时刻（毫秒），用于统计丢失时长 */
  lostSince: number | null
}

export type AlertEventKind = 'temp_high' | 'device_offline'

export interface AlertEvent {
  kind: AlertEventKind
  /** 进入告警时的实测值；解除告警为 null */
  value: number | null
  /** enter = 触发告警，clear = 解除 */
  phase: 'enter' | 'clear'
}

export function createAlertState(): AlertState {
  return {
    tempArmed: true,
    dropArmed: true,
    tempOver: false,
    signalLost: false,
    lostSince: null,
  }
}

/**
 * 用一个新的采样点更新预警状态，返回本次产生的事件（通常为空）。
 *
 * @param threshold  温度阈值，达到即告警
 * @param hysteresis 迟滞区间。温度要回落到 threshold - hysteresis 以下
 *                   才重新武装，避免在阈值附近抖动时反复触发
 */
export function evaluateSample(
  state: AlertState,
  sample: Sample,
  threshold: number,
  hysteresis: number,
): AlertEvent[] {
  const events: AlertEvent[] = []

  // ---- 信号丢失 ----
  // 先判定丢失：丢失期间的读数不可信，下面不拿它做温度判定
  if (sample.lost) {
    if (state.dropArmed) {
      state.dropArmed = false
      state.signalLost = true
      state.lostSince = sample.t
      events.push({ kind: 'device_offline', value: null, phase: 'enter' })
    }
  } else if (!state.dropArmed) {
    state.dropArmed = true
    state.signalLost = false
    state.lostSince = null
    events.push({ kind: 'device_offline', value: null, phase: 'clear' })
  }

  // ---- 温度越阈 ----
  // ⚠️ 信号丢失期间**跳过**温度判定。此时 sample.temp 是模拟器内部状态的
  //    延续值，不代表真实读数；拿它去判告警会产生"设备都掉线了还在报温度"
  //    这种说不通的告警。
  if (!sample.lost) {
    if (state.tempArmed && sample.temp >= threshold) {
      state.tempArmed = false
      state.tempOver = true
      events.push({ kind: 'temp_high', value: sample.temp, phase: 'enter' })
    } else if (!state.tempArmed && sample.temp < threshold - hysteresis) {
      state.tempArmed = true
      state.tempOver = false
      events.push({ kind: 'temp_high', value: null, phase: 'clear' })
    }
  }

  return events
}
