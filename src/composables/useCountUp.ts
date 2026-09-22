// ============================================================================
// 数字滚动
// ============================================================================
// 把一个会变的数字做成"滚"过去的效果，而不是硬切。
//
// 【为什么值得做】
// 摘要页那个大号评分是整页最重的信息。数据加载完之后直接从 "— —" 跳到
// "85"，眼睛是没准备的 —— 而且看不出"这个数是算出来的"。
// 滚动一下，观感完全不同，成本却很低。
//
// 【两个必须处理的细节】
//
// ① **必须尊重 prefers-reduced-motion**。前庭功能障碍的人对动画敏感，
//    系统里关掉动效之后这里不能还在滚。style.css 里那条全局
//    `@media (prefers-reduced-motion)` 只管得到 CSS 动画，
//    requestAnimationFrame 它管不着 —— 得自己判断。
//
// ② **不从 0 开始滚**。首次加载时数字本来就是空的，从 0 滚到 85
//    会让人以为"分数从 0 涨上来了"。首次直接赋值，只在**值发生变化**
//    时才滚 —— 那才是"数据更新了"的意思。
// ============================================================================

import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** 系统是否要求减少动态效果 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 把 source 的数值变化做成滚动动画。
 *
 * @param source   来源。null 表示"还没有数据"
 * @param duration 时长（毫秒）。默认 700 —— 再长就显得拖沓了
 * @returns 用于展示的数值 ref
 */
export function useCountUp(
  source: Ref<number | null>,
  duration = 700,
): Ref<number> {
  const shown = ref(source.value ?? 0)
  let raf = 0

  watch(
    source,
    (to, from) => {
      cancelAnimationFrame(raf)

      // 没有数据：直接归零，不滚
      if (to === null) {
        shown.value = 0
        return
      }

      // 首次拿到值（from === undefined），或者用户要求减少动效：直接落位。
      // ⚠️ 首次**不能**从 0 滚上来 —— 那读起来像"分数从 0 涨到了 85"
      if (from === undefined || from === null || prefersReducedMotion()) {
        shown.value = to
        return
      }

      if (from === to) return

      const startAt = performance.now()
      const delta = to - from

      const step = (now: number) => {
        const p = Math.min(1, (now - startAt) / duration)
        // ease-out cubic：起步快、收尾慢，读起来像"停下来"而不是"被截断"
        const eased = 1 - (1 - p) ** 3
        shown.value = Math.round(from + delta * eased)
        if (p < 1) raf = requestAnimationFrame(step)
      }

      raf = requestAnimationFrame(step)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => cancelAnimationFrame(raf))

  return shown
}
