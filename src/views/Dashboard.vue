<script setup lang="ts">
// ============================================================================
// 健康摘要页（首页）
// ============================================================================
// 这是整个系统的第一屏，也是**唯一一屏家属一定会看**的页面。
//
// 【设计取向】
// 从"技术 Demo"改成"家属能看懂的康复摘要"：
//
//   改造前：今日训练 3 次 / 未处理预警 0 条 / 在线设备 1/1 台 / 最近训练 2 小时前
//   改造后：一个分数 + 三句话
//
// 前者的每一项都要家属自己换算成"那我该怎么办"，
// 后者直接告诉他：恢复得怎么样、有没有危险、该做什么。
//
// 【为什么分数可以展开】
// 一个孤零零的"82 分"是没法被信任的 —— 家属不知道它怎么来的，
// 医生更不会认。所以四个分量的算法与依据全部摊开在「详细数据」里，
// 每一项都能说清"是什么、怎么算、这次为什么是这个值"。
//
// 换言之：**结论要简单，依据要完整**。这两件事不矛盾。
// ============================================================================
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import RiskBadge from '@/components/RiskBadge.vue'
import StateBlock from '@/components/StateBlock.vue'
import { PERFORMANCE_METRICS } from '@/constants/project'
import { buildDemoAlerts, buildDemoSessions } from '@/lib/demoData'
import { buildInsight, type Insight } from '@/lib/insight'
import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'
import { useDeviceStore } from '@/stores/device'
import { usePrefsStore } from '@/stores/prefs'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'

const user = useUserStore()
const sessions = useSessionStore()
const alerts = useAlertStore()
const devices = useDeviceStore()
const care = useCareStore()
const prefs = usePrefsStore()

const loading = ref(true)
/** 「查看详细数据」是否展开。默认折叠 —— 家属要的结论在上面已经有了 */
const detailOpen = ref(false)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

/**
 * 拉取窗口要盖住"本周 + 基线"。
 *
 * 基线是本周之前的 14 天，所以最早要到 21 天前 —— 只取最近 20 条的话，
 * 一个训练频繁的患者可能连本周都凑不齐，进步度会永远显示"数据不够"。
 * 用时间下界而不是数量上限，才是按窗口取的。
 */
function windowStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - 21)
  return d
}

/** 真实数据的摘要 */
const realInsight = computed(() =>
  buildInsight(sessions.sessions, alerts.alerts),
)

/** 任一 store 出错就展示出来，不要让页面静静地显示成"没有记录" */
const loadError = computed(
  () => sessions.error ?? alerts.error ?? devices.error ?? null,
)

/**
 * 该展示演示数据吗：加载完了、没出错、而且一条记录都没有。
 *
 * 首次打开链接的人（评审、家属、队友）一定没有历史记录，而健康摘要页
 * 的价值完全建立在历史上。让他们看到一个空页面等于这套东西没做。
 */
const usingDemo = computed(
  () => !loading.value && !loadError.value && !realInsight.value.stats.hasAnyData,
)

/**
 * 演示摘要，算一次就缓存住。
 *
 * ⚠️ 刻意用普通变量而不是 ref。
 *    generateSession 要跑一遍信号模拟，放进 computed 每次渲染都重算太亏；
 *    但把缓存写成 ref、又在 computed 里读它，会形成"computed 写自己依赖的
 *    响应式变量"的回环。普通变量不参与响应式，没有这个问题。
 */
let demoCache: Insight | null = null
function demoInsight(): Insight {
  demoCache ??= buildInsight(buildDemoSessions(), buildDemoAlerts())
  return demoCache
}

/** 页面实际展示的那份摘要 */
const insight = computed(() =>
  usingDemo.value ? demoInsight() : realInsight.value,
)

async function reload() {
  loading.value = true
  try {
    // 并发发出。全部带上 patientId —— 家属的 RLS 范围是多个监护对象，
    // 不指定的话会把几个人的数据混在一起算成一个分数
    const pid = care.activePatientId
    await Promise.all([
      sessions.fetch({ limit: 300, patientId: pid, from: windowStart() }),
      alerts.fetch({ limit: 200, patientId: pid }),
      devices.fetchAll({ ownerId: pid }),
    ])
  } finally {
    loading.value = false
  }
}

// 切换查看对象后要重新拉数据。
// 监听 viewingPatientId（用户主动切换）而不是 activePatientId ——
// 后者在登录完成时也会变，会让首次加载多发一轮请求。
watch(() => care.viewingPatientId, reload)

onMounted(reload)
</script>

