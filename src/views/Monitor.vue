<script setup lang="ts">
// ============================================================================
// 实时监测
// ============================================================================
// 四路信号：sEMG、关节角度、温度、应变-温度解耦。
// 数据来自模拟器（硬件尚未接入），界面全程标注「模拟数据」，不伪装成实测。
// ============================================================================
import { computed, onMounted, ref } from 'vue'

import { ElMessage } from 'element-plus'

import FoldToggle from '@/components/FoldToggle.vue'
import RiskBadge from '@/components/RiskBadge.vue'
import SignalChart from '@/components/SignalChart.vue'
import type { ChartAxis, ChartSeries } from '@/components/SignalChart.vue'
import { useMonitor } from '@/composables/useMonitor'
import type { RiskBand } from '@/lib/insight'
import type { MonitorScenario } from '@/lib/simulator'
import { useDeviceStore } from '@/stores/device'
import { usePrefsStore } from '@/stores/prefs'
import { token } from '@/lib/theme'

const monitor = useMonitor()
const devices = useDeviceStore()
const prefs = usePrefsStore()

const {
  scenario,
  running,
  elapsedText,
  latest,
  overThreshold,
  tempThreshold,
  scenarioInfo,
  timeAxis,
  emgSeries,
  angleSeries,
  tempSeries,
  rawSeries,
  strainSeries,
  tempPartSeries,
  toggle,
  reset,
  calibrate,
  setScenario,
  exportCsv,
  signalLost,
  tempAlertOn,
} = monitor

const canExport = computed(() => monitor.samples.value.length > 0)

/** 场景选择器的双向绑定。用 computed 的 get/set 包一层，
 *  直接把 setScenario 接上，免得在模板里写事件类型断言 */
const scenarioModel = computed({
  get: () => scenario.value,
  set: (next: MonitorScenario) => setScenario(next),
})

/** 校准后给个反馈 —— 原先点了没有任何提示，用户不知道是否生效 */
function onCalibrate() {
  if (!latest.value) {
    ElMessage.warning('尚无有效读数，无法校准。请先开始采集并确认信号正常。')
    return
  }
  calibrate()
  ElMessage.success(
    `已按当前温度 ${latest.value.temp.toFixed(2)} °C 重置基线，温度分量以此为参考点计算`,
  )
}

// ---------------------------------------------------------------------------
// 设备状态栏
// ---------------------------------------------------------------------------
/** 已绑定的第一台设备，没有则为 null */
const boundDevice = computed(() => devices.devices[0] ?? null)

const connectionText = computed(() => {
  if (boundDevice.value) return `已连接 · ${boundDevice.value.serial_no}`
  return '模拟信号源'
})

onMounted(() => {
  // 顺带拉一下设备，状态栏能显示真实的序列号和电量
  if (!devices.loaded) void devices.fetchAll()
})

// ---------------------------------------------------------------------------
// 图表配置
// ---------------------------------------------------------------------------
const DECOUPLE_AXES: ChartAxis[] = [
  { name: 'ΔR/R₀ (%)', position: 'left' },
  { name: '温度分量 (%)', position: 'right' },
]

const emgChart = computed<ChartSeries[]>(() => [
  { name: 'sEMG', data: emgSeries.value, color: token('--brand-700'), width: 1 },
])

const angleChart = computed<ChartSeries[]>(() => [
  { name: '关节角度', data: angleSeries.value, color: token('--ok'), area: true, smooth: true },
])

const tempChart = computed<ChartSeries[]>(() => [
  { name: '局部温度', data: tempSeries.value, color: token('--danger'), width: 1.6, smooth: true },
])

const decoupleChart = computed<ChartSeries[]>(() => [
  { name: '原始信号', data: rawSeries.value, color: token('--ink-400'), width: 1.1 },
  { name: '应变分量', data: strainSeries.value, color: token('--brand-700'), width: 1.6 },
  {
    name: '温度分量',
    data: tempPartSeries.value,
    color: token('--warn'),
    width: 1.6,
    yAxisIndex: 1,
  },
])

const tempMarkLines = computed(() => [
  { value: tempThreshold, label: `预警 ${tempThreshold} °C`, color: token('--danger') },
])

/** 解耦图每个序列都带图例色块，其余图只有一条线不需要 */
const decoupleLegend = [
  { name: '原始信号', color: token('--ink-400') },
  { name: '应变分量', color: token('--brand-700') },
  { name: '温度分量', color: token('--warn') },
]

