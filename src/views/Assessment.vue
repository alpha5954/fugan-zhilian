<script setup lang="ts">
// ============================================================================
// 康复评估
// ============================================================================
// 记录一次训练会话，展示动作识别结果与评估指标，并保存到 rehab_sessions。
//
// 指标算法（RMS、ROM、疲劳趋势）与实际接入硬件后一致，区别只在于数据源 ——
// 现在由模拟器生成，将来换成真实采集。
// ============================================================================
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { ElMessage } from 'element-plus'

import BarChart from '@/components/BarChart.vue'
import type { BarSeries } from '@/components/BarChart.vue'
import ConclusionCard from '@/components/ConclusionCard.vue'
import FoldToggle from '@/components/FoldToggle.vue'
import PhaseChart from '@/components/PhaseChart.vue'
import {
  REHAB_EXERCISES,
  generateSession,
  metricLabel,
  type ExerciseName,
  type SessionResult,
} from '@/lib/assessment'
import { formatDuration } from '@/lib/format'
import type { RiskBand } from '@/lib/insight'
import { useCareStore } from '@/stores/care'
import { useDeviceStore } from '@/stores/device'
import { usePrefsStore } from '@/stores/prefs'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'
import type { JointName, RehabSessionInsert } from '@/types'
import { token } from '@/lib/theme'

const user = useUserStore()
const care = useCareStore()
const sessions = useSessionStore()
const devices = useDeviceStore()
const prefs = usePrefsStore()

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------
const form = reactive({
  exercise: '直腿抬高' as ExerciseName,
  joint: 'knee' as JointName,
  startedAt: new Date(),
  repCount: 8,
  notes: '',
})

const JOINT_LABELS: Record<JointName, string> = {
  knee: '膝关节',
  shoulder: '肩关节',
  elbow: '肘关节',
  wrist: '腕关节',
  ankle: '踝关节',
}

const jointOptions = Object.entries(JOINT_LABELS).map(([value, label]) => ({
  value: value as JointName,
  label,
}))

// ---------------------------------------------------------------------------
// 评估结果
// ---------------------------------------------------------------------------
const result = ref<SessionResult | null>(null)
const generating = ref(false)
const saving = ref(false)

function regenerate() {
  generating.value = true
  try {
    result.value = generateSession(form.exercise, form.repCount)
  } finally {
    generating.value = false
  }
}

// 表单里会影响指标的字段变了就重新评估
function onFormChange() {
  regenerate()
}

/** 上一次会话，用于 ROM 对比 */
const previous = computed(() => sessions.sessions[0] ?? null)

// ---------------------------------------------------------------------------
// 图表数据
// ---------------------------------------------------------------------------
const rmsChart = computed<BarSeries[]>(() => [
  {
    name: '肌电 RMS',
    data: (result.value?.reps ?? []).map((r) => Number(r.rms.toFixed(3))),
    color: token('--brand-700'),
  },
])

const rmsXData = computed(
  () => (result.value?.reps ?? []).map((r) => `第 ${r.index} 次`),
)

/** 本次与上次的 ROM 对比，附康复目标线 */
const romChart = computed<BarSeries[]>(() => {
  const current = result.value?.romMax ?? 0
  const last = previous.value?.rom_deg ?? null

  if (last === null) {
    return [{ name: '关节活动度', data: [Number(current.toFixed(1))], color: token('--ok'), showValue: true }]
  }
  return [
    {
      name: '关节活动度',
      data: [Number(current.toFixed(1)), Number(last.toFixed(1))],
      // 本次绿、上次灰 —— 一眼看出进步还是退步
      color: [token('--ok'), token('--ink-200')],
      showValue: true,
    },
  ]
})

const romXData = computed(() =>
  previous.value ? ['本次', '上次'] : ['本次'],
)

// 达标线只给动态动作画。静力动作的达标看的是保持角度而非活动范围，
// 在活动度图上画它的目标线等于拿两个不同的量做对比 —— 会误导。
const romMarkLines = computed(() => {
  const r = result.value
  if (!r || r.metric !== 'rom') return []
  return [{ value: r.target, label: `目标 ${r.target}°`, color: token('--warn') }]
})

/** 静力动作的活动度图只是参考，标题要说明 */
const isStaticExercise = computed(() => result.value?.metric === 'hold')

// ---------------------------------------------------------------------------
// 家属模式：本次结论
// ---------------------------------------------------------------------------
// 这一页对家属只有一个问题：这次做得怎么样。
// 识别置信度、肌电 RMS、相位环路、各轮次柱状图全部收进折叠区。

/** 家属模式下技术细节是否展开。默认收起 */
const techOpen = ref(false)

