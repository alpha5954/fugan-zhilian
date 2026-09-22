<script setup lang="ts">
// ============================================================================
// 预警列表
// ============================================================================
// 实时监测页会把温度超标、信号丢失等事件写进 alerts 表，家属端收到的提醒
// 也是这张表。在补这个页面之前，预警是"只写不读"的 —— 首页只有一个数字，
// 点不进去，也无法标记已读，红点只增不减。
// ============================================================================
import { computed, onMounted, ref, watch } from 'vue'

import { ElMessage, ElMessageBox } from 'element-plus'

import StateBlock from '@/components/StateBlock.vue'
import {
  ALERT_KIND_ADVICE,
  ALERT_KIND_LABEL,
  ALERT_SEVERITY_LABEL,
  ALERT_SEVERITY_TAG,
  SEVERITY_FILTER_OPTIONS,
} from '@/constants/alerts'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'
import { useUserStore } from '@/stores/user'
import type { Alert, AlertSeverity } from '@/types'

const alerts = useAlertStore()
const care = useCareStore()
const user = useUserStore()

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------
const onlyUnacknowledged = ref(false)
const severity = ref<'' | AlertSeverity>('')

const query = computed(() => ({
  patientId: care.activePatientId,
  onlyUnacknowledged: onlyUnacknowledged.value,
  severity: severity.value || undefined,
  limit: 200,
}))

/** 行内正在执行操作的预警 id */
const busyId = ref<string | null>(null)

async function load() {
  await alerts.fetch(query.value)
}

