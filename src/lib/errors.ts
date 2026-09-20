// ============================================================================
// 错误处理助手
// ============================================================================

/**
 * 把各种形态的错误统一成一句可读的中文提示。
 *
 * Supabase / PostgREST 的错误不是 Error 实例，而是 `{ message, details, hint, code }`
 * 这样的普通对象，直接 String() 出来是 "[object Object]"，所以不能偷懒。
 */
export function toMessage(err: unknown, fallback = '操作失败'): string {
  if (!err) return fallback

  if (typeof err === 'string') return err

  if (err instanceof Error) return err.message

  if (typeof err === 'object') {
    const e = err as Record<string, unknown>

    // PostgREST 错误：优先用 message，附上 hint 帮助定位
    const parts: string[] = []
    if (typeof e.message === 'string' && e.message) parts.push(e.message)
    if (typeof e.hint === 'string' && e.hint) parts.push(`（${e.hint}）`)

    if (parts.length) {
      // 带上错误码，方便对着 Supabase 文档查
      const code = typeof e.code === 'string' && e.code ? `[${e.code}] ` : ''
      return code + parts.join('')
    }
  }

  return fallback
}
