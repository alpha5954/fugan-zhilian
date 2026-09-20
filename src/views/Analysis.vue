<script setup lang="ts">
// ============================================================================
// 数据分析
// ============================================================================
// 四个图表：活动度趋势（按动作分线）、各动作达标对比、温度历史、动作分布。
// 导出 PDF 走浏览器打印，见文件末尾 exportPdf 的说明。
// ============================================================================
import { computed, onMounted, ref } from 'vue'

import BarChart from '@/components/BarChart.vue'
import type { BarSeries } from '@/components/BarChart.vue'
import PieChart from '@/components/PieChart.vue'
import SignalChart from '@/components/SignalChart.vue'
import type { ChartSeries } from '@/components/SignalChart.vue'
import StateBlock from '@/components/StateBlock.vue'
import {
  TEMP_ALERT_THRESHOLD,
  buildExerciseDistribution,
  buildTemperatureHistory,
  buildTrendByExercise,
  compareExercises,
  summarize,
} from '@/lib/analysis'
import { REHAB_EXERCISES } from '@/lib/assessment'
import { formatDateTime } from '@/lib/format'
import { useSessionStore } from '@/stores/session'

const sessions = useSessionStore()

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------
const DAY_PRESETS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
  { value: 0, label: '全部时间' },
] as const

const rangeDays = ref<number>(30)
const exerciseFilter = ref<string>('') // 空字符串 = 全部动作
const loading = ref(false)

const exerciseOptions = computed(() => [
  { value: '', label: '全部动作' },
  ...REHAB_EXERCISES.map((e) => ({ value: e, label: e })),
])

/**
 * 把预设天数换算成时间区间。
 *
 * 起始点取**本地**当天零点再往前推，而不是「现在减 N×24 小时」——
 * 后者会让「近 7 天」变成滚动的 168 小时，同一天刷两次可能得到不同的
 * 结果集，用户看着数字无端变化会困惑。
 */
function rangeFromDays(days: number): { from?: Date; to?: Date } {
  if (days <= 0) return {}
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  from.setHours(0, 0, 0, 0)
  return { from, to }
}

async function load() {
  loading.value = true
  try {
    const range = rangeFromDays(rangeDays.value)
    await sessions.fetch({
      ...range,
      limit: 500,
    })
  } finally {
    loading.value = false
  }
}

function onFilterChange() {
  void load()
}

// ---------------------------------------------------------------------------
// 数据（在 store 数据之上再做一层动作筛选）
// ---------------------------------------------------------------------------
const filtered = computed(() =>
  exerciseFilter.value
    ? sessions.sessions.filter((s) => s.exercise === exerciseFilter.value)
    : sessions.sessions,
)

const summary = computed(() => summarize(filtered.value))
const trend = computed(() => buildTrendByExercise(filtered.value))
const compare = computed(() => compareExercises(filtered.value))
const temperature = computed(() => buildTemperatureHistory(filtered.value))
const distribution = computed(() => buildExerciseDistribution(filtered.value))

const hasData = computed(() => filtered.value.length > 0)

// ---------------------------------------------------------------------------
// 图表配置
// ---------------------------------------------------------------------------
const trendSeries = computed<ChartSeries[]>(() =>
  trend.value.series.map((s) => ({
    name: s.name,
    data: s.data,
    color: s.color,
    smooth: true,
    width: 1.8,
  })),
)

const compareSeries = computed<BarSeries[]>(() => [
  {
    name: '平均活动度',
    data: compare.value.avgRom,
    color: '#409eff',
    showValue: true,
  },
  {
    // 目标值用浅色柱并排画，差距一眼可见 —— 比只画一条横线清楚
    name: '目标值',
    data: compare.value.targets,
    color: '#dcdfe6',
  },
])

const temperatureSeries = computed<ChartSeries[]>(() => [
  {
    name: '皮温峰值',
    data: temperature.value.values,
    color: '#f56c6c',
    smooth: true,
    width: 1.8,
  },
])

const tempMarkLines = [
  { value: TEMP_ALERT_THRESHOLD, label: `预警 ${TEMP_ALERT_THRESHOLD} °C`, color: '#f56c6c' },
]

/** 报告标题里的筛选条件描述，屏幕和打印都显示 */
const filterSummary = computed(() => {
  const days = DAY_PRESETS.find((p) => p.value === rangeDays.value)?.label ?? ''
  const ex = exerciseFilter.value || '全部动作'
  return `${days} · ${ex}`
})

