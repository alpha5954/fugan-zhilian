<script lang="ts">
export interface PieDatum {
  name: string
  value: number
  color: string
}
</script>

<script setup lang="ts">
// ============================================================================
// 饼图（环形）
// ============================================================================
// 图例不用 ECharts 内置的，改由外层 HTML 渲染 —— 需要在图例里带上
// 次数和百分比，内置图例做不到，而且样式和其他图表对不齐。
// ============================================================================
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { PieChart as EPieChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { tooltipStyle } from '@/lib/chartTheme'
import { token } from '@/lib/theme'

echarts.use([EPieChart, TooltipComponent, CanvasRenderer])

const props = withDefaults(
  defineProps<{
    data: PieDatum[]
    height?: number
    /** 环的粗细，0 表示实心饼 */
    ring?: number
  }>(),
  {
    height: 220,
    ring: 52,
  },
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function buildOption() {
  return {
    animation: true,
    animationDuration: 320,
    tooltip: {
      trigger: 'item',
      confine: true,
      ...tooltipStyle(),
      formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}<br/>${p.value} 次（${p.percent}%）`,
    },
    legend: { show: false },
    series: [
      {
        type: 'pie' as const,
        radius: props.ring ? [`${100 - props.ring}%`, '72%'] : '72%',
        center: ['50%', '52%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true,
          fontSize: 11,
          color: token('--ink-600'),
          formatter: '{d}%',
        },
        labelLine: { length: 8, length2: 6 },
        data: props.data.map((d) => ({
          name: d.name,
          value: d.value,
          itemStyle: { color: d.color },
        })),
      },
    ],
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

watch(() => props.data, render, { flush: 'post' })
</script>

<template>
  <div ref="el" class="pie-chart" :style="{ height: `${height}px` }" />
</template>

<style scoped>
.pie-chart {
  width: 100%;
}
</style>
