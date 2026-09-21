// ============================================================================
// 界面偏好：家属模式 / 专业模式
// ============================================================================
//
// 【为什么需要这个开关】
// 这套系统的使用者跨度极大：
//
//   家属（含老年人） —— 想知道"恢复得怎么样""有没有危险"，用手机看
//   医生 / 治疗师   —— 要看波形、RMS、达标曲线，坐在电脑前
//   工程师         —— 要看 GF、TCR、采样率（10 Hz）
//
// 硬把两种需求揉进一个界面，结果是家属被技术指标淹没、医生嫌留白太多。
//
// 【实现方式：换一个属性，整套令牌跟着换挡】
// 不是给每个组件写两套样式，而是在 <html> 上挂一个 data-view，
// tokens.css 里用 `html[data-view='family']` 整组覆盖字号与控件高度。
// 所有引用 var(--fs-*) 的地方自动跟着变，一处都不用改。
//
// 默认是**家属模式** —— 产品的第一读者是家属，这与"先让家属看懂，
// 再让医生看细，最后才是工程师看波形"的原则一致。
// ============================================================================

import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'fugan:pro-mode'

/** 读偏好。localStorage 在隐私模式下可能抛异常，所以包一层 */
export function readProMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 把模式写到 <html> 上。
 *
 * 必须在挂载**之前**调一次：晚一步的话，页面会先用紧凑字号渲染一帧，
 * 再跳成大字，肉眼能看到一次抖动。
 */
export function applyViewMode(pro: boolean): void {
  document.documentElement.dataset.view = pro ? 'pro' : 'family'
}

function persist(pro: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, pro ? '1' : '0')
  } catch {
    // 存不下也不影响本次使用，只是下次打开会退回默认值
  }
}

export const usePrefsStore = defineStore('prefs', () => {
  const proMode = ref(readProMode())

  function setProMode(on: boolean): void {
    proMode.value = on
    persist(on)
    applyViewMode(on)
  }

  function toggleProMode(): void {
    setProMode(!proMode.value)
  }

  return { proMode, setProMode, toggleProMode }
})
