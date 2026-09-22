<script setup lang="ts">
// ============================================================================
// 风险等级标识
// ============================================================================
// 家属看不懂"风险指数 0.73"，但看得懂一个黄灯。
//
// 【为什么用图标而不是 emoji】
// 原先用的是 🟢🟡🔴。换成 Lucide 的矢量图标有三个实际好处：
//
//   1. **跨平台一致**。emoji 由系统字体渲染，Windows / iOS / Android /
//      各家安卓 ROM 上同一个 🟡 大小、配色、边距都不一样，而且会跟着
//      系统版本变。矢量图标在哪都是同一张图。
//   2. **形状本身携带信息**。三档分别是 ✓ / △! / ✕ —— 色盲用户分辨不出
//      红绿，但分得出这三种形状。原先三个都是"圆"，只能靠颜色。
//   3. 不依赖 emoji 字体，离线或精简系统上不会退化成方块。
//
// 但**仍然不只靠颜色和形状**：每档都配了文字（"正常"/"需要注意"/
// "需要处理"），这一点在无障碍上是必须的。
// ============================================================================
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-vue-next'
import { computed, type Component } from 'vue'

import { BAND_LABEL, type RiskBand } from '@/lib/insight'

const props = withDefaults(
  defineProps<{
    band: RiskBand
    /** 只显示图标，不显示文字。用于空间紧张的角落 */
    dot?: boolean
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { dot: false, size: 'md' },
)

/**
 * 三档用三个**形状不同**的图标。
 *
 * ✓ 与 ✕ 一眼可辨；中间那档用三角形而不是圆形，因为"注意"不是
 * "好"或"坏"的中间值，它是一个性质不同的状态。
 */
const ICON: Record<RiskBand, Component> = {
  green: CircleCheck,
  yellow: TriangleAlert,
  red: CircleX,
}

const label = computed(() => BAND_LABEL[props.band])
</script>

<template>
  <span
    class="badge"
    :class="[`badge--${band}`, `badge--${size}`, { 'badge--dot': dot }]"
    :title="label"
  >
    <component :is="ICON[band]" class="badge__icon" aria-hidden="true" />
    <span v-if="!dot" class="badge__label">{{ label }}</span>
    <!-- 图标模式下形状和颜色对读屏软件都不存在，补一个文本 -->
    <span v-else class="sr-only">{{ label }}</span>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px 2px 7px;
  border-radius: var(--r-full);
  border: 1px solid transparent;
  font-weight: var(--fw-medium);
  line-height: 1.5;
  white-space: nowrap;
}

.badge--dot {
  padding: 0;
  border: none;
  background: none;
}

/* 跟着字号走。三档的图标尺寸必须完全一致 —— 差一点就会被读成
   "这一档比那一档更重要"，而重要性已经由颜色和形状表达了 */
.badge__icon {
  flex-shrink: 0;
  width: 1em;
  height: 1em;
  /* Lucide 默认 2，小字号下笔画偏细，加粗一档 */
  stroke-width: 2.4;
}

/* 图标模式（卡片、结论文里用）放大一档。
   原先这里是实心的彩色圆（🟢），换成描边图标之后视觉重量轻了不少，
   而这个角标是卡片上**唯一的风险信号** —— 原注释写的"家属一眼就能
   认出来"是它的核心要求，不能因为换了图标就丢了。
   实测 4 倍放大下笔画清晰，1.25em 是让它在原尺寸下也站得住的最小值。 */
.badge--dot .badge__icon {
  width: 1.25em;
  height: 1.25em;
}

/* ---------- 尺寸 ---------- */
.badge--sm {
  font-size: var(--fs-micro);
}

.badge--md {
  font-size: var(--fs-xs);
}

.badge--lg {
  font-size: var(--fs-sm);
  padding: 4px 13px 4px 10px;
}

/* ---------- 配色 ----------
   底色用语义色的浅色版（--ok-bg 等），文字用深色版。
   两者都是项目既有的令牌，不另造颜色。
   对比度都过 WCAG AA。 */
.badge--green {
  background: var(--ok-bg);
  border-color: var(--ok-line);
  color: var(--ok);
}

.badge--yellow {
  background: var(--warn-bg);
  border-color: var(--warn-line);
  color: var(--warn);
}

.badge--red {
  background: var(--danger-bg);
  border-color: var(--danger-line);
  color: var(--danger);
}

/* 读屏软件专用：视觉上不可见，但会被念出来 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