// ---------------------------------------------------------------------------
// 家属模式：当前状态
// ---------------------------------------------------------------------------
// 家属打开这一页想知道的不是"四路曲线长什么样"，而是：
// 设备连上了吗、温度安全吗、现在在做什么。
//
// 波形、采样率、电量、校准、导出 CSV 全部收进折叠区，专业模式才默认展开。
// ---------------------------------------------------------------------------

/** 家属模式下技术视图是否展开。默认收起 */
const waveOpen = ref(false)

/**
 * 距离阈值多近就该提前提醒（摄氏度）。
 *
 * 1.5 °C 是个折中：太近（比如 0.5）等于没有提前量，等提醒时已经出事了；
 * 太远（比如 3）会让热敷过程中一直在报警，家属很快就学会无视它。
 */
const TEMP_WARN_MARGIN = 1.5

/** 温度是否已进入"接近上限"的区间 */
const tempNearLimit = computed(
  () => latest.value !== null && latest.value.temp >= monitor.tempThreshold - TEMP_WARN_MARGIN,
)

/**
 * 整体状态。
 *
 * 信号中断和温度越阈都是**红**：前者意味着读数不可信，后者是真会造成
 * 低温烫伤的安全问题。接近上限是**黄**，还没出事但这个提前量正是
 * 家属模式存在的理由 —— 等到红的时候，热敷已经做完了。
 */
const band = computed<RiskBand>(() => {
  if (signalLost.value || tempAlertOn.value) return 'red'
  if (tempNearLimit.value) return 'yellow'
  return 'green'
})

interface StatusItem {
  label: string
  value: string
  /**
   * 风险灯。**可以没有** —— 只有真正带风险含义的项才配灯。
   *
   * 「采集时长 00:00」和「当前场景 康复训练」本来就不是风险项，
   * 给它们挂一个绿点会让人以为那是在评价"时长是否正常"。
   * 而「皮肤温度 —」挂绿点更糟：没有读数却显示"正常"。
   */
  band?: RiskBand
}

const statusItems = computed<StatusItem[]>(() => {
  const s = latest.value
  return [
    {
      label: '设备信号',
      // 没开始采集就说"未开始"，不配灯 —— 闲置不是异常
      value: signalLost.value ? '中断' : running.value ? '采集正常' : '未开始',
      band: signalLost.value ? 'red' : running.value ? 'green' : undefined,
    },
    {
      label: '皮肤温度',
      // 拿不到读数时不给灯。绿点配一个 "—" 等于在说"没数据=正常"
      value: s ? `${s.temp.toFixed(1)} °C` : '—',
      band: !s
        ? undefined
        : tempAlertOn.value
          ? 'red'
          : tempNearLimit.value
            ? 'yellow'
            : 'green',
    },
    {
      label: '当前场景',
      value: scenarioInfo[scenario.value].label,
    },
    {
      label: '采集时长',
      value: elapsedText.value,
    },
  ]
})

/** 一句话结论。要能直接回答"现在有没有事" */
const statusHeadline = computed(() => {
  if (signalLost.value)
    return '设备信号中断了，请检查电极片是否贴牢、设备是否有电'
  if (tempAlertOn.value) return '皮肤温度已超过预警线，请先停止热敷让皮肤休息'
  if (!running.value) return '还没有开始采集，点下面的按钮开始'
  if (tempNearLimit.value) return '皮肤温度接近上限，留意热敷时间不要过长'
  return '一切正常，可以继续'
})

/** 采集开始 / 暂停。家属模式只需要这一个控制 */
function onToggle() {
  toggle()
}
</script>

