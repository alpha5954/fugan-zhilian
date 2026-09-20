// ============================================================================
// 实时监测的数据流
// ============================================================================
// 管理模拟信号的采样循环、滚动窗口缓冲区、预警检测与导出。
// 图表只负责渲染，不掺和采样逻辑。
// ============================================================================

import { computed, onUnmounted, ref, shallowRef } from 'vue'

import { ElNotification } from 'element-plus'

import {
  createAlertState,
  evaluateSample,
  type AlertState,
} from '@/lib/alertRules'
import {
  SCENARIO_INFO,
  SignalSimulator,
  TEMP_ALERT_THRESHOLD,
  type MonitorScenario,
  type Sample,
} from '@/lib/simulator'
import { useAlertStore } from '@/stores/alert'
import { useUserStore } from '@/stores/user'
import type { AlertInsert, AlertKind, AlertSeverity } from '@/types'

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

/**
 * 温度预警的迟滞区间（摄氏度）。
 *
 * 没有迟滞的话，温度在阈值附近抖动会反复触发/解除预警 —— 用户被反复
 * 弹窗骚扰，数据库里也会堆一串几乎同时的告警。所以要等温度回落到
 * 阈值以下这么多度之后，才重新武装下一次预警。
 */
const TEMP_HYSTERESIS = 1

