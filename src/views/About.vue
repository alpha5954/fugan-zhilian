<script setup lang="ts">
// ============================================================================
// 关于本项目
// ============================================================================
// 面向评审的项目介绍页。此页面无需登录即可访问。
//
// 内容分两块：项目本身（传感器技术路线、性能指标、应用场景），
// 以及这套软件系统（做了什么、数据从哪来、哪些环节已真实对接后端）。
// 后者刻意写得具体 —— 把模拟数据说成实测数据，在答辩时经不起追问。
// ============================================================================
import { ArrowRight } from 'lucide-vue-next'

import { RouterLink } from 'vue-router'

import {
  APPLICATION_SCENARIOS,
  PERFORMANCE_METRICS,
  PROJECT,
  TECH_HIGHLIGHTS,
} from '@/constants/project'

/** 各功能模块的数据来源，如实标注 */
const MODULE_STATUS = [
  { module: '账号注册与登录', source: 'Supabase Auth', real: true },
  { module: '设备绑定 / 解绑 / 固件状态', source: 'Supabase 数据库', real: true },
  { module: '训练记录保存（含波形）', source: 'Supabase 数据库', real: true },
  { module: '历史数据趋势与统计', source: 'Supabase 数据库', real: true },
  { module: '实时信号（应变 / 温度 / sEMG）', source: '内置模拟器', real: false },
  { module: '关节角度与动作识别', source: '内置模拟器', real: false },
  { module: '评估结论文本', source: '规则生成，非大模型', real: false },
] as const
</script>

<template>
  <div class="about">
    <!-- ================= 项目抬头 ================= -->
    <header class="hero">
      <p class="hero__badge">{{ PROJECT.competition }}</p>
      <h1 class="hero__title">{{ PROJECT.name }}</h1>
      <p class="hero__subtitle">{{ PROJECT.subtitle }}</p>
      <p class="hero__desc">{{ PROJECT.description }}</p>

      <dl class="hero__meta">
        <div class="hero__meta-item">
          <dt>命题企业</dt>
          <dd>{{ PROJECT.enterprise }}</dd>
        </div>
        <div class="hero__meta-item">
          <dt>应答命题</dt>
          <dd>{{ PROJECT.topic }}</dd>
        </div>
        <div class="hero__meta-item">
          <dt>参赛单位</dt>
          <dd>{{ PROJECT.university }}</dd>
        </div>
      </dl>
    </header>

    <!-- ================= 技术路线 ================= -->
    <section class="section">
      <h2 class="section__title">技术路线</h2>
      <div class="cards">
        <article v-for="t in TECH_HIGHLIGHTS" :key="t.title" class="card">
          <h3 class="card__title">{{ t.title }}</h3>
          <p class="card__detail">{{ t.detail }}</p>
        </article>
      </div>
    </section>

    <!-- ================= 核心性能 ================= -->
    <section class="section">
      <h2 class="section__title">传感器核心性能</h2>
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

    <!-- ================= 应用场景 ================= -->
    <section class="section">
      <h2 class="section__title">应用场景</h2>
      <div class="scenarios">
        <article
          v-for="s in APPLICATION_SCENARIOS"
          :key="s.title"
          class="scenario"
        >
          <header class="scenario__head">
            <h3 class="scenario__title">{{ s.title }}</h3>
            <el-tag v-if="s.implemented" size="small" type="success" effect="plain">
              本系统已覆盖
            </el-tag>
          </header>
          <p class="scenario__detail">{{ s.detail }}</p>
        </article>
      </div>
    </section>

    <!-- ================= 本系统说明 ================= -->
    <section class="section">
      <h2 class="section__title">关于这套系统</h2>

      <div class="notes">
        <p class="note">
          本系统是配套上述传感器的<strong>数据采集、评估与展示平台</strong>，
          覆盖从设备绑定、实时信号监测、康复动作评估到历史趋势分析的完整链路。
          前端为 Vue 3 + TypeScript 单页应用，后端使用 Supabase
          （PostgreSQL + Auth），通过行级安全策略（RLS）实现数据隔离 ——
          每位用户只能访问自己及自己监护对象的数据，权限边界由数据库保证，
          而非前端代码。
        </p>

        <p class="note note--warn">
          <strong>数据来源说明：</strong>传感器硬件尚未接入本系统，实时信号与
          动作识别结果由内置模拟器按传感器的实际参数生成（GF 5.68、TCR −1.04
          %·°C⁻¹），并非实测数据。模拟器复现了完整的物理耦合关系——原始信号
          = 应变分量 + 温度分量 + 测量噪声，因此四路信号之间的联动是真实的，
          但数值本身不代表任何一次真实测量。硬件接入后替换数据源即可，指标
          算法与图表逻辑无需改动。
        </p>
      </div>

      <table class="status-table">
        <thead>
          <tr>
            <th>功能模块</th>
            <th>数据来源</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in MODULE_STATUS" :key="m.module">
            <td>{{ m.module }}</td>
            <td class="muted">{{ m.source }}</td>
            <td>
              <el-tag
                size="small"
                :type="m.real ? 'success' : 'warning'"
                effect="plain"
              >
                {{ m.real ? '已对接后端' : '模拟数据' }}
              </el-tag>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ================= 入口 ================= -->
    <section class="cta">
      <p class="cta__text">系统功能需要登录后使用。</p>
      <RouterLink to="/login" class="cta__link">
        前往登录 / 注册
        <ArrowRight class="cta__arrow" aria-hidden="true" />
      </RouterLink>
    </section>
  </div>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 28px;
  max-width: 1000px;
  margin: 0 auto;
}