<template>
  <div class="monitor">
    <!-- 温度越阈是安全关键告警 —— 低温烫伤不可逆，必须醒目 -->
    <el-alert
      v-if="tempAlertOn"
      type="error"
      :closable="false"
      show-icon
      title="局部温度已超过安全阈值"
      :description="`当前 ${latest ? latest.temp.toFixed(1) : '—'} °C，阈值 ${tempThreshold} °C。` +
        '皮肤接触 44 °C 持续 6 小时、或接触 50 °C 仅需 5 分钟即可造成不可逆低温烫伤。请立即调整或移开热源。'"
    />

    <!-- 信号丢失：设备不可信，提醒但不打断 -->
    <el-alert
      v-if="signalLost"
      type="warning"
      :closable="false"
      show-icon
      title="信号中断"
      description="传感器当前无有效读数，图表已断开。请检查电极是否贴合、设备是否在连接范围内。"
    />

    <!-- ================= 家属模式：当前状态 =================
         家属打开这一页想知道的不是"四路曲线长什么样"，而是
         设备连上了吗、温度安全吗、现在在做什么。 -->
    <section v-if="!prefs.proMode" class="status" :class="`status--${band}`">
      <p class="status__headline">
        <RiskBadge :band="band" dot size="md" />
        <span>{{ statusHeadline }}</span>
      </p>

      <ul class="status__list">
        <li v-for="item in statusItems" :key="item.label" class="status__item">
          <span class="status__label">{{ item.label }}</span>
          <span class="status__value">
            <RiskBadge v-if="item.band" :band="item.band" dot size="sm" />
            {{ item.value }}
          </span>
        </li>
      </ul>

      <!-- 家属只需要这一个控制。校准、导出、清空都在下面的折叠区里 -->
      <el-button
        :type="running ? 'warning' : 'primary'"
        size="large"
        class="status__action"
        @click="onToggle"
      >
        {{ running ? '暂停采集' : '开始采集' }}
      </el-button>
    </section>

    <!-- 家属模式下技术视图折叠起来；专业模式直接展开 -->
    <FoldToggle
      v-if="!prefs.proMode"
      :open="waveOpen"
      label="查看原始波形与设备参数"
      @toggle="waveOpen = !waveOpen"
    />

    <!-- 折叠区。用 v-if 而不是 v-show：收着的时候四个 ECharts 实例
         没必要挂着（每个都带 ResizeObserver 和定时重绘）。
         下面这一段的缩进保持原样没有跟着加一级 —— 纯缩进改动会把
         这次的真实改动淹掉，Vue 也不关心缩进。 -->
    <template v-if="prefs.proMode || waveOpen">
    <!-- 设备状态栏 -->
    <section class="statusbar">
      <div class="statusbar__group">
        <span
          class="statusbar__dot"
          :class="{ 'is-live': running, 'is-idle': !running }"
        />
        <span class="statusbar__value">{{ running ? '采集中' : '已暂停' }}</span>
        <el-tag size="small" type="warning" effect="plain">模拟数据</el-tag>
        <el-tag v-if="signalLost" size="small" type="danger" effect="dark">
          信号丢失
        </el-tag>
        <el-tag v-if="tempAlertOn" size="small" type="danger" effect="dark">
          温度超标
        </el-tag>
      </div>

      <div class="statusbar__divider" />

      <div class="statusbar__item">
        <span class="statusbar__label">信号源</span>
        <span class="statusbar__value">{{ connectionText }}</span>
      </div>

      <div class="statusbar__item">
        <span class="statusbar__label">电量</span>
        <span class="statusbar__value">
          {{ boundDevice?.battery_pct != null ? `${boundDevice.battery_pct}%` : '—' }}
        </span>
      </div>

      <div class="statusbar__item">
        <span class="statusbar__label">采样率</span>
        <span class="statusbar__value">10 Hz</span>
      </div>

      <div class="statusbar__item">
        <span class="statusbar__label">已运行</span>
        <span class="statusbar__value statusbar__value--mono">{{ elapsedText }}</span>
      </div>

      <div class="statusbar__item">
        <span class="statusbar__label">皮肤温度</span>
        <span
          class="statusbar__value statusbar__value--mono"
          :class="{ 'is-alert': overThreshold, 'is-stale': signalLost }"
        >
          {{ latest ? latest.temp.toFixed(2) : '—' }} °C
          <span v-if="signalLost" class="statusbar__stale">（失联前）</span>
        </span>
      </div>
    </section>

    <!-- 控制面板 -->
    <section class="controls">
      <div class="controls__left">
        <el-radio-group v-model="scenarioModel" size="default">
          <el-radio-button
            v-for="(info, key) in scenarioInfo"
            :key="key"
            :value="key"
          >
            {{ info.label }}
          </el-radio-button>
        </el-radio-group>

        <span class="controls__hint">{{ scenarioInfo[scenario].detail }}</span>
      </div>

      <div class="controls__right">
        <el-button :type="running ? 'warning' : 'primary'" @click="toggle">
          {{ running ? '暂停' : '开始' }}
        </el-button>
        <el-button @click="onCalibrate">校准</el-button>
        <el-button :disabled="!canExport" @click="exportCsv">导出 CSV</el-button>
        <el-button :disabled="!canExport" @click="reset">清空</el-button>
      </div>
    </section>

    <!-- 2×2 图表网格 -->
    <section class="grid">
      <article class="panel">
        <header class="panel__head">
          <h3 class="panel__title">表面肌电 sEMG</h3>
          <span class="panel__unit">mV</span>
        </header>
        <SignalChart :series="emgChart" :x-data="timeAxis" :height="200" :digits="3" />
      </article>

      <article class="panel">
        <header class="panel__head">
          <h3 class="panel__title">关节角度</h3>
          <span class="panel__unit">°</span>
        </header>
        <SignalChart :series="angleChart" :x-data="timeAxis" :height="200" :digits="1" />
      </article>

      <article class="panel">
        <header class="panel__head">
          <h3 class="panel__title">局部温度</h3>
          <span class="panel__unit">°C</span>
        </header>
        <SignalChart
          :series="tempChart"
          :x-data="timeAxis"
          :y-axes="[{ name: '°C', position: 'left', min: 30, max: 52 }]"
          :mark-lines="tempMarkLines"
          :height="200"
          :digits="2"
        />
      </article>

      <article class="panel">
        <header class="panel__head">
          <h3 class="panel__title">应变-温度解耦</h3>
          <div class="panel__legend">
            <span v-for="l in decoupleLegend" :key="l.name" class="legend__item">
              <span class="legend__dot" :style="{ background: l.color }" />
              {{ l.name }}
            </span>
          </div>
        </header>
        <SignalChart
          :series="decoupleChart"
          :x-data="timeAxis"
          :y-axes="DECOUPLE_AXES"
          :height="200"
          :digits="1"
        />
      </article>
    </section>

    <!-- 技术说明也只在专业模式显示：家属不需要知道 GF 和 TCR 是什么 -->
    <p class="footnote">
      四路信号由内置模拟器按传感器实际参数生成（GF 5.68、TCR −1.04 %·°C⁻¹），
      原始信号 = 应变分量 + 温度分量 + 测量噪声。硬件接入后替换数据源即可，
      图表与解耦逻辑无需改动。
    </p>
    </template>

    <!-- 数据来源声明：两种模式都要有。
         README 里那条「不把模拟数据说成实测数据」是底线，
         家属模式把技术说明折起来了，但这句不能跟着藏 -->
    <p v-if="!prefs.proMode" class="footnote footnote--family">
      当前显示的是内置模拟器生成的数据，用于演示系统能力；接入传感器后
      会换成实测数据。
    </p>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ==========================================================================
   家属模式：当前状态卡
   ==========================================================================
   整页给家属看的主内容。左侧色条表达风险等级，与摘要页是同一套语言。
   ========================================================================== */