<template>
  <div class="home">
    <!-- ================= 问候 ================= -->
    <header class="hello">
      <h1 class="hello__text">{{ greeting }}，{{ user.displayName || '朋友' }}</h1>
      <p class="hello__sub">
        {{
          care.isViewingOther
            ? `下面是 ${care.activePatientName} 的康复情况`
            : '下面是您本周的康复情况'
        }}
      </p>
    </header>

    <StateBlock :error="loadError" @retry="reload" />

    <!-- ================= 演示数据声明 =================
         项目的一条底线是不把模拟数据说成实测数据（见 README「数据来源」）。
         演示数据同样适用：用了就必须明确标出来，而且要给出路 ——
         告诉用户怎么才能看到自己的真实数据 -->
    <aside v-if="usingDemo" class="demo" role="note">
      <span class="demo__tag">演示数据</span>
      <p class="demo__text">
        您还没有训练记录，下面用一组示例数据展示系统能给出什么样的结论。
        绑定传感器并完成第一次训练后，这里会自动换成您自己的数据。
      </p>
    </aside>

    <!-- ================= 健康评分 ================= -->
    <section class="score" :class="`score--${insight.scoreBand}`">
      <p class="score__label">本周恢复评分</p>

      <!-- 没数据时不显示 0 分 —— "0 分"和"还没有数据"是两件事，
           前者会让刚装上设备的家属以为出了大问题 -->
      <p
        v-if="insight.score !== null"
        class="score__value"
        :class="`score__value--${insight.scoreBand}`"
      >
        <span class="score__number">{{ insight.score }}</span>
        <span class="score__unit">分</span>
      </p>
      <p v-else class="score__value score__value--empty">— —</p>

      <!-- 风险单独一行，并且**写明它说的是"风险"**。
           分数和风险是两个不同的轴：可能恢复得很好但有一次温度超标。
           不加这个标签的话，家属会以为角标是在评价上面那个分数 ——
           实测截图里就出现过"92 分配橙色需要注意"这种自相矛盾的画面 -->
      <p class="score__risk">
        <span class="score__risk-label">本周风险</span>
        <RiskBadge :band="insight.band" size="md" />
      </p>

      <p class="score__headline">{{ insight.headline }}</p>

      <!-- 无数据时给一条明确的出路，而不是让家属对着空白页发呆 -->
      <div v-if="!insight.stats.hasAnyData" class="score__cta">
        <RouterLink to="/devices" class="btn btn--primary">绑定传感器</RouterLink>
        <RouterLink to="/monitor" class="btn">先看看实时信号</RouterLink>
      </div>
    </section>

    <!-- ================= 三张家属语言卡片 ================= -->
    <section class="cards" aria-label="康复摘要">
      <article
        v-for="card in insight.cards"
        :key="card.key"
        class="fcard"
        :class="`fcard--${card.band}`"
      >
        <div class="fcard__head">
          <span class="fcard__icon" aria-hidden="true">{{ card.icon }}</span>
          <h2 class="fcard__title">{{ card.title }}</h2>
          <RiskBadge :band="card.band" dot size="sm" />
        </div>
        <p class="fcard__headline">{{ card.headline }}</p>
        <p v-if="card.detail" class="fcard__detail">{{ card.detail }}</p>
      </article>
    </section>

    <!-- ================= 折叠：详细数据 ================= -->
    <section class="detail">
      <button
        type="button"
        class="detail__toggle"
        :aria-expanded="detailOpen"
        @click="detailOpen = !detailOpen"
      >
        <span>{{ detailOpen ? '收起详细数据' : '查看详细数据' }}</span>
        <span class="detail__chevron" :class="{ 'is-open': detailOpen }" aria-hidden="true">
          ▾
        </span>
      </button>

      <div v-if="detailOpen" class="detail__body">
        <!-- ---------- 评分是怎么算出来的 ---------- -->
        <h3 class="detail__title">评分是怎么算出来的</h3>
        <p class="detail__note">
          总分由下面四项加权得出，每一项都能单独核对。
        </p>

        <ul class="parts">
          <li v-for="part in insight.parts" :key="part.key" class="part">
            <div class="part__head">
              <span class="part__label">{{ part.label }}</span>
              <span class="part__weight">占 {{ Math.round(part.weight * 100) }}%</span>
              <span class="part__score">{{ Math.round(part.value * 100) }}</span>
            </div>
            <div
              class="part__bar"
              role="img"
              :aria-label="`${part.label} ${Math.round(part.value * 100)} 分`"
            >
              <span
                class="part__fill"
                :style="{ width: `${Math.round(part.value * 100)}%` }"
              />
            </div>
            <p class="part__detail">{{ part.detail }}</p>
          </li>
        </ul>

        <p class="detail__footnote">
          「动作达标」按各动作自己的康复目标判定，静力动作（靠墙静蹲）看的是
          保持角度、不参与该项；「进步情况」与之前两周比较；历史记录少于 3 次时
          该项按"持平"计分，避免用两三次数据算出夸张的进步率。
        </p>

        <!-- ---------- 技术指标（专业模式） ----------
             家属模式下这一整块收起，只留一句说明。
             ⚠️ 文案必须**如实描述**这里到底藏了什么 —— 早先版本写着
                "还会显示波形、肌电 RMS 与传感器灵敏度曲线"，而那三样
                当时一个都没实现，等于在界面上写了句假话。
                加指标的时候要记得同步这句话。 -->
        <h3 class="detail__title">传感器技术指标</h3>

        <template v-if="prefs.proMode">
          <p class="detail__note">
            以下为传感器本体的性能参数，面向工程师与设备评估，不是本周的训练数据。
          </p>
          <dl class="tech">
            <div v-for="m in PERFORMANCE_METRICS" :key="m.label" class="tech__item">
              <dt class="tech__label">{{ m.label }}</dt>
              <dd class="tech__value">
                {{ m.value }}<span v-if="m.unit" class="tech__unit">{{ m.unit }}</span>
              </dd>
              <p v-if="m.note" class="tech__note">{{ m.note }}</p>
            </div>
          </dl>
        </template>

        <!-- 家属模式下给一句解释，而不是直接不显示 ——
             医生第一次来看不到会以为系统没做 -->
        <p v-else class="detail__note">
          应变灵敏度（GF）、温度灵敏度、循环耐久性等指标面向工程师，
          家属模式下默认收起。
          <button type="button" class="detail__link" @click="prefs.setProMode(true)">
            打开专业模式
          </button>
        </p>

        <p class="detail__footnote">
          实时波形与原始信号在
          <RouterLink to="/monitor" class="detail__link">实时监测</RouterLink>
          页，本周的训练数据在
          <RouterLink to="/analysis" class="detail__link">数据分析</RouterLink>
          页。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