/**
 * 本次训练的达标情况。
 *
 * ⚠️ 达标判定按动作**自己的**指标：动态动作看关节活动范围，
 *    静力动作看保持角度。两者不是同一个量，混用会得出完全相反的结论
 *    （靠墙静蹲的活动范围本来就只有几度）。这一层区分在 assessment.ts
 *    的 AssessMetric 里做完了，这里只负责翻成一句话。
 */
const outcome = computed(() => {
  const r = result.value
  if (!r) return null

  const ratio = r.target > 0 ? r.metricValue / r.target : 1
  const band: RiskBand = ratio >= 1 ? 'green' : ratio >= 0.85 ? 'yellow' : 'red'

  return {
    band,
    ratio,
    reached: ratio >= 1,
    label: metricLabel(r.metric),
    value: r.metricValue,
    target: r.target,
  }
})

const outcomeHeadline = computed(() => {
  const o = outcome.value
  if (!o) return ''
  const pct = Math.round(o.ratio * 100)
  if (o.reached) return `本次训练达标，${o.label}达到康复目标`
  if (o.band === 'yellow') return `接近达标，${o.label}已完成 ${pct}%`
  return `本次还未达标，${o.label}完成 ${pct}%`
})

/** 四类置信度，降序排列 */
const confidenceList = computed(() => {
  if (!result.value) return []
  return REHAB_EXERCISES.map((name) => ({
    name,
    value: result.value!.confidence[name] ?? 0,
    isTop: name === result.value!.recognized,
  })).sort((a, b) => b.value - a.value)
})

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
const savedId = ref<string | null>(null)

