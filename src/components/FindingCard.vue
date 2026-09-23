<script setup lang="ts">
// ============================================================================
// 一条结论
// ============================================================================
// 评估页和分析页都用它。**刻意做成共享组件而不是各写一份样式** ——
// 两边各写一份的话，改了红黄绿的配色只改一处，两页就会长得不一样，
// 而"同一个结论在不同页面上看起来是两个等级"是最容易被忽略的那种漂移。
//
// 本项目已经栽过一次同类问题：传感器参数同时铺在「关于」页和首页折叠区，
// 后来只改了其中一处。「关于」页那份还在，首页那份删掉时才发现。
//
// 结构固定三段，分别对着三类读者：
//
//   label     结论。**家属能读** —— 一句话说清怎么样
//   evidence  依据。**医生能核** —— 具体到数值，一行灰字
//   action    该做什么。给训练动作，不给治疗方案
//
// 「结论要简单，依据要完整」—— 与评分、与 findings 的注释是同一条原则。
// ============================================================================
import { computed } from 'vue'

import RiskBadge from './RiskBadge.vue'
import { BASIS_SEPARATOR } from '@/lib/aiReply'
import type { FindingLike } from '@/lib/findings'

// 收的是 FindingLike（label/band/evidence/action），不是完整的 Finding。
// 于是 AI 生成的那几条（lib/aiReply.ts 的 AiPoint）也能用这个组件渲染，
// 不必新做一个"看起来像外来控件"的卡片 —— 理由见 lib/findings.ts 里
// FindingLike 的注释。规则层的 Finding 是它的子类型，照传不误。
const props = defineProps<{ finding: FindingLike }>()

/**
 * 依据拆成逐条。
 *
 * ============================================================================
 * 【为什么要拆】
 * ============================================================================
 * AI 那条路径的 evidence 是**由若干条事实拼出来的**（模型只报编号，
 * 原文由 lib/aiReply.ts 用 BASIS_SEPARATOR 拼），一条结论可能带四条依据。
 * 拼成一整行是一坨灰字，实测读不下去 —— 用户的原话是"太死板了"。
 *
 * 拆成一行一条之后，同样是那些内容，但能读了。
 *
 * ⚠️ 规则层的 evidence **不含这个分隔符**，所以走下面那一支、照旧单行显示。
 *    实测规则层全部文案零命中。
 */
const evidenceParts = computed(() => {
  const { evidence } = props.finding
  if (!evidence.includes(BASIS_SEPARATOR)) return []
  return evidence.split(BASIS_SEPARATOR).filter(Boolean)
})
</script>

<template>
  <article class="finding" :class="`finding--${finding.band}`">
    <p class="finding__label">
      <RiskBadge :band="finding.band" dot size="sm" />
      <span>{{ finding.label }}</span>
    </p>
    <!-- 单条依据照旧一行；多条（AI 拼出来的）拆成列表 -->
    <p v-if="!evidenceParts.length" class="finding__evidence">{{ finding.evidence }}</p>
    <ul v-else class="finding__basis">
      <li v-for="(part, i) in evidenceParts" :key="i">{{ part }}</li>
    </ul>
    <p class="finding__action">{{ finding.action }}</p>
  </article>
</template>

<style scoped>
.finding {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 11px 14px;
  border-radius: var(--r-sm);
  /* 默认灰条，三档色由下面的修饰类覆盖 */
  border-left: 3px solid var(--ink-200);
  background: var(--surface-sunken);
}

.finding--red {
  border-left-color: var(--danger);
  background: var(--danger-bg);
}

.finding--yellow {
  border-left-color: var(--warn);
  background: var(--warn-bg);
}

.finding--green {
  border-left-color: var(--ok);
  background: var(--ok-bg);
}

.finding__label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--ink-800);
}

.finding__evidence {
  margin: 1px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

/* 多条依据：一行一条。小圆点而不是默认的圆点符号 —— 默认的太大，
   在一行小字里像着重号 */
.finding__basis {
  margin: 3px 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

.finding__basis li {
  position: relative;
  padding-left: 10px;
}

.finding__basis li::before {
  content: '·';
  position: absolute;
  left: 0;
  color: var(--ink-300);
}

.finding__action {
  margin: 3px 0 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  color: var(--ink-600);
}
</style>