/* ==========================================================================
   问候
   ========================================================================== */
.hello__text {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.hello__sub {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--ink-500);
}

/* ==========================================================================
   演示数据声明
   ==========================================================================
   做成中性的信息条而不是警告条：这不是错误，只是要如实说明数据来源。
   ========================================================================== */
.demo {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--info-line);
  border-radius: var(--r-md);
  background: var(--info-bg);
}

.demo__tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--r-xs);
  background: var(--brand-700);
  color: #fff;
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  line-height: 1.7;
  white-space: nowrap;
}

.demo__text {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-loose);
  color: var(--ink-600);
}

/* ==========================================================================
   健康评分
   ==========================================================================
   整页最重要的一个数字。字号跟着令牌走：家属模式 34×1.9 ≈ 65px，
   专业模式 24×1.9 ≈ 46px —— 一套写法两种密度。
   ========================================================================== */
.score {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-8) var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  /* 左侧一道色条表达风险等级。不用整块底色 —— 大面积的饱和色
     会让页面显得惊惶，而这道条足够传达信息 */
  border-left: 5px solid var(--line-strong);
  border-radius: var(--r-md);
  text-align: center;
}

/* 色条跟**评分**的等级，不跟风险。
   这张卡讲的就是评分，旁边再摆一个绿色的 95 分和橙色的条，仍然别扭 ——
   实测截图里确认过。风险由下面那个写明"本周风险"的角标表达。 */
.score--green {
  border-left-color: var(--ok);
}

.score--yellow {
  border-left-color: var(--warn);
}

.score--red {
  border-left-color: var(--danger);
}

.score__label {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--ink-500);
  letter-spacing: 0.5px;
}

.score__value {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0;
  line-height: 1;
}

.score__number {
  font-family: var(--font-num);
  font-size: calc(var(--fs-2xl) * 1.9);
  font-weight: var(--fw-semibold);
  letter-spacing: -1px;
}

/* 数字的颜色跟着**评分自己的等级**走，不跟风险等级。
   两者的区别见 lib/insight.ts 里 Insight.band 的注释 */
.score__value--green .score__number {
  color: var(--ok);
}

.score__value--yellow .score__number {
  color: var(--warn);
}

.score__value--red .score__number {
  color: var(--danger);
}

.score__value--empty {
  color: var(--ink-200);
  font-size: calc(var(--fs-2xl) * 1.2);
  letter-spacing: 4px;
}