async function save() {
  if (!result.value) return
  // 前置守卫：防止重复点击造成同一会话被写入多条
  if (saving.value) return

  const patientId = user.userId
  if (!patientId) {
    ElMessage.error('未获取到当前用户身份，无法保存')
    return
  }

  saving.value = true
  savedId.value = null
  try {
    const r = result.value
    const startedAt = form.startedAt
    const endedAt = new Date(startedAt.getTime() + r.durationS * 1000)

    const payload: RehabSessionInsert = {
      patient_id: patientId,
      device_id: devices.devices[0]?.id ?? null,
      joint: form.joint,
      exercise: form.exercise,
      recognized: r.recognized,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_s: r.durationS,
      rep_count: form.repCount,
      rom_deg: Number(r.romMax.toFixed(2)),
      temp_c: Number(r.tempMax.toFixed(2)),
      // numeric(6,4) —— 总共 6 位、小数 4 位，所以整数部分最多两位。
      // RMS 是 mV 量级（0.0x ~ 1.x），不会溢出，但仍按列精度取整避免隐式舍入
      rms_mv: Number(r.rmsAvg.toFixed(4)),
      confidence: Number(r.topConfidence.toFixed(3)),
      waveform: r.waveform,
      notes: form.notes.trim() || null,
    }

    const created = await sessions.create(payload)
    if (created) {
      savedId.value = created.id
      ElMessage.success('已保存到训练记录')
    } else {
      // store 里已经把错误文本写进 error 了，直接展示
      ElMessage.error(sessions.error ?? '保存失败')
    }
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------

/** 拉取 ROM 对比用的历史记录。切换查看对象时要重新拉 */
async function loadHistory() {
  await sessions.fetch({ limit: 5, patientId: care.activePatientId })
}

onMounted(() => {
  regenerate()
  void loadHistory()
  // 设备只列自己的 —— 记录训练用的是患者本人的设备
  if (!devices.loaded) void devices.fetchAll({ ownerId: user.userId ?? undefined })
})

// 切换查看对象后重新拉历史，否则 ROM 对比会拿别人的上次记录来比。
// 监听 viewingPatientId 而非 activePatientId，理由同 Dashboard
watch(() => care.viewingPatientId, loadHistory)
</script>

<template>
  <div class="assess">
    <!-- ================= 左栏：表单 ================= -->
    <aside class="assess__side">
      <section class="panel">
        <h2 class="panel__title">训练信息</h2>

        <el-form label-position="top" @submit.prevent>
          <el-form-item label="患者">
            <el-input :model-value="user.displayName" disabled />
            <p v-if="user.isCaregiver" class="field-hint">
              当前以「{{ user.isFamily ? '家属' : '治疗师' }}」身份登录。
              代其他患者记录暂未开放，此功能需先选择监护对象。
            </p>
          </el-form-item>

          <el-form-item label="训练动作">
            <el-select v-model="form.exercise" class="full" @change="onFormChange">
              <el-option
                v-for="name in REHAB_EXERCISES"
                :key="name"
                :label="name"
                :value="name"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="关节">
            <el-select v-model="form.joint" class="full" @change="onFormChange">
              <el-option
                v-for="opt in jointOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="完成次数">
            <el-input-number
              v-model="form.repCount"
              :min="1"
              :max="30"
              class="full"
              @change="onFormChange"
            />
          </el-form-item>

          <el-form-item label="训练时间">
            <el-date-picker
              v-model="form.startedAt"
              type="datetime"
              class="full"
              placeholder="选择时间"
            />
          </el-form-item>

          <el-form-item label="备注">
            <el-input
              v-model="form.notes"
              type="textarea"
              :rows="2"
              maxlength="200"
              show-word-limit
              placeholder="选填"
            />
          </el-form-item>
        </el-form>

        <div class="panel__actions">
          <el-button :loading="generating" @click="regenerate">重新评估</el-button>
          <el-button type="primary" :loading="saving" @click="save">
            保存到训练记录
          </el-button>
        </div>

        <el-alert
          v-if="savedId"
          type="success"
          :closable="false"
          show-icon
          class="saved-tip"
          title="已保存"
          description="可在「数据分析」页查看这条记录的趋势。"
        />
      </section>
    </aside>

    <!-- ================= 右栏：结果 ================= -->
    <div class="assess__main">
      <!-- ---------- 家属模式：本次结论 ----------
           家属打开这一页只想知道"这次做得怎么样"。
           识别置信度、肌电 RMS、相位环路、各轮次柱状图全部收进下面的折叠区 -->
      <ConclusionCard
        v-if="!prefs.proMode && outcome"
        :band="outcome.band"
        :headline="outcomeHeadline"
        :detail="`${outcome.label} ${outcome.value.toFixed(1)}° ／ 康复目标 ${outcome.target}°`"
      />

      <FoldToggle
        v-if="!prefs.proMode"
        :open="techOpen"
        label="查看技术细节（识别置信度、肌电、图表）"
        open-label="收起技术细节"
        @toggle="techOpen = !techOpen"
      />

      <!-- 折叠区。下面这段的缩进保持原样没跟着加一级 —— 纯缩进改动
           会把这次的真实改动淹掉，Vue 也不关心缩进 -->
      <template v-if="prefs.proMode || techOpen">
      <!-- 识别结果 -->
      <section class="panel">
        <h2 class="panel__title">动作识别结果</h2>

        <div v-if="result" class="recognize">
          <div class="recognize__verdict">
            <span class="recognize__label">模型判定</span>
            <p class="recognize__value">{{ result.recognized }}</p>
            <span class="recognize__conf">
              置信度 {{ (result.topConfidence * 100).toFixed(1) }}%
            </span>
            <p
              v-if="result.recognized !== result.performed"
              class="recognize__mismatch"
            >
              ⚠ 与所选动作「{{ result.performed }}」不一致，动作可能不够标准
            </p>
          </div>

          <div class="recognize__bars">
            <div
              v-for="c in confidenceList"
              :key="c.name"
              class="conf"
              :class="{ 'conf--top': c.isTop }"
            >
              <span class="conf__name">{{ c.name }}</span>
              <div class="conf__track">
                <div
                  class="conf__fill"
                  :style="{ width: `${(c.value * 100).toFixed(1)}%` }"
                />
              </div>
              <span class="conf__value">{{ (c.value * 100).toFixed(1) }}%</span>
            </div>
          </div>
        </div>

        <el-empty v-else description="正在生成评估…" :image-size="70" />
      </section>

      <!-- 指标概览 -->
      <section v-if="result" class="summary">
        <div class="summary__item">
          <span class="summary__label">肌电 RMS</span>
          <p class="summary__value">
            {{ result.rmsAvg.toFixed(3) }}<span class="summary__unit">mV</span>
          </p>
        </div>
        <div class="summary__item">
          <span class="summary__label">关节活动范围</span>
          <p class="summary__value">
            {{ result.romMax.toFixed(1) }}<span class="summary__unit">°</span>
          </p>
        </div>
        <div
          v-if="isStaticExercise"
          class="summary__item summary__item--accent"
        >
          <span class="summary__label">保持角度（达标依据）</span>
          <p class="summary__value">
            {{ result.holdAngle.toFixed(1)
            }}<span class="summary__unit">° / 目标 {{ result.target }}°</span>
          </p>
        </div>
        <div class="summary__item">
          <span class="summary__label">温度区间</span>
          <p class="summary__value">
            {{ result.tempMin.toFixed(1) }}–{{ result.tempMax.toFixed(1)
            }}<span class="summary__unit">°C</span>
          </p>
        </div>
        <div class="summary__item">
          <span class="summary__label">训练时长</span>
          <p class="summary__value">
            {{ formatDuration(result.durationS) }}
          </p>
        </div>
      </section>

      <!-- 图表 -->
      <section class="charts">
        <article class="panel">
          <header class="panel__head">
            <h3 class="panel__title panel__title--sm">各轮次肌电 RMS</h3>
            <span class="panel__unit">mV · 肌肉激活强度</span>
          </header>
          <BarChart
            :series="rmsChart"
            :x-data="rmsXData"
            :height="210"
            :digits="3"
            y-name="mV"
          />
        </article>

        <article class="panel">
          <header class="panel__head">
            <h3 class="panel__title panel__title--sm">关节活动范围对比</h3>
            <span class="panel__unit">°</span>
          </header>
          <BarChart
            :series="romChart"
            :x-data="romXData"
            :mark-lines="romMarkLines"
            :height="210"
            :digits="1"
            y-name="°"
          />
          <p v-if="isStaticExercise" class="panel__note">
            靠墙静蹲是静力动作，活动范围本就很小（只有姿势微调）。
            达标判定看的是「保持角度」，见上方指标卡片 —— 这里不画目标线，
            因为两者不是同一个量。
          </p>
          <p v-else-if="!previous" class="panel__note">
            还没有历史记录，仅显示本次结果。保存后即可与下次对比。
          </p>
        </article>
      </section>

      <!-- 肌电-运动学融合（命题答题要求点名的第三项能力） -->
      <section class="panel">
        <header class="panel__head">
          <h3 class="panel__title">肌电-关节角度相位分析</h3>
          <span class="panel__unit">运动学数据融合</span>
        </header>

        <template v-if="result && result.emgAngle.applicable">
          <p class="panel__desc">
            把一次屈伸动作里每个角度上的肌电强度按<strong>相位</strong>分开画：
            角度增大的向心期与角度减小的离心期各成一条曲线。两条曲线的
            <strong>高低差</strong>就是发力相位是否正确的直接证据 ——
            肌电峰值若落在离心期，说明存在代偿。
          </p>

          <div class="phase-legend">
            <span class="phase-legend__item">
              <span class="phase-legend__dot" style="background: var(--warn)" />
              向心期（角度增大）
            </span>
            <span class="phase-legend__item">
              <span class="phase-legend__dot" style="background: var(--brand-700)" />
              离心期（角度减小）
            </span>
          </div>

          <PhaseChart
            :concentric="result.emgAngle.concentric"
            :eccentric="result.emgAngle.eccentric"
            :peak-angle="result.emgAngle.peakAngle"
            :height="260"
          />

          <div class="phase-metrics">
            <div class="phase-metric">
              <span class="phase-metric__label">向心期肌电 RMS</span>
              <p class="phase-metric__value">
                {{ result.emgAngle.concentricRms.toFixed(4)
                }}<span class="phase-metric__unit">mV</span>
              </p>
            </div>
            <div class="phase-metric">
              <span class="phase-metric__label">离心期肌电 RMS</span>
              <p class="phase-metric__value">
                {{ result.emgAngle.eccentricRms.toFixed(4)
                }}<span class="phase-metric__unit">mV</span>
              </p>
            </div>
            <div class="phase-metric phase-metric--accent">
              <span class="phase-metric__label">向心／离心 比值</span>
              <p class="phase-metric__value">
                {{ result.emgAngle.ratio.toFixed(2) }}
              </p>
            </div>
            <div class="phase-metric">
              <span class="phase-metric__label">肌电峰值角度</span>
              <p class="phase-metric__value">
                {{ result.emgAngle.peakAngle
                }}<span class="phase-metric__unit">°</span>
              </p>
            </div>
          </div>

          <div
            class="phase-reading"
            :class="`phase-reading--${result.emgAngle.level}`"
          >
            {{ result.emgAngle.interpretation }}
          </div>
        </template>

        <!-- 静力动作做相位分析会得出无意义的比值，此时明确说明不适用，
             而不是硬画一张几乎重合的曲线 -->
        <el-empty
          v-else-if="result"
          :description="result.emgAngle.reason ?? '本次记录不适用相位分析'"
          :image-size="70"
        />
      </section>
      </template>

      <!-- 建议。两种模式都显示 —— 它本来就是给家属看的话，
           不是技术细节（detail 里写的是"请缩短单次时长"这类可执行的动作） -->
      <section class="panel">
        <h2 class="panel__title">评估建议</h2>

        <div v-if="result" class="advice">
          <div
            v-for="(a, i) in result.advice"
            :key="i"
            class="advice__item"
            :class="`advice__item--${a.level}`"
          >
            <span class="advice__title">{{ a.title }}</span>
            <p class="advice__detail">{{ a.detail }}</p>
          </div>
        </div>

        <p class="panel__note">
          建议由基于规则的评估逻辑生成（活动度达标判定、肌电疲劳趋势、
          识别置信度阈值），非大模型输出。后续接入模型时替换
          <code>buildAdvice</code> 即可，界面无需改动。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.assess {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1000px) {
  .assess {
    grid-template-columns: 1fr;
  }
}

.assess__main {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 通用面板 ---------- */
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-800);
}

.panel__title--sm {
  font-size: 14px;
}

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.panel__unit {
  font-size: 12px;
  color: var(--ink-300);
}

.panel__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-300);
}

