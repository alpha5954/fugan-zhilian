<script setup lang="ts">
// ============================================================================
// 实时监测
// ============================================================================
// 四路信号：sEMG、关节角度、温度、应变-温度解耦。
// 数据来自模拟器（硬件尚未接入），界面全程标注「模拟数据」，不伪装成实测。
// ============================================================================
import { computed, onMounted } from 'vue'

import SignalChart from '@/components/SignalChart.vue'
import type { ChartAxis, ChartSeries } from '@/components/SignalChart.vue'
import { useMonitor } from '@/composables/useMonitor'
import type { MonitorScenario } from '@/lib/simulator'
import { useDeviceStore } from '@/stores/device'

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
} = monitor

const canExport = computed(() => monitor.samples.value.length > 0)

/** 场景选择器的双向绑定。用 computed 的 get/set 包一层，
 *  直接把 setScenario 接上，免得在模板里写事件类型断言 */
const scenarioModel = computed({
  get: () => scenario.value,
  set: (next: MonitorScenario) => setScenario(next),
})

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
  { name: 'sEMG', data: emgSeries.value, color: '#409eff', width: 1 },
])

const angleChart = computed<ChartSeries[]>(() => [
  { name: '关节角度', data: angleSeries.value, color: '#67c23a', area: true, smooth: true },
])

const tempChart = computed<ChartSeries[]>(() => [
  { name: '局部温度', data: tempSeries.value, color: '#f56c6c', width: 1.6, smooth: true },
])

const decoupleChart = computed<ChartSeries[]>(() => [
  { name: '原始信号', data: rawSeries.value, color: '#909399', width: 1.1 },
  { name: '应变分量', data: strainSeries.value, color: '#409eff', width: 1.6 },
  {
    name: '温度分量',
    data: tempPartSeries.value,
    color: '#e6a23c',
    width: 1.6,
    yAxisIndex: 1,
  },
])

const tempMarkLines = computed(() => [
  { value: tempThreshold, label: `预警 ${tempThreshold} °C`, color: '#f56c6c' },
])

/** 解耦图每个序列都带图例色块，其余图只有一条线不需要 */
const decoupleLegend = [
  { name: '原始信号', color: '#909399' },
  { name: '应变分量', color: '#409eff' },
  { name: '温度分量', color: '#e6a23c' },
]

</script>

<template>
  <div class="monitor">
    <!-- 设备状态栏 -->
    <section class="statusbar">
      <div class="statusbar__group">
        <span
          class="statusbar__dot"
          :class="{ 'is-live': running, 'is-idle': !running }"
        />
        <span class="statusbar__value">{{ running ? '采集中' : '已暂停' }}</span>
        <el-tag size="small" type="warning" effect="plain">模拟数据</el-tag>
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
          :class="{ 'is-alert': overThreshold }"
        >
          {{ latest ? latest.temp.toFixed(2) : '—' }} °C
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
        <el-button @click="calibrate">校准</el-button>
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
  border: 1px solid #e4e7ed;
  border-radius: 10px;
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
  background: #67c23a;
  box-shadow: 0 0 0 3px rgb(103 194 58 / 18%);
}

.statusbar__dot.is-idle {
  background: #c0c4cc;
}

.statusbar__divider {
  width: 1px;
  height: 20px;
  background: #e4e7ed;
}

.statusbar__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.statusbar__label {
  font-size: 12px;
  color: #909399;
}

.statusbar__value {
  font-size: 13px;
  color: #303133;
}

.statusbar__value--mono {
  font-variant-numeric: tabular-nums;
}

.statusbar__value.is-alert {
  color: #f56c6c;
  font-weight: 600;
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
  color: #909399;
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
  border: 1px solid #e4e7ed;
  border-radius: 10px;
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
  color: #303133;
}

.panel__unit {
  font-size: 12px;
  color: #a8abb2;
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
  color: #909399;
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

/* ---------- 脚注 ---------- */
.footnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #a8abb2;
}
</style>
