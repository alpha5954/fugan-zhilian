// ============================================================================
// AI 深度分析 store
// ============================================================================
// 一次 AI 调用要 5~20 秒，而且**按量计费**。这两点决定了这个 store 的形状：
//
//   · 请求归 store 所有，不归组件 —— 组件卸载（切页面）不中断请求。
//     中断了钱也花了，却看不到结果；让请求跑完并缓存，回来就能直接看到。
//   · 同一份上下文只发一次。切筛选器、来回切页面都不该重复计费。
//
// ============================================================================
// ⚠️ 这个 store 里有一条**必须原样照抄**的教训
// ============================================================================
// src/stores/user.ts 的 ensureGuestSession 踩过一个坑，注释和 README 都记着：
//
//   `guestPromise ??= createGuestSession()` —— createGuestSession 失败时
//   返回 false 而不是抛异常，于是那个 false 被**永久缓存**下来。一次网络
//   抖动之后，这个访客在整页刷新之前再也进不去了。
//
// 这里的失败形态**一模一样**：AI 调用失败 → 结果是 null → 如果 null 被
// 缓存进 `cache`，那么只要上下文不变（key 就不变），**这个面板在整页刷新
// 之前再也点不出来了**，而且每一次重试都会直接命中缓存里的那个失败。
//
// 所以两条硬规矩：
//   ① **失败绝不写入 cache** —— 只有解析通过的结果才配被记住
//   ② **in-flight 槽在 finally 里清空**，成功失败都清
//
// scripts/check-ai.ts 有一条断言钉着这件事。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { AI_ERROR_MESSAGES, aiErrorInfo } from '@/lib/aiErrors'
import type { AiContext } from '@/lib/aiContext'
import { parseAiReply, type AiParseResult } from '@/lib/aiReply'
import { aiAccess, type AiPlan } from '@/lib/entitlements'
import { supabase } from '@/lib/supabase'

/** Edge Function 的名字。改这里要连带改 supabase/functions/ 下的目录名 */
const FUNCTION_NAME = 'ai-analysis'

/**
 * 客户端超时，比函数内部的 45 秒宽一档。
 *
 * 让**函数**先超时：那样用户拿到的是「AI 服务连接失败」这种能区分原因的话，
 * 而不是客户端一刀切掉的「超时」。这一层只是兜底，防止请求永远挂着。
 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * 单次会话的调用上限。
 *
 * ⚠️ 这是**防误触**，不是防滥用 —— 访客模式会给每个打开页面的人发一个合法
 *    JWT，所以任何人都能绕开界面直接调那个函数。真正兜底的是服务端：
 *    max_tokens 与上下文长度都封顶，单次成本有上界，最后一道闸是账户余额。
 *    这一条防的是"某个循环把按钮连点了三十次"。
 */
const MAX_CALLS_PER_SESSION = 30

export const useAiStore = defineStore('ai', () => {
  const loading = ref(false)
  /** 面板自己的失败态。**可重试**，且不影响页面上任何别的内容 */
  const error = ref<string | null>(null)
  /** 当前上下文的结果 */
  const result = ref<AiParseResult | null>(null)
  /** result 属于哪个上下文。与当前上下文不一致时不算命中 */
  const resultKey = ref<string | null>(null)

  /** 用户档位。还没有计费，所有人都是 free —— 见 lib/entitlements.ts */
  const plan = ref<AiPlan>('free')
  const access = computed(() => aiAccess(plan.value))

  /**
   * 只存一条。
   *
   * 照 src/lib/demoData.ts 尾部那个 `{ key, rows }` 的形状，不用无界 Map ——
   * lib/errorHandlers.ts 专门写过一个清理循环，就是因为无界的 Map 真的
   * 涨出过问题。
   */
  let cache: { key: string; value: AiParseResult } | null = null

  /** 在飞的请求。同一个上下文复用，不重复计费 */
  let inflight: { key: string; promise: Promise<void> } | null = null

  let calls = 0

  const dropped = computed(() => result.value?.dropped ?? 0)
  const analysis = computed(() => result.value?.analysis ?? null)

  /**
   * 发起一次分析。
   *
   * 用户主动触发，所以失败走 `opError` 的语义：**只把这个面板切成失败态，
   * 页面上别的内容原样留着**。绝不接回页面级的 loadError ——
   * lib/stores/care.ts:34-44 记录过混用两者的后果：解绑设备失败时整张表被
   * 替换成「加载失败」，用户以为数据没了。
   */
  async function analyze(ctx: AiContext): Promise<void> {
    if (!access.value.allowed) {
      error.value = access.value.reason
      return
    }

    // 上下文本身就是规范排序的对象，JSON 字符串**就是**稳定的 key。
    // 不发明 hash：那要么引一个纯模块依赖，要么用异步的 crypto.subtle
    const key = JSON.stringify(ctx)

    // 已经算过这个上下文 —— 直接落位，不发请求
    if (cache && cache.key === key) {
      result.value = cache.value
      resultKey.value = key
      error.value = null
      return
    }

    // 同一个上下文正在飞 —— 共用它，不再发一次
    if (inflight && inflight.key === key) return inflight.promise

    if (calls >= MAX_CALLS_PER_SESSION) {
      error.value = '本次使用中 AI 分析的次数已达上限，请刷新页面后重试'
      return
    }

    const promise = run(ctx, key)
    inflight = { key, promise }
    return promise
  }

  async function run(ctx: AiContext, key: string): Promise<void> {
    loading.value = true
    error.value = null
    calls++

    try {
      const { data, error: err } = await supabase.functions.invoke(FUNCTION_NAME, {
        body: { context: ctx },
        timeout: REQUEST_TIMEOUT_MS,
      })

      if (err) throw err

      const text = (data as { text?: unknown } | null)?.text
      if (typeof text !== 'string' || !text) {
        throw new Error(AI_ERROR_MESSAGES.empty)
      }

      // 三道闸门在这里执行。全部由 aiReply 负责 —— 它不知道数据是从
      // 网络来的，所以能被 node 直接断言
      const parsed = parseAiReply(text, ctx)

      // ★ 只有解析通过的结果才配进缓存。见文件头那个教训
      if (parsed.analysis) cache = { key, value: parsed }

      result.value = parsed
      resultKey.value = key
      // 全部被闸门拒掉是个合法结局：界面要说清"AI 这次的内容没通过校验"，
      // 而不是假装成功
      if (!parsed.analysis) error.value = parsed.reason
    } catch (e) {
      // ⚠️ 全部在这里吃掉。让它漏出去的话，全局 unhandledrejection 处理器
      //    的过滤正则匹配不到那句英文消息，会**额外**弹一个「后台操作失败」
      //    的通用 toast，和面板自己的提示叠在一起
      error.value = await aiErrorInfo(e)
      result.value = null
      resultKey.value = null
    } finally {
      loading.value = false
      // ★ 成功失败都要清，且只清自己那一格（可能已经被更新的请求顶掉了）
      if (inflight && inflight.key === key) inflight = null
    }
  }

  /** 切换查看对象 / 登出时调用。缓存和失败态一起清掉 */
  function reset(): void {
    cache = null
    inflight = null
    calls = 0
    result.value = null
    resultKey.value = null
    error.value = null
    loading.value = false
  }

  return {
    loading,
    error,
    result,
    resultKey,
    analysis,
    dropped,
    access,
    analyze,
    reset,
  }
})
