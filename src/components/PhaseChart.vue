<script lang="ts">
export interface PhasePoint {
  angle: number
  rms: number
}
</script>

<script setup lang="ts">
// ============================================================================
// 肌电-角度相位环路图
// ============================================================================
// 与 SignalChart / BarChart 的结构差别很大，所以单开一个组件而不是加参数：
//   * X 轴是**数值轴**（关节角度），不是类目轴 —— 现有的两个图表都是类目轴
//   * 有意义的形态是"环路"：向心期与离心期两条分支按角度对齐后形成闭合曲线，
//     两臂的高低差直接反映发力相位是否正确
//   * 点少（十几到几十个），需要显示数据点符号，不能像实时曲线那样隐藏
// ============================================================================
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
])

const props = withDefaults(
  defineProps<{
    /** 向心期（角度增大）曲线 */
    concentric: PhasePoint[]
    /** 离心期（角度减小）曲线 */
    eccentric: PhasePoint[]
    height?: number
    /** 标注肌电峰值位置 */
    peakAngle?: number
  }>(),
  { height: 240 },
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

const CONCENTRIC_COLOR = '#e6a23c'
const ECCENTRIC_COLOR = '#409eff'

function buildOption() {
  const series = [
    {
      type: 'line' as const,
      name: '向心期（角度增大）',
      color: CONCENTRIC_COLOR,
      data: props.concentric.map((p) => [p.angle, p.rms]),
    },
    {
      type: 'line' as const,
      name: '离心期（角度减小）',
      color: ECCENTRIC_COLOR,
      data: props.eccentric.map((p) => [p.angle, p.rms]),
    },
  ].map((s) => ({
    ...s,
    smooth: true,
    symbol: 'circle' as const,
    symbolSize: 4,
    lineStyle: { width: 2, color: s.color },
    itemStyle: { color: s.color },
  }))

  return {
    animation: true,
    animationDuration: 320,
    grid: { left: 8, right: 16, top: 28, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      textStyle: { fontSize: 12 },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(4) : String(v)),
    },
    legend: { show: false },
    xAxis: {
      type: 'value' as const,
      name: '关节角度 (°)',
      nameLocation: 'middle' as const,
      nameGap: 26,
      nameTextStyle: { color: '#909399', fontSize: 11 },
      min: 0,
      axisLine: { lineStyle: { color: '#e4e7ed' } },
      axisLabel: { color: '#a8abb2', fontSize: 10 },
      splitLine: { lineStyle: { color: '#f7f8fa' } },
    },
    yAxis: {
      type: 'value' as const,
      name: '肌电 RMS (mV)',
      nameTextStyle: { color: '#909399', fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#a8abb2', fontSize: 10 },
      splitLine: { lineStyle: { color: '#f2f3f5' } },
    },
    series: series.map((s, i) => ({
      ...s,
      // 只在第一条上挂峰值标线，避免画两遍
      markLine:
        i === 0 && props.peakAngle !== undefined
          ? {
              silent: true,
              symbol: 'none',
              animation: false,
              data: [
                {
                  xAxis: props.peakAngle,
                  lineStyle: { color: '#f56c6c', type: 'dashed' as const, width: 1 },
                  label: {
                    formatter: `峰值 ${props.peakAngle}°`,
                    color: '#f56c6c',
                    fontSize: 10,
                    position: 'insideEndTop' as const,
                  },
                },
              ],
            }
          : undefined,
    })),
  }
}

function render() {
  if (!chart) return
  chart.setOption(buildOption(), { lazyUpdate: true })
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, undefined, { renderer: 'canvas' })
  render()
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})

watch(() => [props.concentric, props.eccentric], render, { flush: 'post' })
</script>

<template>
  <div ref="el" class="phase-chart" :style="{ height: `${height}px` }" />
</template>

<style scoped>
.phase-chart {
  width: 100%;
}
</style>