/* ---------- 抬头 ---------- */
.hero {
  padding: 28px 32px;
  background: linear-gradient(135deg, var(--brand-50) 0%, #fff 100%);
  border: 1px solid var(--brand-200);
  border-radius: var(--r-lg);
}

.hero__badge {
  display: inline-block;
  margin: 0 0 12px;
  padding: 3px 10px;
  border-radius: var(--r-full);
  background: var(--brand-100);
  color: var(--brand-800);
  font-size: 12px;
}

.hero__title {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--brand-800);
}

.hero__subtitle {
  margin: 8px 0 0;
  font-size: 15px;
  color: var(--ink-600);
}

.hero__desc {
  margin: 16px 0 0;
  font-size: 14px;
  line-height: 1.9;
  color: var(--ink-600);
}

.hero__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 24px 0 0;
  padding-top: 20px;
  border-top: 1px solid var(--brand-200);
}

.hero__meta-item dt {
  font-size: 12px;
  color: var(--ink-400);
}

.hero__meta-item dd {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--ink-800);
}

/* ---------- 分区 ---------- */
.section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section__title {
  margin: 0;
  padding-left: 10px;
  border-left: 3px solid var(--brand-700);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink-800);
}

/* ---------- 技术路线 ---------- */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}

.card {
  padding: 18px 20px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.card__title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--brand-800);
}

.card__detail {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-600);
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
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.metric--highlight {
  border-color: var(--brand-200);
  background: linear-gradient(180deg, var(--brand-50) 0%, var(--surface) 100%);
}

.metric__label {
  font-size: 12px;
  color: var(--ink-400);
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
  color: var(--ink-800);
  font-variant-numeric: tabular-nums;
}

.metric--highlight .metric__number {
  color: var(--brand-800);
}

.metric__unit {
  font-size: 12px;
  color: var(--ink-400);
}

.metric__note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-300);
}

/* ---------- 应用场景 ---------- */
.scenarios {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.scenario {
  padding: 16px 20px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.scenario__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.scenario__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-800);
}

.scenario__detail {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.85;
  color: var(--ink-600);
}

/* ---------- 说明 ---------- */
.notes {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.note {
  margin: 0;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  font-size: 13px;
  line-height: 1.9;
  color: var(--ink-600);
}

.note--warn {
  border-color: var(--warn-line);
  background: var(--warn-bg);
}

.note strong {
  color: var(--ink-800);
}

/* ---------- 状态表 ---------- */
.status-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.status-table th,
.status-table td {
  padding: 11px 16px;
  text-align: left;
  font-size: 13px;
  border-bottom: 1px solid var(--line-soft);
}

.status-table th {
  font-weight: 500;
  color: var(--ink-400);
  background: var(--surface-sunken);
}

.status-table tr:last-child td {
  border-bottom: none;
}

.status-table .muted {
  color: var(--ink-400);
}

/* ---------- 入口 ---------- */
.cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  background: var(--canvas);
  border-radius: var(--r-md);
  font-size: 13px;
  color: var(--ink-400);
}

/* 入口箭头。跟着文字走 */
.cta__arrow {
  width: 14px;
  height: 14px;
  vertical-align: -3px;
}

.cta__link {
  color: var(--brand-700);
  text-decoration: none;
}

.cta__link:hover {
  text-decoration: underline;
}
</style>
