<script setup lang="ts">
// ============================================================================
// 康复评估
// ============================================================================
// 记录一次训练会话，展示动作识别结果与评估指标，并保存到 rehab_sessions。
//
// 指标算法（RMS、ROM、疲劳趋势）与实际接入硬件后一致，区别只在于数据源 ——
// 现在由模拟器生成，将来换成真实采集。
// ============================================================================
import { computed, onMounted, reactive, ref } from 'vue'

import { ElMessage } from 'element-plus'

import BarChart from '@/components/BarChart.vue'
import type { BarSeries } from '@/components/BarChart.vue'
import {
  REHAB_EXERCISES,
  generateSession,
  type ExerciseName,
  type SessionResult,
} from '@/lib/assessment'
import { formatDuration } from '@/lib/format'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'
import type { JointName, RehabSessionInsert } from '@/types'

const user = useUserStore()
const sessions = useSessionStore()
const devices = useDeviceStore()

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
    color: '#409eff',
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
    return [{ name: '关节活动度', data: [Number(current.toFixed(1))], color: '#67c23a', showValue: true }]
  }
  return [
    {
      name: '关节活动度',
      data: [Number(current.toFixed(1)), Number(last.toFixed(1))],
      // 本次绿、上次灰 —— 一眼看出进步还是退步
      color: ['#67c23a', '#c0c4cc'],
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
  return [{ value: r.target, label: `目标 ${r.target}°`, color: '#e6a23c' }]
})

/** 静力动作的活动度图只是参考，标题要说明 */
const isStaticExercise = computed(() => result.value?.metric === 'hold')

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

onMounted(() => {
  regenerate()
  // 拉最近几条记录，用于 ROM 对比（RLS 只会返回当前用户可见的）
  if (!sessions.loaded) void sessions.fetch({ limit: 5 })
  if (!devices.loaded) void devices.fetchAll()
})
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

      <!-- 建议 -->
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
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
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
  color: #a8abb2;
}

.panel__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #a8abb2;
}

.panel__note code {
  padding: 1px 4px;
  border-radius: 3px;
  background: #f5f7fa;
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
  color: #e6a23c;
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
  color: #909399;
}

.recognize__value {
  margin: 4px 0 2px;
  font-size: 26px;
  font-weight: 600;
  color: #2b7de9;
}

.recognize__conf {
  font-size: 13px;
  color: #606266;
  font-variant-numeric: tabular-nums;
}

.recognize__mismatch {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #e6a23c;
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
  color: #909399;
}

.conf--top {
  color: #303133;
  font-weight: 500;
}

.conf__name {
  white-space: nowrap;
}

.conf__track {
  height: 8px;
  border-radius: 4px;
  background: #f2f3f5;
  overflow: hidden;
}

.conf__fill {
  height: 100%;
  border-radius: 4px;
  background: #c0c4cc;
  transition: width 0.3s;
}

.conf--top .conf__fill {
  background: linear-gradient(90deg, #409eff, #2b7de9);
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
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.summary__item--accent {
  border-color: #f5dab1;
  background: linear-gradient(180deg, #fdf8f0 0%, #fff 100%);
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

.summary__unit {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 400;
  color: #909399;
}

/* ---------- 图表 ---------- */
.charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

/* ---------- 建议 ---------- */
.advice {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.advice__item {
  padding: 12px 14px;
  border-radius: 8px;
  border-left: 3px solid #c0c4cc;
  background: #fafafa;
}

.advice__item--good {
  border-left-color: #67c23a;
  background: #f4faf0;
}

.advice__item--warn {
  border-left-color: #e6a23c;
  background: #fdf8f0;
}

.advice__item--info {
  border-left-color: #409eff;
  background: #f2f8ff;
}

.advice__title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.advice__detail {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: #606266;
}
</style>