.score__unit {
  font-size: var(--fs-lg);
  color: var(--ink-400);
}

.score__risk {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
}

.score__risk-label {
  font-size: var(--fs-xs);
  color: var(--ink-400);
}

.score__headline {
  margin: 0;
  max-width: 34em;
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  color: var(--ink-700);
}

.score__cta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}

/* 触控目标 ≥44px —— WCAG 2.1 AA。家属里老年用户多，
   手指定位精度本来就差一些 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--sp-5);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-700);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  text-decoration: none;
  transition: background-color 0.15s, border-color 0.15s;
}

.btn:hover {
  background: var(--surface-sunken);
  text-decoration: none;
}

.btn--primary {
  background: var(--brand-700);
  border-color: var(--brand-700);
  color: #fff;
}

.btn--primary:hover {
  background: var(--brand-800);
}

/* ==========================================================================
   三张家属语言卡片
   ========================================================================== */
.cards {
  display: grid;
  /* 手机一列、宽屏三列。家属大概率用手机，一屏一个重点是刻意的 */
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--sp-4);
}

.fcard {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.fcard__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.fcard__icon {
  font-size: var(--fs-lg);
  line-height: 1;
}

.fcard__title {
  flex: 1;
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--ink-500);
}

.fcard__headline {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  line-height: var(--lh-base);
  color: var(--ink-800);
}

.fcard__detail {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

/* 红黄两档给整张卡一道左色条。绿档不给 —— 一切都好时不需要被强调 */
.fcard--yellow {
  border-left: 4px solid var(--warn);
}

.fcard--red {
  border-left: 4px solid var(--danger);
}

/* ==========================================================================
   折叠：详细数据
   ========================================================================== */
.detail {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}

.detail__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  /* 44px 触控下限 */
  min-height: 52px;
  padding: 0 var(--sp-5);
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--brand-700);
  cursor: pointer;
  text-align: left;
}

.detail__toggle:hover {
  background: var(--brand-50);
}

.detail__chevron {
  display: inline-block;
  font-size: var(--fs-md);
  color: var(--ink-300);
  transition: transform 0.2s;
}

.detail__chevron.is-open {
  transform: rotate(180deg);
}

.detail__body {
  padding: var(--sp-2) var(--sp-5) var(--sp-5);
  border-top: 1px solid var(--line-soft);
}

.detail__title {
  margin: var(--sp-4) 0 var(--sp-2);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.detail__note {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-xs);
  line-height: var(--lh-loose);
  color: var(--ink-400);
}

.detail__footnote {
  margin: var(--sp-4) 0 0;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  line-height: var(--lh-loose);
  color: var(--ink-400);
}

.detail__link {
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  font-size: inherit;
  color: var(--brand-700);
  text-decoration: underline;
  cursor: pointer;
}

/* ---------- 评分构成 ---------- */
.parts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.part__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-bottom: 5px;
}

.part__label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--ink-700);
}

.part__weight {
  padding: 1px 6px;
  border-radius: var(--r-xs);
  background: var(--surface-sunken);
  font-size: var(--fs-micro);
  color: var(--ink-400);
}

.part__score {
  margin-left: auto;
  font-family: var(--font-num);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.part__bar {
  height: 8px;
  border-radius: var(--r-full);
  background: var(--surface-sunken);
  overflow: hidden;
}

.part__fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  background: var(--brand-500);
  transition: width 0.3s;
}

.part__detail {
  margin: 5px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

/* ---------- 技术指标 ---------- */
.tech {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--sp-4);
  margin: 0;
}

.tech__item {
  padding: var(--sp-3);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
  background: var(--surface-sunken);
}

.tech__label {
  font-size: var(--fs-xs);
  color: var(--ink-500);
}

.tech__value {
  margin: 3px 0 0;
  font-family: var(--font-num);
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.tech__unit {
  margin-left: 3px;
  font-size: var(--fs-xs);
  font-weight: var(--fw-normal);
  color: var(--ink-400);
}

.tech__note {
  margin: 4px 0 0;
  font-size: var(--fs-micro);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

/* ==========================================================================
   窄屏
   ========================================================================== */
@media (max-width: 640px) {
  .score {
    padding: var(--sp-6) var(--sp-4);
  }

  .score__cta {
    width: 100%;
    flex-direction: column;
  }

  .btn {
    width: 100%;
  }

  .cards {
    /* 一屏一个重点：手机上不并排，强制一列 */
    grid-template-columns: 1fr;
  }
}
</style>
