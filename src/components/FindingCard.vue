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
import RiskBadge from './RiskBadge.vue'
import type { Finding } from '@/lib/findings'

defineProps<{ finding: Finding }>()
</script>

<template>
  <article class="finding" :class="`finding--${finding.band}`">
    <p class="finding__label">
      <RiskBadge :band="finding.band" dot size="sm" />
      <span>{{ finding.label }}</span>
    </p>
    <p class="finding__evidence">{{ finding.evidence }}</p>
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

.finding__action {
  margin: 3px 0 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  color: var(--ink-600);
}
</style>
