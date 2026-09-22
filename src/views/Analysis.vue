<script setup lang="ts">
// ============================================================================
// 数据分析
// ============================================================================
// 四个图表：活动度趋势（按动作分线）、各动作达标对比、温度历史、动作分布。
// 导出 PDF 走浏览器打印，见文件末尾 exportPdf 的说明。
// ============================================================================
import { computed, onMounted, ref, watch } from 'vue'

import BarChart from '@/components/BarChart.vue'
import type { BarSeries } from '@/components/BarChart.vue'
import { Info } from 'lucide-vue-next'

import DemoNotice from '@/components/DemoNotice.vue'
import FindingCard from '@/components/FindingCard.vue'
import PieChart from '@/components/PieChart.vue'
import RiskBadge from '@/components/RiskBadge.vue'
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
import { seriesColor } from '@/lib/chartTheme'
import { demoSessions } from '@/lib/demoData'
import { formatDateTime } from '@/lib/format'
import { TOP_FINDINGS } from '@/lib/scoreConfig'
import { useCareStore } from '@/stores/care'
import { useSessionStore } from '@/stores/session'
import { token } from '@/lib/theme'
import { DIRECTION_LABEL, buildTrendReport } from '@/lib/trend'

const sessions = useSessionStore()
const care = useCareStore()

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
      // 家属的 RLS 范围是多个监护对象，不指定会把几个人的记录
      // 画进同一条趋势线里 —— 那比没有数据更糟，因为看起来是"有结果"的
      patientId: care.activePatientId,
      limit: 500,
    })
    // 见过真实记录就不再回退到演示数据。只增不减
    if (sessions.sessions.length) everHadData.value = true
  } finally {
    loading.value = false
  }
}

// 切换查看对象后重新拉取。监听 viewingPatientId 而非 activePatientId ——
// 后者在登录完成时也会变，会和 onMounted 的首次加载重复
watch(() => care.viewingPatientId, load)

function onFilterChange() {
  void load()
}

// ---------------------------------------------------------------------------
// 数据（在 store 数据之上再做一层动作筛选）
// ---------------------------------------------------------------------------

/**
 * 该展示演示数据吗。
 *
 * 【为什么分析页也需要它】
 * 首页早就有了。首次打开链接的人（评审、家属、队友）一定没有历史记录，
 * 而这一页的价值完全建立在历史上 —— 没有记录就只剩一句"所选范围内还没有
 * 训练记录"，四张图和结论区**一个都不出现**。让评审看到一片空白，
 * 等于这套东西没做。
 *
 * ⚠️ 判据是"**这个患者从来没有过记录**"，不是"当前窗口内没有记录"。
 *    后者会让一个真实用户选了「近 7 天」而恰好那周没练时，看到一组别人的
 *    数据 —— 就算标了"演示数据"，也足以让人误会。所以用一个只增不减的
 *    标记，见过一次真实记录就永远不再回退。
 */
const everHadData = ref(false)
const usingDemo = computed(
  () => !loading.value && !sessions.error && !everHadData.value,
)

/**
 * 这一页实际基于的记录：真实的，或演示的。
 *
 * ⚠️ 演示记录**必须自己按窗口筛一遍**。
 *    真实数据是 `sessions.fetch({ from })` 带回来的，时间范围在请求里就
 *    已经过滤掉了；而演示数据是内存里造的，没经过那道。不筛的话选了
 *    「近 7 天」还会显示 21 天的记录 —— 界面上的窗口标签就成了假的，
 *    而这一页的结论**全都带窗口**（"近 7 天共…"），标签一假，整段结论
 *    都在描述一个不是用户所选的范围。
 */
const source = computed(() => {
  if (!usingDemo.value) return sessions.sessions
  const rows = demoSessions()
  const { from } = rangeFromDays(rangeDays.value)
  if (!from) return rows
  return rows.filter((s) => new Date(s.started_at) >= from)
})

const filtered = computed(() =>
  exerciseFilter.value
    ? source.value.filter((s) => s.exercise === exerciseFilter.value)
    : source.value,
)

const summary = computed(() => summarize(filtered.value))
const trend = computed(() => buildTrendByExercise(filtered.value))

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------
// 【为什么这一页需要结论层】
// 原先这里从「六个数字」直接跳到「四张图」，中间一句人话都没有 ——
// 用户得自己把曲线翻译成"在进步还是停滞"。而导出 PDF 走 window.print()，
// 所以拿出去的报告也是四张图加六个数，没人看得出说明什么。
//
// 【它和另外两页的分工】
// 首页说"本周恢复得怎么样"（一个加权分数），评估页说"这一次做得怎么样"。
// 这一页说"所选窗口内，**每个动作分别**往哪个方向走" —— 这是另外两页
// 都给不出的。所以 trend.ts 刻意不算分数、不评价单次，避免成为第三次复读。
const trendReport = computed(() =>
  buildTrendReport(filtered.value, { days: rangeDays.value }),
)

