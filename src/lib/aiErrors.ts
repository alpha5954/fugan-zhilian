// ============================================================================
// AI 调用的错误 → 可读中文
// ============================================================================
// 【为什么需要单独一个模块，不能直接用 errors.ts 的 toMessage】
// `supabase.functions.invoke()` **不抛 HTTP 错误，而是把它返回**，而且
// `error.message` 是**英文**的：
//
//   FunctionsHttpError  → 'Edge Function returned a non-2xx status code'
//   FunctionsFetchError → 'Failed to send a request to the Edge Function'
//
// 而 toMessage() 对 Error 实例是直接透传 .message 的（见 lib/errors.ts:20），
// 所以**默认会违反这个仓库明写的规矩**：「整个界面都是中文，只有报错突然
// 变成英文，用户读不懂，也不知道下一步该干什么」（lib/errors.ts:44-47）。
//
// 所以这一类单独处理：把上游的错误码翻成中文，并且把"该做什么"一起说清楚。
// 与 authErrorInfo() 是同一套做法，理由也一样。
//
// ============================================================================
// 【两张表都导出，是给自检遍历的】
// ============================================================================
// lib/errors.ts 的 AUTH_CODE_MESSAGES 导出的理由写得很清楚：让 self-check 能
// **遍历整张表**验证每一条都是中文 —— 只挑几条来测的话，新加的条目漏翻了
// 英文也没人发现。这里照抄那个做法，见 scripts/check-ai.ts。
// ============================================================================

/**
 * Edge Function 自己返回的错误码 → 中文。
 *
 * 比按 HTTP 状态码翻更准：同样是 403，`forbidden`（权限）和别的原因要说的
 * 话完全不同；而 502 底下可能是模型名写错（`upstream_rejected`）也可能是
 * 服务真挂了（`upstream_error`），处理建议不一样。
 */
export const AI_ERROR_MESSAGES: Record<string, string> = {
  // —— 配置问题，用户自己能做的有限 ——
  not_configured: 'AI 服务还没有配置好，暂时无法使用',
  // —— 权限（将来收费后会出现）——
  forbidden: 'AI 深度分析是高级功能，当前账号还不能使用',
  // —— 请求本身有问题 ——
  bad_request: '这次要分析的数据格式不对，已跳过',
  too_large: '本次分析的数据量超出了上限',
  method: '请求方式不对，已跳过',
  // —— 上游 ——
  upstream_unreachable: 'AI 服务连接失败，请稍后重试',
  // ⚠️ 余额不足是**永久性**的，重试没有意义。所以文案里**不能**出现
  //    「请稍后重试」—— 那会让人一直点，一直失败
  insufficient_balance: 'AI 服务余额不足，暂时无法使用',
  rate_limited: 'AI 服务请求太频繁了，请等一会儿再试',
  // 多半是模型名配错了。让用户知道"这不该重试，该去查配置"
  upstream_rejected: 'AI 服务拒绝了这次请求，可能是模型配置有误',
  upstream_error: 'AI 服务出错了，请稍后重试',
  upstream_bad_json: 'AI 服务返回了无法解析的内容，请稍后重试',
  empty: 'AI 这次没有返回内容，请重试',
}

/**
 * `@supabase/functions-js` 那层包装错误的 name → 中文。
 *
 * ⚠️ 用 name 字符串匹配而不是 `instanceof` —— 不 import supabase-js 是为了
 *    让这个模块能被 node 直接 import（scripts/check-ai.ts 要遍历上面那张表）。
 *    代价是名字写错会静默落到兜底文案，所以下面那句兜底必须是可以接受的。
 */
export const AI_WRAPPER_MESSAGES: Record<string, string> = {
  FunctionsHttpError: 'AI 服务返回了错误',
  FunctionsRelayError: 'AI 服务暂时不可达，请稍后重试',
  // ⚠️ 这条文案是实测之后改的。
  //
  // 原先写的是「请检查网络后重试」—— 而**函数没部署时也是这条**。
  // 因为那时浏览器的 CORS 预检就失败了，请求根本没到函数，客户端看不到
  // 404，只能看到一个 fetch 失败。于是部署时把函数名打错的人会被告知
  // "检查你的网络"，去查一个跟网络毫无关系的问题。
  //
  // 所以文案里必须同时提到"可能没部署"这个可能性。
  FunctionsFetchError: '连不上 AI 服务：可能尚未部署，也可能是网络问题',
}

/** 全都没命中时的兜底 */
const FALLBACK = 'AI 分析暂时不可用，请稍后重试'

/**
 * 超时的判定。
 *
 * `invoke()` 的 timeout 超时会以 FunctionsFetchError 浮现，消息与普通网络
 * 失败一样（都是那句英文）。两者对用户的含义不同 —— 超时值得重试，而
 * "地址错了"重试多少次都一样 —— 所以用 abort 的痕迹区分。
 */
function looksLikeTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /abort|timeout|timed out/i.test(`${err.name} ${err.message}`)
}

/** 从包装错误上取 HTTP 状态码。context 是一个 Response */
function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const ctx = (err as Record<string, unknown>).context
  if (typeof ctx !== 'object' || ctx === null) return null
  const status = (ctx as Record<string, unknown>).status
  return typeof status === 'number' ? status : null
}

/** 从包装错误上读函数返回的错误码 */
async function codeOf(err: unknown): Promise<string | null> {
  if (typeof err !== 'object' || err === null) return null
  const ctx = (err as Record<string, unknown>).context
  if (typeof ctx !== 'object' || ctx === null) return null

  const json = (ctx as { json?: unknown }).json
  if (typeof json !== 'function') return null

  try {
    const body = await (json as () => Promise<unknown>).call(ctx)
    if (typeof body === 'object' && body !== null) {
      const code = (body as Record<string, unknown>).error
      if (typeof code === 'string' && code) return code
    }
  } catch {
    // 响应体不是 JSON（比如网关直接返回的 401 文本）。不是错误
  }
  return null
}

/**
 * 把任何一次 AI 调用失败翻成一句可读的中文。
 *
 * 判定顺序是**从具体到笼统**：函数自己的错误码最准，其次 HTTP 状态码，
 * 再次包装层的 name，最后兜底。
 */
export async function aiErrorInfo(err: unknown): Promise<string> {
  if (!err) return FALLBACK

  if (looksLikeTimeout(err)) return 'AI 响应超时，请稍后重试'

  // ① 函数自己给的错误码 —— 最准
  const code = await codeOf(err)
  if (code && AI_ERROR_MESSAGES[code]) return AI_ERROR_MESSAGES[code]

  // ② HTTP 状态码
  const status = statusOf(err)
  if (status === 401) return '登录状态已失效，请重新登录后再试'
  if (status === 402) return AI_ERROR_MESSAGES.insufficient_balance!
  if (status === 404) return 'AI 服务还没有部署，暂时无法使用'
  if (status === 429) return AI_ERROR_MESSAGES.rate_limited!
  if (status === 504) return AI_ERROR_MESSAGES.upstream_unreachable!

  // ③ 包装层的 name
  if (err instanceof Error && AI_WRAPPER_MESSAGES[err.name]) {
    return AI_WRAPPER_MESSAGES[err.name]!
  }

  return FALLBACK
}
