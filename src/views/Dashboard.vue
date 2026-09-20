<script setup lang="ts">
// ============================================================================
// 概览首页
// ============================================================================
// 三块内容：当前状态的核心指标、传感器性能参数、常用功能入口。
// 指标走真实数据（RLS 决定范围），性能参数是计划书里的静态指标。
// ============================================================================
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'

import { PERFORMANCE_METRICS, PROJECT } from '@/constants/project'
import { formatRelative } from '@/lib/format'
import { useAlertStore } from '@/stores/alert'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'

const user = useUserStore()
const sessions = useSessionStore()
const alerts = useAlertStore()
const devices = useDeviceStore()

const loading = ref(true)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

/** 核心指标卡片 */
interface MetricCard {
  key: string
  label: string
  value: string
  unit: string
  hint: string
  /** danger 用于需要立刻关注的状态 */
  tone?: 'default' | 'danger' | 'ok'
  to?: RouteLocationRaw
}

const cards = computed<MetricCard[]>(() => {
  const alertCount = alerts.unacknowledgedTotal

  return [
    {
      key: 'today',
      label: '今日训练',
      value: loading.value ? '—' : String(sessions.todayTotal),
      unit: '次',
      hint: sessions.latest
        ? `最近一次 ${formatRelative(sessions.latest.started_at)}`
        : '还没有训练记录',
      to: { name: 'assessment' },
    },
    {
      key: 'alerts',
      label: '未处理预警',
      value: loading.value ? '—' : String(alertCount),
      unit: '条',
      hint: alertCount > 0 ? '需要关注' : '暂无异常',
      tone: alertCount > 0 ? 'danger' : 'ok',
    },
    {
      key: 'devices',
      label: '在线设备',
      value: loading.value ? '—' : `${devices.onlineCount}`,
      unit: `/ ${devices.devices.length} 台`,
      hint: devices.devices.length
        ? '传感器运行正常'
        : '尚未绑定设备',
      to: { name: 'devices' },
    },
    {
      key: 'last',
      label: '最近训练',
      value: loading.value ? '—' : formatRelative(sessions.latest?.started_at),
      unit: '',
      hint: sessions.latest
        ? `${sessions.latest.exercise} · ${sessions.latest.rep_count ?? '—'} 次`
        : '开始第一次训练吧',
      to: { name: 'analysis' },
    },
  ]
})

/** 快速入口 */
const entries = [
  {
    to: { name: 'monitor' },
    title: '实时监测',
    detail: '查看传感器应变与温度双通道的实时信号',
  },
  {
    to: { name: 'assessment' },
    title: '康复评估',
    detail: '本次训练的动作识别结果、置信度与关节活动度',
  },
  {
    to: { name: 'analysis' },
    title: '数据分析',
    detail: '关节活动度趋势、训练依从性与预警分布',
  },
  {
    to: { name: 'devices' },
    title: '我的设备',
    detail: '绑定传感器、查看在线状态与电量',
  },
] as const

onMounted(async () => {
  try {
    // 三个请求互不依赖，并发发出
    await Promise.all([
      sessions.fetch({ limit: 20 }),
      sessions.fetchTodayCount(),
      alerts.fetchUnacknowledgedCount(),
      devices.fetchAll(),
    ])
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="dash">
    <!-- 欢迎 -->
    <header class="dash__welcome">
      <h1 class="dash__hello">
        {{ greeting }}，{{ user.displayName || '访客' }}
      </h1>
      <p class="dash__subtitle">{{ PROJECT.subtitle }}</p>
    </header>

    <!-- 核心指标 -->
    <section class="dash__cards">
      <component
        :is="card.to ? RouterLink : 'div'"
        v-for="card in cards"
        :key="card.key"
        :to="card.to"
        class="card"
        :class="[`card--${card.tone ?? 'default'}`, { 'card--link': card.to }]"
      >
        <span class="card__label">{{ card.label }}</span>
        <p class="card__value">
          <span class="card__number">{{ card.value }}</span>
          <span v-if="card.unit" class="card__unit">{{ card.unit }}</span>
        </p>
        <span class="card__hint">{{ card.hint }}</span>
      </component>
    </section>

    <!-- 传感器性能 -->
    <section class="dash__section">
      <div class="dash__section-head">
        <h2 class="dash__section-title">传感器核心性能</h2>
        <RouterLink to="/about" class="dash__more">技术详情 →</RouterLink>
      </div>

      <div class="metrics">
        <div
          v-for="m in PERFORMANCE_METRICS"
          :key="m.label"
          class="metric"
          :class="{ 'metric--highlight': m.highlight }"
        >
          <span class="metric__label">{{ m.label }}</span>
          <p class="metric__value">
            <span class="metric__number">{{ m.value }}</span>
            <span v-if="m.unit" class="metric__unit">{{ m.unit }}</span>
          </p>
          <span v-if="m.note" class="metric__note">{{ m.note }}</span>
        </div>
      </div>
    </section>

    <!-- 快速入口 -->
    <section class="dash__section">
      <h2 class="dash__section-title">快速入口</h2>

      <div class="entries">
        <RouterLink
          v-for="entry in entries"
          :key="entry.title"
          :to="entry.to"
          class="entry"
        >
          <span class="entry__title">{{ entry.title }}</span>
          <span class="entry__detail">{{ entry.detail }}</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ---------- 欢迎 ---------- */
.dash__hello {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: #303133;
}

.dash__subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #909399;
}

/* ---------- 指标卡片 ---------- */
.dash__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 20px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.card--link:hover {
  border-color: #c6dfff;
  box-shadow: 0 4px 12px rgb(64 158 255 / 12%);
  transform: translateY(-1px);
}

.card--danger {
  border-color: #fbc4c4;
  background: #fef6f6;
}

.card--ok {
  border-color: #d9ecff;
}

.card__label {
  font-size: 13px;
  color: #909399;
}

.card__value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
}

.card__number {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.2;
  color: #303133;
  font-variant-numeric: tabular-nums;
}

.card--danger .card__number {
  color: #f56c6c;
}

.card__unit {
  font-size: 13px;
  color: #909399;
}

.card__hint {
  font-size: 12px;
  color: #a8abb2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 分区 ---------- */
.dash__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dash__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.dash__section-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.dash__more {
  font-size: 13px;
  color: #409eff;
  text-decoration: none;
}

.dash__more:hover {
  text-decoration: underline;
}

/* ---------- 性能指标 ---------- */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.metric--highlight {
  border-color: #d9ecff;
  background: linear-gradient(180deg, #f5faff 0%, #fff 100%);
}

.metric__label {
  font-size: 12px;
  color: #909399;
}

.metric__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin: 0;
}

.metric__number {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  font-variant-numeric: tabular-nums;
}

.metric--highlight .metric__number {
  color: #2b7de9;
}

.metric__unit {
  font-size: 12px;
  color: #909399;
}

.metric__note {
  font-size: 11px;
  line-height: 1.5;
  color: #a8abb2;
}

/* ---------- 快速入口 ---------- */
.entries {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.entry {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  text-decoration: none;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.entry:hover {
  border-color: #c6dfff;
  box-shadow: 0 4px 12px rgb(64 158 255 / 12%);
  transform: translateY(-1px);
}

.entry__title {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.entry__detail {
  font-size: 12px;
  line-height: 1.6;
  color: #909399;
}
</style>