export function useMonitor() {
  const alertStore = useAlertStore()
  const user = useUserStore()

  const simulator = new SignalSimulator('rehab')

  const scenario = ref<MonitorScenario>('rehab')
  const running = ref(false)

  /**
   * 已运行时长，毫秒。
   *
   * 按**墙钟**累计而不是累加采样间隔 —— 后台节流期间采样间隔被截断到
   * 250ms，若用它计时，"已运行"会比真实时间慢几十倍，看起来像坏了。
   */
  const elapsed = ref(0)

  /** 当前是否处于信号丢失状态 */
  const signalLost = ref(false)
  /** 当前温度是否处于越阈告警状态 */
  const tempAlertOn = ref(false)

  // shallowRef 而非 ref：缓冲区里是几百个普通对象，用 ref 会被逐个包成
  // 响应式代理，每 100ms 重建一次的开销没必要。整体替换数组即可触发更新。
  const samples = shallowRef<Sample[]>([])

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTs = 0
  /** 本次运行开始的墙钟时间 */
  let startedAt = 0
  /** 之前几段运行累计的时长 */
  let accumulated = 0

  /** 预警检测的跨采样点状态。判据本身在 lib/alertRules.ts 里，可独立测试 */
  let alertState: AlertState = createAlertState()

  // -------------------------------------------------------------------------
  // 预警
  // -------------------------------------------------------------------------

  /**
   * 弹通知并落库。
   *
   * 落库失败不阻断界面 —— 通知已经弹出来了，用户该看到的看到了；
   * 写库失败只是历史里少一条记录，不该因此再弹一个错误框打扰用户。
   */
  function raiseAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    message: string,
    value: number | null,
    threshold: number | null = null,
  ) {
    ElNotification({
      title: severity === 'critical' ? '温度预警' : '设备提醒',
      message,
      type: severity === 'critical' ? 'error' : 'warning',
      duration: severity === 'critical' ? 0 : 5000, // 严重告警不自动消失
      position: 'bottom-right',
    })

    const patientId = user.userId
    if (!patientId) return

    const payload: AlertInsert = {
      patient_id: patientId,
      kind,
      severity,
      message,
      value,
      threshold,
      occurred_at: new Date().toISOString(),
    }
    void alertStore.create(payload)
  }

  /**
   * 每个采样点检查一次是否触发/解除预警。
   *
   * 判据本身在 lib/alertRules.ts —— 抽出去是为了能被 node 直接测，
   * 迟滞逻辑的边界靠肉眼审查看不出来。
   */
  function checkAlerts(s: Sample) {
    const events = evaluateSample(
      alertState,
      s,
      TEMP_ALERT_THRESHOLD,
      TEMP_HYSTERESIS,
    )

    for (const e of events) {
      if (e.kind === 'temp_high') {
        tempAlertOn.value = e.phase === 'enter'
        if (e.phase === 'enter') {
          raiseAlert(
            'temp_high',
            'critical',
            `局部温度达到 ${(e.value ?? 0).toFixed(1)} °C，已超过 ${TEMP_ALERT_THRESHOLD} °C 安全阈值。` +
              '长时间接触该温度可能造成低温烫伤，请立即调整或移开热源。',
            e.value === null ? null : Number(e.value.toFixed(2)),
            TEMP_ALERT_THRESHOLD,
          )
        }
        continue
      }

      // device_offline
      signalLost.value = e.phase === 'enter'
      if (e.phase === 'enter') {
        // 丢失开始不弹窗 —— 偶发的一次抖动就打断用户操作很烦，
        // 界面上的横幅和状态标签已经足够提示
        continue
      }
      // 恢复时才提示一次，让用户知道数据在哪一段断过
      ElNotification({
        title: '信号已恢复',
        message: '传感器重新建立连接，监测继续。断开期间的数据已在图表中留空。',
        type: 'success',
        duration: 3500,
        position: 'bottom-right',
      })
    }
  }

  // -------------------------------------------------------------------------
  // 采样循环
  // -------------------------------------------------------------------------
  function tick() {
    const now = performance.now()
    const dt = Math.min(now - lastTs, MAX_TICK_MS)
    lastTs = now

    elapsed.value = accumulated + (Date.now() - startedAt)

    const sample = simulator.next(dt)
    checkAlerts(sample)

    // 维持滚动窗口：超出容量就丢掉最旧的
    const buf = samples.value
    const next =
      buf.length >= BUFFER_SIZE
        ? buf.slice(buf.length - BUFFER_SIZE + 1)
        : buf.slice()
    next.push(sample)
    samples.value = next
  }

  /**
   * 页面从后台切回前台时重置时间基准。
   *
   * 后台期间 setInterval 被节流，切回来时第一个 tick 的 dt 可能是几十秒。
   * 虽然 tick 里已经做了截断，但那会让"有 250ms 的采样被推进"这种
   * 无意义的事发生。直接把基准重置为当前时刻，等价于把这段时间当作
   * 采样间隙，最干净。
   */
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      lastTs = performance.now()
    }
  }

  function start() {
    if (running.value) return
    running.value = true
    lastTs = performance.now()
    startedAt = Date.now()
    timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function pause() {
    if (!running.value) return
    running.value = false
    accumulated += Date.now() - startedAt
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
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
    accumulated = 0
    alertState = createAlertState()
    tempAlertOn.value = false
    signalLost.value = false
  }

  function setScenario(next: MonitorScenario) {
    scenario.value = next
    simulator.setScenario(next)
    // 场景切换后旧数据没有参考意义了，直接清空
    reset()
  }

  /** 校准：以当前温度为新的基线参考点 */
  function calibrate() {
    simulator.calibrate()
  }

  onUnmounted(pause)

  // -------------------------------------------------------------------------
  // 图表用的派生序列
  // -------------------------------------------------------------------------
  // 信号丢失期间的采样点一律输出 null —— 让折线断开，而不是把一段
  // 无意义的数值当成真实读数画出去。ECharts 的 connectNulls 已关。
  const timeAxis = computed(() => samples.value.map((s) => (s.t / 1000).toFixed(1)))
  const emgSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.emg.toFixed(4)))),
  )
  const angleSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.angle.toFixed(2)))),
  )
  const tempSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.temp.toFixed(3)))),
  )
  const rawSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.raw.toFixed(3)))),
  )
  const strainSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.strainPart.toFixed(3)))),
  )
  const tempPartSeries = computed(() =>
    samples.value.map((s) => (s.lost ? null : Number(s.tempPart.toFixed(3)))),
  )

  /**
   * 最近一个**有效**采样点，状态栏用。
   *
   * 从后往前找而不是直接取最后一个 —— 信号丢失期间最后一个样本是无效的，
   * 拿它去显示温度会跳一个假值。状态栏应当保持显示最后一次可信读数，
   * 同时由 signalLost 单独提示当前已失联。
   */
  const latest = computed(() => {
    const buf = samples.value
    for (let i = buf.length - 1; i >= 0; i--) {
      if (!buf[i].lost) return buf[i]
    }
    return null
  })

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
      '信号状态',
    ]

    const rows = samples.value.map((s) => [
      (s.t / 1000).toFixed(2),
      // 丢失期间的数值无意义，留空而不是写 0 —— 写 0 会被当成真实读数
      s.lost ? '' : s.emg.toFixed(4),
      s.lost ? '' : s.angle.toFixed(2),
      s.lost ? '' : s.temp.toFixed(3),
      s.lost ? '' : s.raw.toFixed(3),
      s.lost ? '' : s.strainPart.toFixed(3),
      s.lost ? '' : s.tempPart.toFixed(3),
      s.lost ? '信号丢失' : '正常',
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
    signalLost,
    tempAlertOn,

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
