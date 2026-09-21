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

// ============================================================================
// 认证错误
// ============================================================================
// 上面的 toMessage 会把 Supabase 的原始 message 原样透出来，那些是英文的
// （"Invalid login credentials"、"Email not confirmed"）。整个界面都是中文，
// 只有报错突然变成英文，用户读不懂，也不知道下一步该干什么。
//
// 所以认证这一类单独处理：按错误码翻成中文，并且把"该做什么"一起说清楚 ——
// "邮箱未验证"本身不是解决办法，解决办法是"去收件箱点确认链接"。
// ============================================================================

/**
 * 错误码 → 中文。键是 Supabase AuthError 的 code 字段。
 *
 * 导出是为了让 self-check 能**遍历整张表**验证每一条都是中文 ——
 * 只挑几条来测的话，新加的条目漏翻了英文也没人发现。
 */
export const AUTH_CODE_MESSAGES: Record<string, string> = {
  invalid_credentials: '邮箱或密码不正确',
  email_not_confirmed: '邮箱还没有验证。请打开确认邮件里的链接，再回来登录',
  email_exists: '这个邮箱已经注册过了，直接登录即可',
  user_already_exists: '这个邮箱已经注册过了，直接登录即可',
  phone_exists: '这个手机号已经注册过了，直接登录即可',
  weak_password: '密码强度不足，换一个更难猜的',
  same_password: '新密码不能和当前密码相同',
  over_email_send_rate_limit:
    '邮件发送太频繁了。Supabase 对同一邮箱有频率限制，请等一会儿再试',
  over_request_rate_limit: '操作太频繁了，请等一会儿再试',
  over_sms_send_rate_limit: '短信发送太频繁了，请等一会儿再试',
  otp_expired: '链接已失效或已过期，请重新申请一封',
  user_not_found: '这个邮箱还没有注册过',
  session_not_found: '登录状态已失效，请重新登录',
  reauthentication_needed: '这个操作需要重新验证身份，请先退出再登录一次',
  email_address_invalid: '邮箱地址格式不正确',
  signup_disabled: '本站已关闭注册',
  email_provider_disabled: '本站已关闭邮箱注册',
  anonymous_provider_disabled: '本站已关闭访客模式，请直接注册账号',
  captcha_failed: '人机验证没通过，请重试',
  validation_failed: '填写的内容不符合要求，请检查后重试',
}

/**
 * 没有错误码时的兜底：按英文原文匹配。
 *
 * 少数情况下 Supabase 只回 message 不带 code（比如网络的失败、
 * 或者旧版本服务端），这时按文案匹配总比直接甩英文强。
 */
const AUTH_TEXT_MESSAGES: [match: string, message: string][] = [
  ['invalid login credentials', '邮箱或密码不正确'],
  ['email not confirmed', '邮箱还没有验证。请打开确认邮件里的链接，再回来登录'],
  ['user already registered', '这个邮箱已经注册过了，直接登录即可'],
  ['password should be at least', '密码太短了，至少要 8 位'],
  ['unable to validate email address', '邮箱地址格式不正确'],
  ['email link is invalid or has expired', '链接已失效或已过期，请重新申请一封'],
  ['token has expired or is invalid', '链接已失效或已过期，请重新申请一封'],
  ['for security purposes', '操作太频繁了，请等一会儿再试'],
  ['failed to fetch', '网络连接失败，请检查网络后重试'],
  ['networkerror', '网络连接失败，请检查网络后重试'],
  ['database error', '服务端出错了，请稍后重试'],
]

/** 取错误码。Supabase 的 AuthError 上是 `code`，PostgREST 上是 `code`，两边同名 */
function errorCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as Record<string, unknown>).code
  return typeof code === 'string' && code ? code : null
}

/**
 * 把认证错误翻成「可读的中文 + 错误码」。
 *
 * 之所以要把码一起返回，是因为界面有时候需要**针对某一类错误做额外的事**——
 * 典型的是 email_not_confirmed：光提示"去验证邮箱"没用，得顺手给一个
 * 「重新发送确认邮件」的按钮。
 */
export function authErrorInfo(
  err: unknown,
  fallback = '操作失败，请重试',
): { code: string | null; message: string } {
  const code = errorCodeOf(err)

  if (code && AUTH_CODE_MESSAGES[code]) {
    return { code, message: AUTH_CODE_MESSAGES[code] }
  }

  // 拿不到码，或者这个码不在表里 —— 退回按文案匹配
  const raw =
    typeof err === 'object' && err !== null
      ? String((err as Record<string, unknown>).message ?? '')
      : typeof err === 'string'
        ? err
        : ''

  const lower = raw.toLowerCase()
  for (const [needle, message] of AUTH_TEXT_MESSAGES) {
    if (lower.includes(needle)) return { code, message }
  }

  // 都没命中：用调用方给的中文兜底，把错误码缀在后面。
  // 不把英文原文透出来——用户读不懂，而错误码足够拿去对着文档查了
  return { code, message: code ? `${fallback}（${code}）` : fallback }
}