/** 结论条目也限流 —— 一次列五条并列的，用户会全部略过 */
const findingsOpen = ref(false)
const visibleFindings = computed(() =>
  trendReport.value.findings.slice(0, TOP_FINDINGS),
)
const hiddenFindings = computed(() =>
  trendReport.value.findings.slice(TOP_FINDINGS),
)
const compare = computed(() => compareExercises(filtered.value))
const temperature = computed(() => buildTemperatureHistory(filtered.value))
const distribution = computed(() => buildExerciseDistribution(filtered.value))

/** 饼图要的是带色值的数据，把索引解析掉 */
const pieData = computed(() =>
  distribution.value.map((d) => ({
    name: d.name,
    value: d.value,
    color: seriesColor(d.colorIndex),
  })),
)

const hasData = computed(() => filtered.value.length > 0)

// ---------------------------------------------------------------------------
// 图表配置
// ---------------------------------------------------------------------------
const trendSeries = computed<ChartSeries[]>(() =>
  trend.value.series.map((s) => ({
    name: s.name,
    data: s.data,
    color: seriesColor(s.colorIndex),
    smooth: true,
    width: 1.8,
  })),
)

const compareSeries = computed<BarSeries[]>(() => [
  {
    name: '平均活动度',
    data: compare.value.avgRom,
    color: token('--brand-700'),
    showValue: true,
  },
  {
    // 目标值用浅色柱并排画，差距一眼可见 —— 比只画一条横线清楚
    name: '目标值',
    data: compare.value.targets,
    color: token('--line-strong'),
  },
])

const temperatureSeries = computed<ChartSeries[]>(() => [
  {
    name: '皮温峰值',
    data: temperature.value.values,
    color: token('--danger'),
    smooth: true,
    width: 1.8,
  },
])

const tempMarkLines = [
  { value: TEMP_ALERT_THRESHOLD, label: `预警 ${TEMP_ALERT_THRESHOLD} °C`, color: token('--danger') },
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
      <!-- 演示数据声明。与首页共用同一个组件和同一句话的壳子 ——
           两页各写一份的话，改了一处另一处不变，同一个访客会在两个页面上
           看到对"演示数据"的两种不同说明 -->
      <DemoNotice v-if="usingDemo">
        您还没有训练记录，下面用一组示例数据展示这一页能给出什么样的结论。
        去「康复评估」记录一次训练后，这里会自动换成您自己的数据。
      </DemoNotice>

      <!-- ================= 结论 =================
           放在概要条和图表**之前**：先结论、后依据、再明细。
           这是「康复评估」页那次教训的直接应用 —— 那一页的结论原先排在
           页面 82% 处，要滚到底才看得到，而它是全页最重要的产出 -->
      <section class="panel panel--conclusion">
        <header class="panel__head">
          <h2 class="panel__title">这段时间的结论</h2>
          <span class="panel__unit">
            {{ trendReport.windowLabel }} · 依据训练记录自动生成
          </span>
        </header>

        <p class="conclusion__headline">{{ trendReport.headline }}</p>

        <!-- 短窗口提示。7 天最多 7 个数据点，而一天只练一个动作的话
             每个动作还分不到 4 天，算出来的方向主要是噪声 ——
             不提示的话用户会拿三五天的数据当趋势 -->
        <p v-if="trendReport.shortWindow" class="conclusion__hint" role="note">
          <Info class="conclusion__hint-icon" aria-hidden="true" />
          {{ trendReport.windowLabel }}的跨度较短，趋势判断的参考价值有限。
          想看方向建议选「近 30 天」或更长。
        </p>

        <!-- 逐动作的方向。**这一页独有的产出** —— 首页只给一个加权分数，
             评估页只看单次，都说不出"哪个动作在进步、哪个卡住了" -->
        <ul v-if="trendReport.items.length" class="trendlist">
          <li
            v-for="it in trendReport.items"
            :key="it.exercise"
            class="trendlist__item"
          >
            <RiskBadge :band="it.band" dot size="sm" />
            <span class="trendlist__name">{{ it.exercise }}</span>

            <!-- 方向判不出来就说判不出来，不编一个"持平"。
                 但"最近一次达没达标"照给 —— 那件事一次训练就能回答 -->
            <span class="trendlist__dir" :class="{ 'trendlist__dir--none': !it.trend }">
              {{ it.trend ? DIRECTION_LABEL[it.trend.direction] : '看不出方向' }}
            </span>
            <span class="trendlist__nums">
              <template v-if="it.trend">
                {{ it.trend.before.toFixed(1) }}° → {{ it.trend.after.toFixed(1) }}°
              </template>
              <template v-else>最近 {{ it.latest.toFixed(1) }}°</template>
            </span>
            <span class="trendlist__meta">
              {{ it.metricName }} · 目标 {{ it.target }}° · {{ it.points }} 天记录
            </span>
          </li>
        </ul>

        <!-- 结论条目。与评估页共用 FindingCard，两页长得一样 -->
        <div v-if="trendReport.findings.length" class="findings">
          <FindingCard
            v-for="f in visibleFindings"
            :key="f.key"
            :finding="f"
          />

          <template v-if="hiddenFindings.length">
            <button
              type="button"
              class="findings__more"
              :aria-expanded="findingsOpen"
              @click="findingsOpen = !findingsOpen"
            >
              {{ findingsOpen ? '收起' : `另有 ${hiddenFindings.length} 条` }}
            </button>

            <template v-if="findingsOpen">
              <FindingCard
                v-for="f in hiddenFindings"
                :key="f.key"
                :finding="f"
              />
            </template>
          </template>
        </div>
      </section>

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
          <!-- 光给一个「8」读不出分母 —— 是 8 次达标，还是达标率 8%？
               补上总数才是个能用的数 -->
          <p class="summary__value">
            {{ summary.onTargetCount
            }}<span class="summary__of"> / {{ summary.totalSessions }} 次</span>
          </p>
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
                <span class="legend__dot" :style="{ background: seriesColor(s.colorIndex) }" />
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
          <!-- 数据层只给分类索引，颜色在这里解析成字面值 ——
             色值的唯一来源仍是 tokens.css -->
        <PieChart v-if="distribution.length" :data="pieData" :height="240" />
          <el-empty v-else description="暂无数据" :image-size="60" />
          <div class="legend">
            <span v-for="d in distribution" :key="d.name" class="legend__item">
              <span class="legend__dot" :style="{ background: seriesColor(d.colorIndex) }" />
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
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.filterbar__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filterbar__label {
  font-size: 13px;
  color: var(--ink-400);
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
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.summary__item--alert {
  border-color: var(--danger-line);
  background: var(--danger-bg);
}

.summary__item--alert .summary__value {
  color: var(--danger);
}

.summary__label {
  font-size: 12px;
  color: var(--ink-400);
}

.summary__value {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--ink-800);
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
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
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
  color: var(--ink-800);
}

.panel__unit {
  font-size: 12px;
  color: var(--ink-300);
}

/* ==========================================================================
   结论
   ==========================================================================
   这一块是这一页最重要的产出，所以给它比普通图表面板更强的存在感：
   左侧一道品牌色竖条。不用大面积底色 —— 那会让"结论"看起来像"警告"，
   而结论里大部分是正常信息。
   ========================================================================== */
.panel--conclusion {
  border-left: 3px solid var(--brand-700);
}

/* 提示条里的信息图标。和首行对齐，不跟着行高往下掉 */
.conclusion__hint-icon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin-top: 3px;
}