.panel__note code {
  padding: 1px 4px;
  border-radius: var(--r-xs);
  background: var(--canvas);
}

.panel__actions {
  display: flex;
  gap: 8px;
}

.panel__actions :deep(.el-button) {
  flex: 1;
}

.full {
  width: 100%;
}

.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--warn);
}

.saved-tip {
  margin-top: 4px;
}

/* ---------- 识别结果 ---------- */
.recognize {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 24px;
  align-items: center;
}

@media (max-width: 700px) {
  .recognize {
    grid-template-columns: 1fr;
  }
}

.recognize__label {
  font-size: 12px;
  color: var(--ink-400);
}

.recognize__value {
  margin: 4px 0 2px;
  font-size: 26px;
  font-weight: 600;
  color: var(--brand-800);
}

.recognize__conf {
  font-size: 13px;
  color: var(--ink-600);
  font-variant-numeric: tabular-nums;
}

.recognize__mismatch {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--warn);
}

.recognize__bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.conf {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 52px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--ink-400);
}

.conf--top {
  color: var(--ink-800);
  font-weight: 500;
}

.conf__name {
  white-space: nowrap;
}

.conf__track {
  height: 8px;
  border-radius: var(--r-xs);
  background: var(--line-soft);
  overflow: hidden;
}

.conf__fill {
  height: 100%;
  border-radius: var(--r-xs);
  background: var(--ink-200);
  transition: width 0.3s;
}