// ---------------------------------------------------------------------------
// 导出 PDF
// ---------------------------------------------------------------------------
/**
 * 用浏览器打印而不是 jsPDF。
 *
 * jsPDF 要输出中文必须嵌入 CJK 字体文件（通常 5–10 MB）并做子集化，
 * 否则中文全是方块。浏览器打印用系统字体，中文、矢量图形都正常，
 * 而且零依赖、零体积。用户在打印对话框里选「另存为 PDF」即可。
 *
 * 屏幕上不需要特殊处理：A4 打印宽度约 718px，而屏幕上的图表约 1300px，
 * 属于**缩小**渲染 —— 浏览器会拿完整分辨率的画布缩放，比按打印宽度
 * 原生重绘更清晰。只有浏览器窗口特别窄时才可能反向放大。
 */
const printing = ref(false)

function exportPdf() {
  printing.value = true
  // afterprint 在部分浏览器上不可靠，用一次性定时器兜底恢复状态
  window.print()
  setTimeout(() => {
    printing.value = false
  }, 300)
}

onMounted(load)
</script>

<template>
  <div class="analysis" :class="{ 'analysis--printing': printing }">
    <!-- 打印时才显示的报表抬头。屏幕上隐藏 -->
    <header class="report-head">
      <h1 class="report-head__title">复感智联 · 康复数据分析报告</h1>
      <p class="report-head__meta">
        数据范围：{{ filterSummary }} ·
        生成时间：{{ formatDateTime(new Date().toISOString()) }}
      </p>
    </header>

    <!-- 筛选栏（打印时隐藏） -->
    <section class="filterbar no-print">
      <div class="filterbar__item">
        <span class="filterbar__label">时间范围</span>
        <el-select
          v-model="rangeDays"
          size="default"
          style="width: 130px"
          @change="onFilterChange"
        >
          <el-option
            v-for="p in DAY_PRESETS"
            :key="p.value"
            :label="p.label"
            :value="p.value"
          />
        </el-select>
      </div>

      <div class="filterbar__item">
        <span class="filterbar__label">训练动作</span>
        <el-select
          v-model="exerciseFilter"
          size="default"
          style="width: 150px"
        >
          <el-option
            v-for="o in exerciseOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
      </div>

      <div class="filterbar__spacer" />

      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button type="primary" :disabled="!hasData" @click="exportPdf">
        导出 PDF
      </el-button>
    </section>

    <StateBlock
      :loading="loading"
      :error="sessions.error"
      :empty="!hasData"
      empty-text="所选范围内还没有训练记录。去「康复评估」记录一次训练，或放宽筛选范围。"
      @retry="load"
    >
      <!-- 概要 -->
      <section class="summary">
        <div class="summary__item">
          <span class="summary__label">训练次数</span>
          <p class="summary__value">{{ summary.totalSessions }}</p>
        </div>
        <div class="summary__item">
          <span class="summary__label">覆盖天数</span>
          <p class="summary__value">{{ summary.activeDays }}</p>
        </div>
        <div class="summary__item">
          <span class="summary__label">平均每组次数</span>
          <p class="summary__value">{{ summary.avgReps }}</p>
        </div>
        <div class="summary__item">
          <span class="summary__label">活动度达标</span>
          <p class="summary__value">{{ summary.onTargetCount }}</p>
        </div>
        <div
          class="summary__item"
          :class="{ 'summary__item--alert': summary.overTempCount > 0 }"
        >
          <span class="summary__label">温度越阈值</span>
          <p class="summary__value">{{ summary.overTempCount }}</p>
        </div>
        <div class="summary__item">
          <span class="summary__label">平均识别置信度</span>
          <p class="summary__value">{{ summary.avgConfidence.toFixed(3) }}</p>
        </div>
      </section>

      <!-- 四个图表 -->
      <section class="charts">
        <article class="panel panel--wide">
          <header class="panel__head">
            <h3 class="panel__title">关节活动度趋势</h3>
            <div class="panel__legend">
              <span v-for="s in trend.series" :key="s.name" class="legend__item">
                <span class="legend__dot" :style="{ background: s.color }" />
                {{ s.name }}
              </span>
            </div>
          </header>
          <SignalChart
            :series="trendSeries"
            :x-data="trend.dates"
            :height="240"
            :digits="1"
            :y-axes="[{ name: '°', position: 'left' }]"
          />
          <p class="panel__note">
            各动作分别成线，不跨动作平均 —— 直腿抬高的活动度只有 10° 上下，
            屈膝滑动接近 100°，平均出来的数既不代表任何动作也看不出趋势。
            断点表示当天没有该动作的记录。
          </p>
        </article>

        <article class="panel">
          <header class="panel__head">
            <h3 class="panel__title">各动作达标对比</h3>
            <span class="panel__unit">°</span>
          </header>
          <BarChart
            :series="compareSeries"
            :x-data="compare.names"
            :height="240"
            :digits="1"
            y-name="°"
          />
          <p class="panel__note">
            浅色柱是该动作的康复目标值，按动作取值而非统一标准。
          </p>
        </article>

        <article class="panel">
          <header class="panel__head">
            <h3 class="panel__title">局部温度历史</h3>
            <span class="panel__unit">°C</span>
          </header>
          <SignalChart
            :series="temperatureSeries"
            :x-data="temperature.labels"
            :mark-lines="tempMarkLines"
            :height="240"
            :digits="2"
            :y-axes="[{ name: '°C', position: 'left', min: 28, max: 52 }]"
          />
          <p class="panel__note">
            每次训练一个点，不做按天平均 —— 平均会把单次超标抹平，
            而那恰恰是最该被看到的。
          </p>
        </article>

        <article class="panel">
          <header class="panel__head">
            <h3 class="panel__title">动作分布</h3>
            <span class="panel__unit">次</span>
          </header>
          <PieChart v-if="distribution.length" :data="distribution" :height="240" />
          <el-empty v-else description="暂无数据" :image-size="60" />
          <div class="legend">
            <span v-for="d in distribution" :key="d.name" class="legend__item">
              <span class="legend__dot" :style="{ background: d.color }" />
              {{ d.name }} · {{ d.value }} 次
            </span>
          </div>
        </article>
      </section>
    </StateBlock>
  </div>
