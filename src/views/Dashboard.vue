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
import { computed, onMounted, ref, watch, type Component } from 'vue'
import { RouterLink } from 'vue-router'

import {
  ArrowRight,
  ChevronDown,
  ClipboardList,
  Lightbulb,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-vue-next'

import AiPanel from '@/components/AiPanel.vue'
import DemoNotice from '@/components/DemoNotice.vue'
import RiskBadge from '@/components/RiskBadge.vue'
import StateBlock from '@/components/StateBlock.vue'
import { buildInsightContext } from '@/lib/aiContext'
import { buildDemoAlerts, buildDemoSessions } from '@/lib/demoData'
import { useCountUp } from '@/composables/useCountUp'
import {
  buildInsight,
  type Insight,
  type SummaryCard,
  type SummaryIcon,
} from '@/lib/insight'
import { SCORE_DISCLAIMER } from '@/lib/scoreConfig'
import { useAiStore } from '@/stores/ai'
import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'

const user = useUserStore()
const sessions = useSessionStore()
const alerts = useAlertStore()
const devices = useDeviceStore()
const care = useCareStore()
const ai = useAiStore()

const loading = ref(true)
/** 「查看详细数据」是否展开。默认折叠 —— 家属要的结论在上面已经有了 */
const detailOpen = ref(false)

/**
 * 三张卡片各自的出口。
 *
 * 【为什么卡片需要链接】
 * 原先三张卡是纯展示 —— 家属看完了"恢复良好 80 分""皮肤温度偏高"
 * 之后**没有下一步可走**。整页唯一的出口藏在折叠区最底部的两行小字里，
 * 而那个折叠区默认是收起来的。
 *
 * 每张卡指向它自己那条线的详情：今天做了什么 → 去做评估；
 * 有没有危险 → 去看预警；该做什么 → 去看趋势。
 */
const CARD_LINK: Record<SummaryCard['key'], { to: string; text: string }> = {
  today: { to: '/assessment', text: '去做一次评估' },
  risk: { to: '/alerts', text: '查看预警记录' },
  advice: { to: '/analysis', text: '查看数据分析' },
}

/**
 * 图标标识 → 图标组件。
 *
 * 结论层（insight.ts）只给名字不给图形 —— 那一层是纯函数，跑在 node 里，
 * 碰不到 Vue。映射放在视图这一层。
 */
const CARD_ICON: Record<SummaryIcon, Component> = {
  clipboard: ClipboardList,
  'shield-check': ShieldCheck,
  'triangle-alert': TriangleAlert,
  lightbulb: Lightbulb,
}

/** 把调整量写成给人看的样子。负号用真正的减号 U+2212，不是连字符 */
function signed(n: number): string {
  if (n === 0) return ''
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`
}

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

/**
 * 交给 AI 的那份事实。
 *
 * ⚠️ 取的是 `insight` —— **页面正在显示的那一份**，演示态就是演示态。
 *    另算一份 realInsight 的话，AI 会对着和上面卡片不一样的数字讲话。
 *
 * 窗口写「本周」：insight 的窗口是 WINDOW_DAYS（7 天，含今天）。
 * ⚠️ 这和数据分析页的「近 7 天」**不是同一个窗口** —— 那一页是从 N 天前
 *    的零点起算的自然日区间。两页结论不一致是合理的，但说法要区分开，
 *    所以这里不写「近 7 天」。
 */
const aiContext = computed(() =>
  buildInsightContext(insight.value, {
    window: '本周',
    demo: usingDemo.value,
  }),
)

/**
 * 评分滚动的展示值。
 *
 * 只在**值发生变化**时滚 —— 首次加载直接落位。
 * 从 0 滚到 85 会读成"分数从 0 涨上来了"，而实际是"数据刚加载完"。
 */
const shownScore = useCountUp(computed(() => insight.value.score))

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
//
// 顺手清掉 AI 的结果：换了个人，上一份分析说的是**别人的数据**，
// 留着比没有更糟
watch(() => care.viewingPatientId, () => {
  ai.reset()
  void reload()
})

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
    <DemoNotice v-if="usingDemo">
      您还没有训练记录，下面用一组示例数据展示系统能给出什么样的结论。
      绑定传感器并完成第一次训练后，这里会自动换成您自己的数据。
    </DemoNotice>

    <!-- ================= 健康评分 ================= -->
    <section
      class="score"
      :class="loading ? 'score--loading' : `score--${insight.scoreBand}`"
      :aria-busy="loading"
    >
      <p class="score__label">本周恢复评分</p>

      <!-- 加载中 / 有分数 / 没数据，三种状态分开。
           ⚠️ 加载态**不能**掉进"没数据"那一支 —— 实测过它的后果：
           一个已有几百条记录的用户，每次打开首页都会先看到
           「还没有训练数据」加两个「绑定传感器」的按钮，
           等网络回来才换成真实分数。慢网下这一闪很明显。 -->
      <p v-if="loading" class="score__value score__value--empty">
        <span class="sk sk--num" />
      </p>
      <p
        v-else-if="insight.score !== null"
        class="score__value"
        :class="`score__value--${insight.scoreBand}`"
      >
        <span class="score__number">{{ shownScore }}</span>
        <span class="score__unit">分</span>
      </p>
      <p v-else class="score__value score__value--empty">— —</p>

      <!-- 档位。分数本身只是一个数，档位负责**解释它意味着什么** ——
           一个"完美但处在平台期"的患者拿到 85 分，单看数字家属会问
           "为什么不是 100"，配上「恢复良好 · 保持得很好」就不用解释了。

           ⚠️ 这里**不放风险角标**。原先放了一个，用的是风险词汇表
           （🟢正常 / 🟡需要注意 / 🔴需要处理，只有三档），而档位名用的是
           五档的评分词汇表，两套词挤在同一行会撞车 ——
           实测各分数段渲染出来是这样：

             95 分 → 「正常　恢复优秀」
             55 分 → 「需要处理　需要关注」
             30 分 → 「需要处理　需要处理」   ← 同一个词连着出现两遍

           而且"正常"是**风险**词汇，它在下面那张「有没有需要注意的」卡里
           表示"没有异常"，搬到评分行里意思就串了。
           分数的等级感由数字颜色 + 档位名承担已经够了，风险由那张卡负责。 -->
      <p v-if="!loading && insight.score !== null" class="score__level">
        <strong class="score__level-name">{{ insight.level.label }}</strong>
        <span class="score__level-detail">{{ insight.level.detail }}</span>
      </p>
      <p v-else-if="loading" class="score__level"><span class="sk sk--line" /></p>

      <p v-if="loading" class="score__headline"><span class="sk sk--line" /></p>
      <p v-else class="score__headline">{{ insight.headline }}</p>

      <!-- 分数被调整过就必须说明。悄悄改分是这个界面最不能做的事 ——
           家属会觉得"我没做错什么，分数怎么掉了"。
           ⚠️ 光说"已下调"不够：实测 demo 的 raw 94 → score 80，
           中间跨了一个档位（≥90 是"恢复优秀"、≥80 是"恢复良好"），
           展开详情看到 94 的人会问"那我到底是多少分"。所以带上金额。 -->
      <div v-if="!loading && insight.adjustments.length" class="score__adj">
        <p
          v-for="(adj, i) in insight.adjustments"
          :key="i"
          class="score__adj-item"
        >
          <TriangleAlert class="score__adj-icon" aria-hidden="true" />
          {{ adj.text }}
          <strong class="score__adj-delta">{{ signed(adj.delta) }}</strong>
        </p>
        <p v-if="insight.rawScore !== insight.score" class="score__adj-raw">
          调整前为 {{ insight.rawScore }} 分
        </p>
      </div>

      <!-- 无数据时给一条明确的出路，而不是让家属对着空白页发呆 -->
      <div v-if="!loading && !insight.stats.hasAnyData" class="score__cta">
        <RouterLink to="/devices" class="btn btn--primary">绑定传感器</RouterLink>
        <RouterLink to="/monitor" class="btn">先看看实时信号</RouterLink>
      </div>
    </section>

    <!-- ================= 三张家属语言卡片 ================= -->
    <section v-if="!loading" class="cards" aria-label="康复摘要">
      <article
        v-for="card in insight.cards"
        :key="card.key"
        class="fcard"
        :class="`fcard--${card.band}`"
      >
        <div class="fcard__head">
          <component :is="CARD_ICON[card.icon]" class="fcard__icon" aria-hidden="true" />
          <h2 class="fcard__title">{{ card.title }}</h2>
          <RiskBadge :band="card.band" dot size="sm" />
        </div>
        <p class="fcard__headline">{{ card.headline }}</p>
        <p v-if="card.detail" class="fcard__detail">{{ card.detail }}</p>
        <!-- 每张卡指向它自己那条线的详情。没有这一步，家属看完整页
             也不知道下一步该点哪里 -->
        <RouterLink :to="CARD_LINK[card.key].to" class="fcard__link">
          {{ CARD_LINK[card.key].text }}
          <ArrowRight class="fcard__arrow" aria-hidden="true" />
        </RouterLink>
      </article>
    </section>

    <!-- ================= AI 深度分析 =================
         放在三张家属语言卡片之后、「详细数据」折叠区**之前** ——
         符合这一页自己的层次：先结论、后解读、再明细。

         ⚠️ `:default-open="false"` 是刻意的。这一页是所有访客的落地页
            （路由把 '' 重定向到 dashboard），默认展开的话每个路过的人
            都会点一次，而每次都是一次计费。折叠着既保住了功能曝光
            （标题上写着「AI 深度分析」和「AI 生成」标签），又不会被
            误触烧掉额度。

         ⚠️ 卡片那边 `v-if="!loading"`，这里不加 —— 加载中时 context 里的
            分数是 null，面板会自己显示成"数据加载中"，不会显示一个
            像结论的东西。 -->
    <AiPanel :context="aiContext" :default-open="false" />

    <!-- ================= 折叠：详细数据 ================= -->
    <section class="detail">
      <button
        type="button"
        class="detail__toggle"
        :aria-expanded="detailOpen"
        @click="detailOpen = !detailOpen"
      >
        <span>{{ detailOpen ? '收起详细数据' : '查看详细数据' }}</span>
        <ChevronDown
          class="detail__chevron"
          :class="{ 'is-open': detailOpen }"
          aria-hidden="true"
        />
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
          「保持角度」而不是活动范围 —— 静蹲的活动范围天然只有几度；
          「进步情况」与之前两周比较，且用的是「未封顶」的完成度，
          所以达标之后继续进步也看得出来；历史记录少于 3 次时该项按"持平"
          计分，避免用两三次数据算出夸张的进步率。
        </p>

        <!-- ---------- 传感器技术指标：已移走 ----------
             这里原先有一整块「传感器技术指标」，铺开 PERFORMANCE_METRICS
             的全部参数。删掉它的理由很直接：**「关于」页已经有一份
             一模一样的**（那一节叫「传感器核心性能」，用的是同一个常量）。

             而且它本来就不属于这一页 —— 概览页讲的是"这一周这个人怎么样"，
             传感器灵敏度是设备本体的参数，对家属是噪音。
             折叠区里塞两种性质完全不同的内容，本身就是个错误。

             历史记录：这一块曾经有一句"打开专业模式还会显示波形、肌电 RMS 与
             传感器灵敏度曲线"的提示，而那三样当时一个都没实现 —— 等于在界面上
             写了句假话。专业模式后来整体撤掉了，这条留作记录：
             **写字面承诺之前先确认实现了没有。** -->
        <p class="detail__footnote">
          传感器的性能参数（灵敏度、检测范围、响应时间等）在
          <RouterLink to="/about" class="detail__link">关于</RouterLink>
          页；实时波形与原始信号在
          <RouterLink to="/monitor" class="detail__link">实时监测</RouterLink>
          页；本周的训练数据在
          <RouterLink to="/analysis" class="detail__link">数据分析</RouterLink>
          页。
        </p>

        <!-- ⚠️ 这句话必须留在界面上，不能只写在文档里。
             这个分数是从传感器数据算出来的**过程性指标**，不是经过信效度
             检验的临床量表（KOOS、Lysholm 那类有常模、有验证）。
             答辩时被问"这个分数验证过没有"，诚实的回答是"没有" ——
             界面上先写清楚反而是加分项，说成"类 KOOS 评分"会被当场问穿。
             文案在 lib/scoreConfig.ts 里，改那里。 -->
        <p class="detail__disclaimer">{{ SCORE_DISCLAIMER }}</p>
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

/* .demo* 的样式搬到了 components/DemoNotice.vue —— 分析页也要用同一套 */

/* ==========================================================================
   健康评分
   ==========================================================================
   整页最重要的一个数字。字号跟着 --fs-2xl 走，换算后约 46px。
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
  box-shadow: var(--shadow-card);
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

.score__level {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
  margin: 0;
}

.score__level-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.score__level-detail {
  font-size: var(--fs-sm);
  color: var(--ink-500);
}

/* ---------- 评分调整说明 ----------
   用中性偏警示的底，不用大红 —— 这是解释，不是警报 */
.score__adj {
  width: 100%;
  max-width: 36em;
  margin-top: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--r-sm);
  background: var(--warn-bg);
  text-align: left;
}

.score__adj-item {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--warn);
}

/* 与首行文字对齐：图标略小一圈，靠上对齐才不会显得吊在中间 */
.score__adj-icon {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  margin-top: 3px;
}

.score__adj-raw {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--ink-400);
}

/* ---------- 免责声明 ----------
   比脚注再弱一档：它是必要的法律/伦理声明，但不该抢注意力 */
.detail__disclaimer {
  margin: var(--sp-3) 0 0;
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--line);
  font-size: var(--fs-micro);
  line-height: var(--lh-loose);
  color: var(--ink-300);
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
  box-shadow: var(--shadow-card);
}

.fcard__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.fcard__icon {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  color: var(--ink-400);
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

/* 卡片的出口。贴在底部，三张卡高度不齐时也对得上 */
.fcard__link {
  margin-top: auto;
  padding-top: var(--sp-2);
  align-self: flex-start;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  color: var(--brand-700);
  text-decoration: none;
}

.fcard__link:hover {
  text-decoration: underline;
}

/* 箭头跟着文字走，垂在基线上 */
.fcard__arrow {
  width: 13px;
  height: 13px;
  vertical-align: -2px;
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
  box-shadow: var(--shadow-card);
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
  flex-shrink: 0;
  width: 16px;
  height: 16px;
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

/* ---------- 骨架屏 ----------
   加载期间占住位置，避免内容到位时整页跳动。
   只做轻微的呼吸，不做流光扫过 —— 那类动画在医疗界面上显得轻浮，
   而且这一屏大概率几百毫秒就过去了，动静越小越好。 */
.sk {
  display: block;
  border-radius: var(--r-sm);
  background: var(--line-soft);
  animation: sk-pulse 1.4s ease-in-out infinite;
}

.sk--num {
  width: 120px;
  height: 56px;
  margin: 0 auto;
}

.sk--line {
  width: 100%;
  max-width: 22em;
  height: 16px;
  margin: 0 auto;
}

@keyframes sk-pulse {
  50% {
    opacity: 0.5;
  }
}

/* 动效敏感的人不需要这段呼吸 —— 静态灰块一样能表达"正在加载" */
@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }
}

/* ---------- 调整金额 ---------- */
.score__adj-delta {
  margin-left: 4px;
  font-family: var(--font-num);
  font-weight: var(--fw-semibold);
  color: var(--ink-700);
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
