// ============================================================================
// 全局错误处理
// ============================================================================
// 错误边界（components/ErrorBoundary.vue）只接渲染期的异常。还有两类它接不到：
//
//   1. 组件之外的同步异常 —— 比如某个 store action 里忘了 catch 的抛错
//   2. 未处理的 Promise 拒绝 —— 最常见的一类，比如 `void store.fetch()`
//      内部 reject 了但调用方没接
//
// 这两类不处理的话，轻则静默失败（用户以为操作成功了），重则整个应用停摆，
// 而且控制台之外没有任何迹象。
// ============================================================================

import type { App } from 'vue'

import { ElNotification } from 'element-plus'

import { toMessage } from '@/lib/errors'

/** 同一条错误在短时间内重复出现时只提示一次，避免刷屏 */
const recent = new Map<string, number>()
const DEDUPE_WINDOW_MS = 5000

function shouldReport(key: string): boolean {
  const now = Date.now()
  const last = recent.get(key)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
  recent.set(key, now)
  // 顺手清理过期项，避免 Map 无限增长
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_WINDOW_MS) recent.delete(k)
  }
  return true
}

function notify(title: string, err: unknown) {
  const message = toMessage(err, '未知错误')
  if (!shouldReport(`${title}|${message}`)) return

  console.error(`[全局错误] ${title}`, err)

  ElNotification({
    title,
    message,
    type: 'error',
    duration: 6000,
    position: 'bottom-right',
  })
}

export function installGlobalErrorHandlers(app: App): void {
  // ---- 1. Vue 组件内未捕获的异常 ----
  // 走到这里说明错误边界没接住（比如发生在根组件或布局自身）。
  // 设置 errorHandler 能阻止 Vue 把错误继续抛给 window.onerror，
  // 但**不能**阻止组件树被卸载 —— 那需要 errorCaptured。
  app.config.errorHandler = (err, _instance, info) => {
    notify('界面出现异常', `${toMessage(err, '未知错误')}（${info}）`)
  }

  // ---- 2. 未处理的 Promise 拒绝 ----
  window.addEventListener('unhandledrejection', (event) => {
    // Supabase 的鉴权刷新失败在网络抖动时很常见，且会自行重试，
    // 不值得每次都弹窗打扰用户
    const msg = toMessage(event.reason, '')
    if (/refresh token|token.*expired|network request failed/i.test(msg)) {
      console.warn('[全局错误] 忽略鉴权刷新类错误：', msg)
      return
    }
    notify('后台操作失败', event.reason)
  })

  // ---- 3. 其他同步异常 ----
  window.addEventListener('error', (event) => {
    // 资源加载失败（图片、字体）也会触发 error 事件，但没有 error 对象。
    // 那类问题不影响功能，不该弹窗
    if (!event.error) return
    notify('运行时错误', event.error)
  })
}
