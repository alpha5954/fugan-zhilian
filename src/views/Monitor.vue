<script setup lang="ts">
// ============================================================================
// 实时监测
// ============================================================================
// 四路信号：sEMG、关节角度、温度、应变-温度解耦。
// 数据来自模拟器（硬件尚未接入），界面全程标注「模拟数据」，不伪装成实测。
// ============================================================================
import { computed, onMounted } from 'vue'

import { ElMessage } from 'element-plus'

import SignalChart from '@/components/SignalChart.vue'
import type { ChartAxis, ChartSeries } from '@/components/SignalChart.vue'
import { useMonitor } from '@/composables/useMonitor'
import type { MonitorScenario } from '@/lib/simulator'
import { useDeviceStore } from '@/stores/device'
import { token } from '@/lib/theme'

const monitor = useMonitor()
const devices = useDeviceStore()

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

/**
 * 危险区色带。
 *
 * 【为什么温度图的 Y 轴不能自适应】
 * 试过让范围贴合数据 —— 康复训练时皮温就在 33 上下，自适应之后曲线
 * 确实占满绘图区，好看得多。**但 45 °C 的预警线直接跑到了屏幕外。**
 *
 * 温度是**安全参数**：患者要看的不是"我的体温在 33.02 和 33.10 之间波动"，
 * 而是"我离烫伤还有多远"。为了好看把警戒线弄丢，方向反了。
 * 低温烫伤预警是这个产品的核心价值（见 README），这条不能妥协。
 *
 * 【空白怎么办】
 * 固定范围必然留大片空白。用这道色带把空白变成信息：
 * 曲线在色带**下方** = 安全，一眼就能判断，不需要读数字。
 */
const tempMarkAreas = computed(() => [
  {
    from: tempThreshold,
    to: 52,
    // 用品牌色令牌加透明度而不是写死颜色，改了主题这里跟着变。
    // 8% 的浓度足够看出是一块区域，又不会把曲线压下去
    color: `${token('--danger')}14`,
    label: '危险区',
    // 文字要用**实心**色，不能跟着色带走 —— 8% 透明度的字看不见
    labelColor: token('--danger'),
  },
])

/** 解耦图每个序列都带图例色块，其余图只有一条线不需要 */
const decoupleLegend = [
  { name: '原始信号', color: token('--ink-400') },
  { name: '应变分量', color: token('--brand-700') },
  { name: '温度分量', color: token('--warn') },
]

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
        <!-- 温度图的 Y 轴**必须固定范围**，不能像其他图那样自适应（见下方
             tempMarkAreas 的注释）。范围取 30–52：覆盖热敷监测 40→50 的
             全过程，并把 45 °C 的警戒线留在可见区内。 -->
        <SignalChart
          :series="tempChart"
          :x-data="timeAxis"
          :y-axes="[{ name: '°C', position: 'left', min: 30, max: 52 }]"
          :mark-lines="tempMarkLines"
          :mark-areas="tempMarkAreas"
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

    <p class="footnote">
      四路信号由内置模拟器按传感器实际参数生成（GF 5.68、TCR −1.04 %·°C⁻¹），
      原始信号 = 应变分量 + 温度分量 + 测量噪声。硬件接入后替换数据源即可，
      图表与解耦逻辑无需改动。
    </p>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  /* 呼吸光晕。用项目自己的绿（--ok = #1c6b47）而不是 Element Plus
     默认的 #67c23a —— 后者是消费级配色，和整套语义色不是一家的。
     这种"差一点"最伤整体感：单看没问题，和其他绿摆一起就露馅。 */
  box-shadow: 0 0 0 3px rgb(28 107 71 / 16%);
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

/* 数值部分（温度和运行时长）走等宽数字。
   全局已经开了 tabular-nums，这里再显式声明一次是为了让意图可见 ——
   状态栏每秒刷新十次，数字宽度不稳会整行抖动。 */
.statusbar__value--mono {
  font-variant-numeric: tabular-nums;
}

.statusbar__label {
  /* 标签退一档、加字距 —— 读起来像"刻度名"而不是正文。
     字号刻意用硬编码而不是令牌：状态栏是**仪表**，它的密度比正文
     更紧，跟着全局字号走反而会散。 */
  font-size: 11px;
  color: var(--ink-400);
  letter-spacing: 0.4px;
}

.statusbar__value {
  /* 值进一档并加粗一档。**标签与值的层级差是"仪表感"的来源** ——
     两者一样大时读起来是一句话；拉开之后眼睛会先抓到数字。 */
  font-size: 14px;
  font-weight: var(--fw-medium);
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
