<script setup lang="ts">
// ============================================================================
// 折叠开关
// ============================================================================
// 家属模式里反复出现同一个动作：把技术视图收起来，只留结论。
// 实时监测、康复评估、数据分析三页都要用，所以抽出来 ——
// 三份各写一遍的话，触控高度、箭头方向、aria 属性迟早会走散。
//
// 只管那个按钮，**不管被折叠的内容**：各页折叠的东西不一样
// （四路波形 / 相位环路 / 四张统计图），由调用方自己 v-if。
// ============================================================================
withDefaults(
  defineProps<{
    /** 当前是否已展开 */
    open: boolean
    /** 收起状态下显示的文字（此刻点了会展开） */
    label: string
    /** 展开状态下显示的文字。不传则用「收起」+ label 的默认写法 */
    openLabel?: string
  }>(),
  { openLabel: undefined },
)

defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="fold-toggle"
    :aria-expanded="open"
    @click="$emit('toggle')"
  >
    <span>{{ open ? (openLabel ?? `收起${label}`) : label }}</span>
    <span class="fold-toggle__chevron" :class="{ 'is-open': open }" aria-hidden="true">
      ▾
    </span>
  </button>
</template>

<style scoped>
.fold-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  /* 触控下限 44px，留了点余量 */
  min-height: 52px;
  padding: 0 var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
  font-family: inherit;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--brand-700);
  text-align: left;
  cursor: pointer;
}

.fold-toggle:hover {
  background: var(--brand-50);
}

.fold-toggle__chevron {
  display: inline-block;
  color: var(--ink-300);
  transition: transform 0.2s;
}

.fold-toggle__chevron.is-open {
  transform: rotate(180deg);
}
</style>
