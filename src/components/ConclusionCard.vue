<script setup lang="ts">
// ============================================================================
// 结论卡
// ============================================================================
// 家属模式里每一页开头都会有这么一张卡：一个灯 + 一句话 + 一行补充。
//
// 康复评估和分析页用的是同一张，所以抽出来 —— 复制三遍的话，
// 色条宽度、字号、断行方式迟早会各走各的。
//
// 实时监测页的状态卡不在这里：它除了结论还要列四个状态项、带一个按钮，
// 形状不同，硬套这个组件反而要塞一堆插槽。
// ============================================================================
import RiskBadge from './RiskBadge.vue'
import type { RiskBand } from '@/lib/insight'

withDefaults(
  defineProps<{
    band: RiskBand
    /** 一句话结论。尽量短，家属扫一眼就要看到 */
    headline: string
    /** 补充说明，可以是空的 */
    detail?: string
  }>(),
  { detail: undefined },
)
</script>

<template>
  <section class="conclusion" :class="`conclusion--${band}`">
    <p class="conclusion__headline">
      <RiskBadge :band="band" dot size="lg" />
      <span>{{ headline }}</span>
    </p>
    <p v-if="detail" class="conclusion__detail">{{ detail }}</p>
    <!-- 有些页面要在结论下面再放点东西（数值、按钮） -->
    <slot />
  </section>
</template>

<style scoped>
.conclusion {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-5);
  background: var(--surface);
  border: 1px solid var(--line);
  /* 左侧一道色条表达风险等级。不用整块底色 —— 大面积饱和色会让
     页面显得惊惶，而这道条足够传达信息 */
  border-left: 5px solid var(--line-strong);
  border-radius: var(--r-md);
}

.conclusion--green {
  border-left-color: var(--ok);
}

.conclusion--yellow {
  border-left-color: var(--warn);
}

.conclusion--red {
  border-left-color: var(--danger);
}

.conclusion__headline {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-medium);
  line-height: var(--lh-base);
  color: var(--ink-800);
}

.conclusion__detail {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  color: var(--ink-500);
}

.conclusion__detail :deep(strong) {
  font-family: var(--font-num);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}
</style>