</template>

<style scoped>
.analysis {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 报表抬头只在打印时出现 */
.report-head {
  display: none;
}

/* ---------- 筛选栏 ---------- */
.filterbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  padding: 12px 18px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.filterbar__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filterbar__label {
  font-size: 13px;
  color: #909399;
  white-space: nowrap;
}

.filterbar__spacer {
  flex: 1;
}

/* ---------- 概要 ---------- */
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.summary__item {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.summary__item--alert {
  border-color: #fbc4c4;
  background: #fef6f6;
}

.summary__item--alert .summary__value {
  color: #f56c6c;
}

.summary__label {
  font-size: 12px;
  color: #909399;
}

.summary__value {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  font-variant-numeric: tabular-nums;
}

/* ---------- 图表 ---------- */
.charts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

/* 窄屏收成单列。不加这条的话，四个图表会被挤进两列，
   每个约 180px 宽 —— 折线图和饼图在这个宽度下基本读不出信息 */
@media (max-width: 820px) {
  .charts {
    grid-template-columns: 1fr;
  }
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.panel--wide {
  grid-column: 1 / -1;
}

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
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
  flex-wrap: wrap;
}

.panel__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #a8abb2;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #909399;
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

/* ==========================================================================
   打印样式
   ==========================================================================
   用户在打印对话框里选「另存为 PDF」。要点：
     - 去掉导航、筛选栏、按钮、说明文字
     - 补上报表抬头（屏幕上不显示）
     - 避免图表被分页切断
   ========================================================================== */
@media print {
  .analysis {
    gap: 10px;
  }

  .report-head {
    display: block;
    padding-bottom: 8px;
    border-bottom: 1px solid #dcdfe6;
  }

  .report-head__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #000;
  }

  .report-head__meta {
    margin: 4px 0 0;
    font-size: 11px;
    color: #666;
  }

  /* 交互元素与说明文字不进报告 */
  .no-print,
  .panel__note,
  .panel__legend,
  .legend {
    display: none !important;
  }

  .summary,
  .charts {
    gap: 8px;
  }

  .summary__item,
  .panel {
    padding: 8px 10px;
    border-color: #dcdfe6;
    /* 图表和指标卡不允许跨页断开 */
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .summary__value {
    font-size: 16px;
  }

  .panel__title {
    font-size: 12px;
  }
}
</style>