.conclusion__headline {
  margin: 0;
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  color: var(--ink-800);
}

/* 短窗口提示。做成中性信息条 —— 这不是错误，是如实说明可信度 */
.conclusion__hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--info-line);
  border-radius: var(--r-sm);
  background: var(--info-bg);
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-600);
}

/* ---------- 逐动作方向 ----------
   一行一个动作：灯 / 名字 / 方向 / 起止 / 说明。
   这是分析页独有的产出，所以给它独立的视觉块，不和结论条目混在一起 */
.trendlist {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  overflow: hidden;
}

.trendlist__item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-sunken);
  font-size: var(--fs-sm);
}

/* 斑马纹：五行以上时靠它才扫得清哪一格对哪一行 */
.trendlist__item:nth-child(even) {
  background: var(--surface);
}

.trendlist__name {
  min-width: 5em;
  font-weight: var(--fw-medium);
  color: var(--ink-800);
}

.trendlist__dir {
  color: var(--ink-600);
}

/* 看不出方向：弱化，别让它看起来像一种判断 */
.trendlist__dir--none {
  color: var(--ink-300);
}

.trendlist__nums {
  font-family: var(--font-num);
  font-variant-numeric: tabular-nums;
  color: var(--ink-700);
}

.trendlist__meta {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--ink-400);
}

/* ---------- 结论条目 ----------
   .finding* 本身在 components/FindingCard.vue 里，这里只放容器 */
.findings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.findings__more {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: var(--fs-xs);
  color: var(--brand-700);
  cursor: pointer;
}

.findings__more:hover {
  text-decoration: underline;
}

/* 概要条里「8 / 12 次」的分数部分 —— 比主数字弱一档 */
.summary__of {
  margin-left: 2px;
  font-size: 12px;
  font-weight: var(--fw-normal);
  color: var(--ink-400);
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
  color: var(--ink-300);
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
  color: var(--ink-400);
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-xs);
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
    border-bottom: 1px solid var(--line-strong);
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
    border-color: var(--line-strong);
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
