<script setup lang="ts">
// ============================================================================
// 风险等级标识
// ============================================================================
// 家属看不懂"风险指数 0.73"，但看得懂一个黄灯。
//
// 用 emoji 圆点而不是 CSS 画的圆：跨平台一致（Windows / iOS / Android
// 的字体渲染差异会让 CSS 圆看起来忽大忽小），而且家属在手机通知里
// 一眼就能认出来。
//
// 但**不只靠颜色**：色盲用户分辨不出红绿。所以每档都配了文字
// （"正常"/"需要注意"/"需要处理"），这一点在无障碍上是必须的。
// ============================================================================
import { computed } from 'vue'

import { BAND_LABEL, type RiskBand } from '@/lib/insight'

const props = withDefaults(
  defineProps<{
    band: RiskBand
    /** 只显示圆点，不显示文字。用于空间紧张的角落 */
    dot?: boolean
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { dot: false, size: 'md' },
)

const DOT: Record<RiskBand, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
}

const label = computed(() => BAND_LABEL[props.band])
</script>

<template>
  <span
    class="badge"
    :class="[`badge--${band}`, `badge--${size}`, { 'badge--dot': dot }]"
    :title="label"
  >
    <span class="badge__dot" aria-hidden="true">{{ DOT[band] }}</span>
    <span v-if="!dot" class="badge__label">{{ label }}</span>
    <!-- 圆点模式下颜色不传达信息，补一个给读屏软件的文本 -->
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

.badge__dot {
  font-size: 0.85em;
  line-height: 1;
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
