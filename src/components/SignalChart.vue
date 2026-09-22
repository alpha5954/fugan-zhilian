<script lang="ts">
// ============================================================================
// 图表类型
// ============================================================================
// 这几个接口必须放在普通 <script> 块里 —— <script setup> 内的声明不会被
// 导出，写在那里外部就 import 不到。
// ============================================================================

export interface ChartSeries {
  name: string
  /** 允许 null —— 某天没有该动作的记录时留断点，而不是画成 0 */
  data: (number | null)[]
  color: string
  /** 1 表示使用右侧 Y 轴 */
  yAxisIndex?: 0 | 1
  /** 是否填充面积 */
  area?: boolean
  smooth?: boolean
  /** 线宽，默认 1.4。sEMG 这种高频信号线细一些更好看 */
  width?: number
  /** 是否禁用抽稀（采样点少时无所谓，点多时必须开） */
  sampling?: boolean
  /**
   * 是否显示数据点标记。**默认 true**。
   *
   * 【为什么默认开着】
   * 这个默认值是踩过坑之后定的。原先写死 `showSymbol: false`，
   * 配上 `connectNulls: false`，在**稀疏且不连续**的数据上会画出一张空图：
   * 线段需要两个相邻非空点才画得出来，标记又被关掉，于是什么都不显示。
   *
   * 实测（1440 宽，量 canvas 上的彩色像素）：
   *
   *   每个动作隔几天练一次（康复的常态）  →  **0 个彩色像素**
   *   同一个动作连续几天练                →  2548 个彩色像素
   *
   * 而数据分析页的「关节活动度趋势」正是前者 —— 患者每天练一个动作、
   * 四个动作轮着来，于是**那张图一直是空的**。因为分析页对无数据的访客
   * 走空态、没有演示数据，这个 bug 一直没被人看见。
   *
   * 两种错法的代价不对等：
   *   点太密   → 难看，但看得出有数据
   *   点不显示 → **一张空图，而且不报错**
   * 所以默认取"点开着"，密集波形（实时监测）自己显式关掉。
   */
  showSymbol?: boolean
  /**
   * 折线是否跨过没有数据的点连起来。默认 false。
   *
   * 【两个场景要的不一样，所以做成可配】
   *   false（默认）—— 缺数据的日子留空，一眼能看出"那天没练"
   *   true        —— 把趋势画出来；数据点仍然画着（showSymbol），
   *                  所以"哪几天有记录"照样看得到
   *
   * 分析页的「关节活动度趋势」必须开 true：患者每天练一个动作、四个动作
   * 轮着来，每个动作的点之间都隔着 null —— 关着的话**一条线都画不出来**，
   * 只剩一堆孤立的点（showSymbol 救回来的）。趋势图没有趋势线，
   * 那就不叫趋势图了。
   */
  connectNulls?: boolean
}

export interface ChartAxis {
  name?: string
  position?: 'left' | 'right'
  min?: number | 'dataMin'
  max?: number | 'dataMax'
}

export interface ChartMarkLine {
  value: number
  label: string
  color: string
}

/**
 * 数值区间的高亮带，用于表达「安全区 / 危险区」。
 *
 * 与标线的区别：标线是一条线，只能表达"这里是阈值"；色带能表达
 * "越过这条线之后的区域是危险的"。温度这类安全参数需要后者 ——
 * 患者看到自己在色带下方，比看到一条碰不到的虚线直观得多。
 */
export interface ChartMarkArea {
  from: number
  to: number
  /** 色带的填充色。通常是品牌色加很低的透明度 */
  color: string
  /** 色带内的文字，可为空 */
  label?: string
  /**
   * 文字的**实心**颜色。
   *
   * ⚠️ 必须和 color 分开传。色带色是加了透明度的（`#a8262614` = 8%），
   *    拿它当文字色的话标签几乎看不见 —— 实测踩过，色带上"危险区"
   *    三个字淡得像没渲染出来。
   */
  labelColor?: string
}
</script>

<script setup lang="ts">
// ============================================================================
// 实时信号图表
// ============================================================================
// ECharts 的薄封装：负责初始化和增量更新，不掺和业务逻辑。
// 只做折线图，且按需引入 —— 全量引入 echarts 会让主包多出好几百 KB。
// ============================================================================
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import {
  areaGradient,
  axisLabelStyle,
  axisPointerStyle,
  categoryAxisLineStyle,
  categoryInterval,
  formatValue,
  gridStyle,
  splitLineStyle,
  tooltipStyle,
  valueAxisLineStyle,
} from '@/lib/chartTheme'
import { token } from '@/lib/theme'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
])