.status {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 5px solid var(--line-strong);
  border-radius: var(--r-md);
}

.status--green {
  border-left-color: var(--ok);
}

.status--yellow {
  border-left-color: var(--warn);
}

.status--red {
  border-left-color: var(--danger);
}

.status__headline {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-medium);
  line-height: var(--lh-base);
  color: var(--ink-800);
}

.status__list {
  display: grid;
  /* 窄屏自动折行。四项目标在手机上排成两列也读得清 */
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--sp-3) var(--sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.status__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.status__label {
  font-size: var(--fs-xs);
  color: var(--ink-400);
}

.status__value {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--ink-800);
}

/* 触控下限 44px */
.status__action {
  align-self: flex-start;
  min-width: 168px;
  min-height: 44px;
}

@media (max-width: 640px) {
  .status__action {
    align-self: stretch;
    width: 100%;
  }
}

/* ---------- 设备状态栏 ---------- */
.statusbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 20px;
  padding: 12px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.statusbar__group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.statusbar__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.statusbar__dot.is-live {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgb(103 194 58 / 18%);
}

.statusbar__dot.is-idle {
  background: var(--ink-200);
}

.statusbar__divider {
  width: 1px;
  height: 20px;
  background: var(--line);
}

.statusbar__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.statusbar__label {
  font-size: 12px;
  color: var(--ink-400);
}

.statusbar__value {
  font-size: 13px;
  color: var(--ink-800);
}

.statusbar__value--mono {
  font-variant-numeric: tabular-nums;
}

.statusbar__value.is-alert {
  color: var(--danger);
  font-weight: 600;
}

/* 信号丢失时显示的仍是最后一次可信读数，用弱化样式 + 括注说明，
   避免用户把它当成当前值 */
.statusbar__value.is-stale {
  color: var(--ink-300);
}

.statusbar__stale {
  font-size: 11px;
}

/* ---------- 控制面板 ---------- */
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.controls__left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.controls__hint {
  font-size: 12px;
  color: var(--ink-400);
}

.controls__right {
  display: flex;
  gap: 8px;
}

/* ---------- 图表网格 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px 8px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 22px;
}

.panel__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-800);
}

.panel__unit {
  font-size: 12px;
  color: var(--ink-300);
}

.panel__legend {
  display: flex;
  gap: 12px;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--ink-400);
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-xs);
}

/* ---------- 脚注 ---------- */
.footnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-300);
}
</style>