function onFilterChange() {
  void load()
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------
/**
 * 标记已读 / 取消已读。
 *
 * store 内部已经做了回读确认 —— RLS 对 UPDATE 是静默过滤，无权修改时
 * 既不报错也不影响行，不确认的话界面会显示成功但刷新后又变回去。
 */
async function toggleAck(alert: Alert) {
  busyId.value = alert.id
  try {
    const ok = alert.acknowledged_at
      ? await alerts.unacknowledge(alert.id)
      : await alerts.acknowledge(alert.id, user.userId)

    if (ok) {
      ElMessage.success(alert.acknowledged_at ? '已取消标记' : '已标记为已读')
      // 计数需要按当前查看对象重算 —— store 里那次是无参的，
      // 对家属来说会把所有监护对象的预警都算进去
      await alerts.fetchUnacknowledgedCount(care.activePatientId)
      // 若筛选是"仅未处理"，刚标记完的那条应从列表消失
      if (onlyUnacknowledged.value) await load()
    } else {
      ElMessage.error(alerts.opError ?? '操作失败')
    }
  } finally {
    busyId.value = null
  }
}

async function remove(alert: Alert) {
  try {
    await ElMessageBox.confirm(
      `删除这条「${ALERT_KIND_LABEL[alert.kind]}」预警记录？删除后无法恢复。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  busyId.value = alert.id
  try {
    const ok = await alerts.remove(alert.id)
    if (ok) {
      ElMessage.success('已删除')
      await alerts.fetchUnacknowledgedCount(care.activePatientId)
    } else {
      ElMessage.error(alerts.opError ?? '删除失败')
    }
  } finally {
    busyId.value = null
  }
}

/** 一键标记当前列表里所有未处理项 */
const markingAll = ref(false)

async function markAllRead() {
  const pending = alerts.alerts.filter((a) => a.acknowledged_at === null)
  if (!pending.length) return

  try {
    await ElMessageBox.confirm(
      `把当前列表里的 ${pending.length} 条未处理预警全部标记为已读？`,
      '批量标记',
      { confirmButtonText: '全部标记', cancelButtonText: '取消', type: 'info' },
    )
  } catch {
    return
  }

  markingAll.value = true
  try {
    // 逐条发。接口没有批量更新的入口，而预警数量在这个场景下不会很大；
    // 若将来要支持成百上千条，应当在数据库侧加一个批量 RPC
    let done = 0
    for (const a of pending) {
      if (await alerts.acknowledge(a.id, user.userId)) done++
    }
    ElMessage.success(`已标记 ${done} 条`)
    await alerts.fetchUnacknowledgedCount(care.activePatientId)
    if (onlyUnacknowledged.value) await load()
  } finally {
    markingAll.value = false
  }
}

// ---------------------------------------------------------------------------

const pendingCount = computed(
  () => alerts.alerts.filter((a) => a.acknowledged_at === null).length,
)

const criticalCount = computed(
  () =>
    alerts.alerts.filter(
      (a) => a.acknowledged_at === null && a.severity === 'critical',
    ).length,
)

onMounted(load)

// 家属切换查看对象后要重新拉 —— 否则会把上一个监护对象的预警留在列表里
watch(() => care.viewingPatientId, load)
</script>

<template>
  <div class="alerts">
    <!-- 概要 -->
    <section class="summary">
      <div
        class="summary__item"
        :class="{ 'summary__item--alert': criticalCount > 0 }"
      >
        <span class="summary__label">未处理·严重</span>
        <p class="summary__value">{{ criticalCount }}</p>
      </div>
      <div class="summary__item">
        <span class="summary__label">未处理·合计</span>
        <p class="summary__value">{{ pendingCount }}</p>
      </div>
      <div class="summary__item">
        <span class="summary__label">当前列表</span>
        <p class="summary__value">{{ alerts.alerts.length }}</p>
      </div>
    </section>

    <!-- 筛选栏 -->
    <section class="filterbar">
      <el-radio-group v-model="onlyUnacknowledged" @change="onFilterChange">
        <el-radio-button :value="false">全部</el-radio-button>
        <el-radio-button :value="true">仅未处理</el-radio-button>
      </el-radio-group>

      <el-select
        v-model="severity"
        style="width: 130px"
        @change="onFilterChange"
      >
        <el-option
          v-for="o in SEVERITY_FILTER_OPTIONS"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>

      <div class="filterbar__spacer" />

      <el-button
        :disabled="pendingCount === 0"
        :loading="markingAll"
        @click="markAllRead"
      >
        全部标记已读
      </el-button>
      <el-button :loading="alerts.loading" @click="load">刷新</el-button>
    </section>

    <!-- 列表 -->
    <StateBlock
      :loading="alerts.loading"
      :error="alerts.error"
      :empty="alerts.alerts.length === 0"
      empty-text="当前筛选条件下没有预警。系统在监测到温度超标、信号中断等情况时会自动记录。"
      @retry="load"
    >
      <article
        v-for="a in alerts.alerts"
        :key="a.id"
        class="alert"
        :class="[
          `alert--${a.severity}`,
          { 'alert--done': a.acknowledged_at !== null },
        ]"
      >
        <header class="alert__head">
          <el-tag
            :type="ALERT_SEVERITY_TAG[a.severity as AlertSeverity]"
            size="small"
            effect="dark"
          >
            {{ ALERT_SEVERITY_LABEL[a.severity as AlertSeverity] }}
          </el-tag>
          <span class="alert__kind">{{ ALERT_KIND_LABEL[a.kind] }}</span>

          <el-tag
            v-if="a.acknowledged_at"
            size="small"
            type="info"
            effect="plain"
          >
            已处理
          </el-tag>

          <span class="alert__spacer" />
          <span class="alert__time" :title="formatDateTime(a.occurred_at)">
            {{ formatRelative(a.occurred_at) }}
          </span>
        </header>

        <p v-if="a.message" class="alert__message">{{ a.message }}</p>

        <!-- 实测值与阈值一起显示，否则"48.5"这个数字没有参照 -->
        <p v-if="a.value !== null" class="alert__value">
          实测 <strong>{{ a.value }}</strong>
          <span v-if="a.threshold !== null">／ 阈值 {{ a.threshold }}</span>
        </p>

        <p class="alert__advice">{{ ALERT_KIND_ADVICE[a.kind] }}</p>

        <footer class="alert__actions">
          <el-button
            size="small"
            :type="a.acknowledged_at ? 'default' : 'primary'"
            :loading="busyId === a.id"
            @click="toggleAck(a)"
          >
            {{ a.acknowledged_at ? '取消已读' : '标记已读' }}
          </el-button>
          <el-button
            size="small"
            type="danger"
            plain
            :disabled="busyId === a.id"
            @click="remove(a)"
          >
            删除
          </el-button>
        </footer>
      </article>
    </StateBlock>
  </div>
</template>

<style scoped>
.alerts {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

/* ---------- 筛选栏 ---------- */
.filterbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.filterbar__spacer {
  flex: 1;
}

/* ---------- 预警卡片 ---------- */
.alert {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-left: 4px solid var(--ink-200);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.alert + .alert {
  margin-top: 12px;
}

.alert--info {
  border-left-color: var(--brand-700);
}

.alert--warning {
  border-left-color: var(--warn);
}

.alert--critical {
  border-left-color: var(--danger);
  background: var(--danger-bg);
}

/* 已处理的整体弱化，让未处理的在列表里跳出来 */
.alert--done {
  opacity: 0.62;
}

.alert__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.alert__kind {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-800);
}

.alert__spacer {
  flex: 1;
}

.alert__time {
  font-size: 12px;
  color: var(--ink-300);
}

.alert__message {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  color: var(--ink-800);
}

.alert__value {
  margin: 0;
  font-size: 13px;
  color: var(--ink-600);
  font-variant-numeric: tabular-nums;
}

.alert__value strong {
  color: var(--ink-800);
  font-size: 15px;
}

.alert__advice {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--r-sm);
  background: var(--surface-sunken);
  font-size: 12px;
  line-height: 1.75;
  color: var(--ink-400);
}

.alert__actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
</style>
