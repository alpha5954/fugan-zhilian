<script lang="ts">
// 类型放在普通 <script> 块里才能被外部 import
export interface BarSeries {
  name: string
  data: number[]
  /** 单色，或逐柱配色 */
  color: string | string[]
  /** 是否在柱顶显示数值 */
  showValue?: boolean
}

export interface BarMarkLine {
  value: number
  label: string
  color: string
}
</script>

<script setup lang="ts">
// ============================================================================
// 柱状图
// ============================================================================
// 与 SignalChart 一样按需引入、同样处理容器尺寸变化。
// 单独一个组件而不是给 SignalChart 加 type 参数 —— 两者的配置差异
// （图例、标线、数值标签、类目轴方向）比共性多，合并反而更难读。
// ============================================================================
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { BarChart as EBarChart } from 'echarts/charts'
import {
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { token } from '@/lib/theme'

echarts.use([EBarChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer])

const props = withDefaults(
  defineProps<{
    series: BarSeries[]
    xData: string[]
    /** Y 轴名称 */
    yName?: string
    yMin?: number
    yMax?: number
    markLines?: BarMarkLine[]
    height?: number
    digits?: number
    /** 柱条圆角 */
    radius?: number
  }>(),
  {
    markLines: () => [],
    height: 220,
    digits: 2,
    radius: 4,
  },
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function buildOption() {
  return {
    animation: true,
    animationDuration: 320,
    grid: {
      left: 8,
      right: 12,
      top: props.markLines.length ? 26 : 16,
      bottom: 4,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      confine: true,
      textStyle: { fontSize: 12 },
      valueFormatter: (v: unknown) =>
        typeof v === 'number' ? v.toFixed(props.digits) : String(v),
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: props.xData,
      axisLine: { lineStyle: { color: token('--line') } },
      axisTick: { show: false },
      axisLabel: { color: token('--ink-400'), fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: props.yName,
      nameTextStyle: { color: token('--ink-300'), fontSize: 10 },
      min: props.yMin,
      max: props.yMax,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: token('--ink-300'), fontSize: 10 },
      splitLine: { lineStyle: { color: token('--line-soft') } },
    },
    series: props.series.map((s, si) => ({
      type: 'bar' as const,
      name: s.name,
      data: Array.isArray(s.color)
        ? s.data.map((v, i) => ({ value: v, itemStyle: { color: s.color[i as number] } }))
        : s.data,
      barMaxWidth: 34,
      itemStyle: {
        borderRadius: props.radius,
        color: Array.isArray(s.color) ? undefined : s.color,
      },
      label: s.showValue
        ? {
            show: true,
            position: 'top' as const,
            fontSize: 10,
            color: token('--ink-400'),
            formatter: (p: { value: number }) => p.value.toFixed(props.digits),
          }
        : { show: false },
      // 只有第一组柱挂标线，避免重复绘制
      markLine:
        si === 0 && props.markLines.length
          ? {
              silent: true,
              symbol: 'none',
              animation: false,
              data: props.markLines.map((m) => ({
                yAxis: m.value,
                lineStyle: { color: m.color, type: 'dashed' as const, width: 1 },
                label: {
                  formatter: m.label,
                  color: m.color,
                  fontSize: 10,
                  position: 'insideEndTop' as const,
                },
              })),
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

watch(() => [props.xData, ...props.series.map((s) => s.data)], render, { flush: 'post' })
</script>

<template>
  <div ref="el" class="bar-chart" :style="{ height: `${height}px` }" />
</template>

<style scoped>
.bar-chart {
  width: 100%;
}
</style>