.conf--top .conf__fill {
  background: linear-gradient(90deg, var(--brand-700), var(--brand-800));
}

.conf__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ---------- 指标概览 ---------- */
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.summary__item {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.summary__item--accent {
  border-color: var(--warn-line);
  background: linear-gradient(180deg, var(--warn-bg) 0%, #fff 100%);
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

.summary__unit {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ink-400);
}

/* ---------- 图表 ---------- */
.charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

/* ---------- 肌电-角度相位分析 ---------- */
.panel__desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink-600);
}

.panel__desc strong {
  color: var(--ink-800);
}

.phase-legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.phase-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-400);
}

.phase-legend__dot {
  width: 14px;
  height: 3px;
  border-radius: var(--r-xs);
}

.phase-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.phase-metric {
  padding: 12px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
}

/* 比值是这一节最核心的数字，单独高亮 */
.phase-metric--accent {
  border-color: var(--warn-line);
  background: var(--warn-bg);
}

.phase-metric--accent .phase-metric__value {
  color: var(--warn);
}

.phase-metric__label {
  font-size: 12px;
  color: var(--ink-400);
}

.phase-metric__value {
  margin: 4px 0 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--ink-800);
  font-variant-numeric: tabular-nums;
}

.phase-metric__unit {
  margin-left: 3px;
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-400);
}

.phase-reading {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--r-sm);
  border-left: 3px solid var(--ink-200);
  background: var(--surface-sunken);
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-600);
}

.phase-reading--good {
  border-left-color: var(--ok);
  background: var(--ok-bg);
}

.phase-reading--info {
  border-left-color: var(--brand-700);
  background: var(--info-bg);
}

.phase-reading--warn {
  border-left-color: var(--warn);
  background: var(--warn-bg);
}

/* ---------- 建议 ---------- */
.advice {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.advice__item {
  padding: 12px 14px;
  border-radius: var(--r-sm);
  border-left: 3px solid var(--ink-200);
  background: var(--surface-sunken);
}

.advice__item--good {
  border-left-color: var(--ok);
  background: var(--ok-bg);
}

.advice__item--warn {
  border-left-color: var(--warn);
  background: var(--warn-bg);
}

.advice__item--info {
  border-left-color: var(--brand-700);
  background: var(--info-bg);
}

.advice__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-800);
}

.advice__detail {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-600);
}
</style>
