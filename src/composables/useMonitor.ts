// ============================================================================
// 实时监测的数据流
// ============================================================================
// 管理模拟信号的采样循环、滚动窗口缓冲区，以及导出。
// 图表本身只负责渲染，不掺和采样逻辑。
// ============================================================================

import { computed, onUnmounted, ref, shallowRef } from 'vue'

import {
  SCENARIO_INFO,
  SignalSimulator,
  TEMP_ALERT_THRESHOLD,
  type MonitorScenario,
  type Sample,
} from '@/lib/simulator'

/** 采样间隔，毫秒 */
const TICK_MS = 100

/** 滚动窗口保留的采样点数。200 × 100ms = 20 秒 */
const BUFFER_SIZE = 200

/**
 * 单次 tick 允许推进的最大时长，毫秒。
 *
 * 标签页切到后台时浏览器会把 setInterval 节流到每秒一次甚至更慢，
 * 切回来时两次 tick 之间的真实间隔可能是几十秒。不截断的话模拟器会
 * 瞬间"快进"一大段，图表上出现一段突兀的跳变。
 */
const MAX_TICK_MS = 250

export function useMonitor() {
  const simulator = new SignalSimulator('rehab')

  const scenario = ref<MonitorScenario>('rehab')
  const running = ref(false)
  /** 已运行时长，毫秒（累计的是采样推进的时间，不是墙上时钟） */
  const elapsed = ref(0)

  // shallowRef 而非 ref：缓冲区里是几百个普通对象，用 ref 会被逐个包成
  // 响应式代理，每 100ms 重建一次的开销没必要。整体替换数组即可触发更新。
  const samples = shallowRef<Sample[]>([])

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTs = 0

  // -------------------------------------------------------------------------
  // 采样循环
  // -------------------------------------------------------------------------
  function tick() {
    const now = performance.now()
    const dt = Math.min(now - lastTs, MAX_TICK_MS)
    lastTs = now

    elapsed.value += dt

    const sample = simulator.next(dt)

    // 维持滚动窗口：超出容量就丢掉最旧的
    const buf = samples.value
    const next =
      buf.length >= BUFFER_SIZE
        ? buf.slice(buf.length - BUFFER_SIZE + 1)
        : buf.slice()
    next.push(sample)
    samples.value = next
  }

  function start() {
    if (running.value) return
    running.value = true
    lastTs = performance.now()
    timer = setInterval(tick, TICK_MS)
  }

  function pause() {
    if (!running.value) return
    running.value = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function toggle() {
    running.value ? pause() : start()
  }

  /** 清空缓冲区并重置计时，保留当前场景 */
  function reset() {
    pause()
    simulator.reset()
    samples.value = []
    elapsed.value = 0
  }

  function setScenario(next: MonitorScenario) {
    scenario.value = next
    simulator.setScenario(next)
    // 场景切换后旧数据没有参考意义了，直接清空
    pause()
    samples.value = []
    elapsed.value = 0
  }

  /** 校准：以当前温度为新的基线参考点 */
  function calibrate() {
    simulator.calibrate()
  }

  onUnmounted(pause)

  // -------------------------------------------------------------------------
  // 图表用的派生序列
  // -------------------------------------------------------------------------
  const timeAxis = computed(() => samples.value.map((s) => (s.t / 1000).toFixed(1)))
  const emgSeries = computed(() => samples.value.map((s) => Number(s.emg.toFixed(4))))
  const angleSeries = computed(() => samples.value.map((s) => Number(s.angle.toFixed(2))))
  const tempSeries = computed(() => samples.value.map((s) => Number(s.temp.toFixed(3))))
  const rawSeries = computed(() => samples.value.map((s) => Number(s.raw.toFixed(3))))
  const strainSeries = computed(() => samples.value.map((s) => Number(s.strainPart.toFixed(3))))
  const tempPartSeries = computed(() => samples.value.map((s) => Number(s.tempPart.toFixed(3))))

  /** 最新一个采样点，状态栏用 */
  const latest = computed(() => samples.value[samples.value.length - 1] ?? null)

  /** 当前温度是否越过预警阈值 */
  const overThreshold = computed(
    () => (latest.value?.temp ?? 0) >= TEMP_ALERT_THRESHOLD,
  )

  /** 已运行时长，'mm:ss' */
  const elapsedText = computed(() => {
    const total = Math.floor(elapsed.value / 1000)
    const m = String(Math.floor(total / 60)).padStart(2, '0')
    const s = String(total % 60).padStart(2, '0')
    return `${m}:${s}`
  })

  // -------------------------------------------------------------------------
  // 导出 CSV
  // -------------------------------------------------------------------------
  function exportCsv() {
    if (!samples.value.length) return

    const header = [
      '时间(s)',
      'sEMG(mV)',
      '关节角度(deg)',
      '温度(C)',
      'DeltaR_R0(%)',
      '应变分量(%)',
      '温度分量(%)',
    ]

    const rows = samples.value.map((s) => [
      (s.t / 1000).toFixed(2),
      s.emg.toFixed(4),
      s.angle.toFixed(2),
      s.temp.toFixed(3),
      s.raw.toFixed(3),
      s.strainPart.toFixed(3),
      s.tempPart.toFixed(3),
    ])

    // 开头的 BOM 不能省：没有它 Excel 会把 UTF-8 的中文表头认成乱码
    const csv = '﻿' + [header, ...rows].map((r) => r.join(',')).join('\r\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = url
    a.download = `monitor-${scenario.value}-${stamp}.csv`
    a.click()

    // 必须释放，否则这个 Blob 会一直占着内存直到页面关闭
    URL.revokeObjectURL(url)
  }

  return {
    // 状态
    scenario,
    running,
    elapsed,
    elapsedText,
    samples,
    latest,
    overThreshold,
    tempThreshold: TEMP_ALERT_THRESHOLD,
    scenarioInfo: SCENARIO_INFO,

    // 图表序列
    timeAxis,
    emgSeries,
    angleSeries,
    tempSeries,
    rawSeries,
    strainSeries,
    tempPartSeries,

    // 操作
    start,
    pause,
    toggle,
    reset,
    calibrate,
    setScenario,
    exportCsv,
  }
}