const props = withDefaults(
  defineProps<{
    series: ChartSeries[]
    xData: string[]
    yAxes?: ChartAxis[]
    markLines?: ChartMarkLine[]
    markAreas?: ChartMarkArea[]
    height?: number
    /** Y 轴数值保留几位小数 */
    digits?: number
  }>(),
  {
    yAxes: () => [{ position: 'left' }],
    markLines: () => [],
    markAreas: () => [],
    height: 200,
    digits: 2,
  },
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function buildOption() {
  const axes = props.yAxes.length ? props.yAxes : [{ position: 'left' as const }]

  return {
    animation: false, // 实时流式刷新下动画只会造成拖影
    grid: gridStyle({
      hasMarkLine: props.markLines.length > 0,
      axes: axes.length,
    }),
    tooltip: {
      trigger: 'axis',
      // 实时刷新时 tooltip 会疯狂重绘，关闭动画并限制显示条数
      animation: false,
      confine: true,
      // 外观统一走 chartTheme —— 默认的白框圆角一眼就是"没调过"
      ...tooltipStyle(),
      axisPointer: axisPointerStyle(),
      valueFormatter: (v: unknown) => formatValue(v, props.digits),
    },
    legend: { show: false }, // 图例由外层 HTML 渲染，样式更可控
    xAxis: {
      type: 'category',
      data: props.xData,
      boundaryGap: false,
      axisLine: categoryAxisLineStyle(),
      axisTick: { show: false },
      // 抽稀：默认的 auto 会算出二十几个刻度，密到读不出来
      axisLabel: axisLabelStyle({ interval: categoryInterval(props.xData.length) }),
      splitLine: { show: false },
    },
    yAxis: axes.map((axis, i) => ({
      type: 'value' as const,
      name: axis.name,
      nameTextStyle: axisLabelStyle({ align: 'left' }),
      position: axis.position ?? (i === 1 ? 'right' : 'left'),
      min: axis.min,
      max: axis.max,
      // scale 让坐标轴贴合数据范围而不是从 0 起。
      // ⚠️ 只有在调用方没指定 min 时才开 —— 显式指定了范围就按指定的来
      scale: axis.min === undefined,
      // 网格线少几条。默认 5 条铺满之后会织成一张网，把数据压下去
      splitNumber: 4,
      axisLine: valueAxisLineStyle(),
      axisTick: { show: false },
      axisLabel: axisLabelStyle(),
      splitLine: splitLineStyle(),
    })),
    series: props.series.map((s) => {
      // 只有第一条序列挂标线，避免标线被重复绘制
      const withMark = s === props.series[0] && props.markLines.length
      return {
        type: 'line' as const,
        name: s.name,
        data: s.data,
        yAxisIndex: s.yAxisIndex ?? 0,
        // 默认显示点。理由见 ChartSeries.showSymbol 的注释 ——
        // 关掉之后，稀疏且不连续的数据会画出一张不报错的空图
        showSymbol: s.showSymbol ?? true,
        symbolSize: 5,
        smooth: s.smooth ?? false,
        connectNulls: s.connectNulls ?? false,
        // 点多了必须开抽稀，否则每帧要画的点数翻几倍
        sampling: s.sampling === false ? undefined : ('lttb' as const),
        lineStyle: { width: s.width ?? 1.4, color: s.color },
        itemStyle: { color: s.color },
        areaStyle: s.area ? areaGradient(s.color) : undefined,
        markArea: s === props.series[0] && props.markAreas.length
          ? {
              silent: true,
              animation: false,
              itemStyle: { color: props.markAreas[0]!.color },
              data: props.markAreas.map((a) => [
                {
                  yAxis: a.from,
                  ...(a.label
                    ? {
                        label: {
                          show: true,
                          position: 'insideTopLeft' as const,
                          color: a.labelColor ?? a.color,
                          fontSize: 10,
                          fontFamily: token('--font-num'),
                          formatter: a.label,
                        },
                      }
                    : {}),
                },
                { yAxis: a.to },
              ]),
            }
          : undefined,
        markLine: withMark
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
                  fontFamily: token('--font-num'),
                  position: 'insideEndTop' as const,
                },
              })),
            }
          : undefined,
      }
    }),
  }
}

function render() {
  if (!chart) return
  // lazyUpdate 让 ECharts 把这一帧内的多次 setOption 合并成一次重绘
  chart.setOption(buildOption(), { lazyUpdate: true })
}

onMounted(() => {
  if (!el.value) return

  chart = echarts.init(el.value, undefined, { renderer: 'canvas' })
  render()

  // 容器尺寸变化时 ECharts 不会自动跟随，必须显式 resize。
  // 用 ResizeObserver 而不是监听 window.resize —— 侧边栏折叠、栅格换行
  // 这类不改变窗口尺寸的布局变化，window.resize 是收不到的。
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  // 不 dispose 会泄漏 canvas 和事件监听，切换路由几次就能感觉到卡
  chart?.dispose()
  chart = null
})

// 数据变化就重绘。父组件每次都会传入新数组，引用比较即可触发。
watch(
  () => [props.xData, ...props.series.map((s) => s.data)],
  render,
  { flush: 'post' },
)
</script>

<template>
  <div ref="el" class="chart" :style="{ height: `${height}px` }" />
</template>

<style scoped>
.chart {
  width: 100%;
}
</style>
