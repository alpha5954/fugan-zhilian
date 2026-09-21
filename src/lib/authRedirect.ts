// ============================================================================
// 认证回跳地址，与「重置密码链接」的识别
// ============================================================================
//
// ⚠️ 这个模块**必须是 main.ts 里的第一个 import**，顺序不能动。
//
// 原因：Supabase 的邮件链接把令牌放在 URL 的 hash 里
// （#access_token=...&type=recovery），而 SDK 在解析完之后会把它清空
// ——源码里是一句 `window.location.hash = ''`。
//
// 那行清空发生在一次网络请求（_getUser）之后，所以"晚一点读"通常也来得及。
// 但那是**时序上的巧合，不是契约**：网络快的时候窗口就窄，SDK 换个版本
// 就可能挪位置。放在所有 import 之前同步读一次，就完全不依赖它的内部时序。
//
// 同一条规则也适用于错误分支：链接过期时 hash 里是 error_code 而不是令牌，
// 同样要抢在 SDK 清空之前读出来，否则页面只能显示一个空白的失败。
// ============================================================================

export type AuthCallback = {
  /** 是「重置密码」的邮件链接 */
  fromRecoveryLink: boolean
  /**
   * 链接自带的错误码。
   *
   * 链接过期或已被使用过时，Supabase 不回令牌，而是回一个 error_code ——
   * 常见的是 otp_expired。读出来，页面才能明说"链接已失效，请重新申请"，
   * 而不是把用户丢到首页让他自己猜为什么没反应。
   */
  errorCode: string | null
}

/**
 * 从一个 URL hash 里认出认证回调。
 *
 * 抽成纯函数是为了能测（scripts/check-auth.ts）—— 直接在模块顶层读
 * window.location 的话，这段逻辑就只能靠手点邮件来验证了。
 */
export function parseAuthCallback(hash: string): AuthCallback {
  const params = new URLSearchParams(
    hash.startsWith('#') ? hash.slice(1) : hash,
  )
  return {
    fromRecoveryLink: params.get('type') === 'recovery',
    errorCode: params.get('error_code'),
  }
}

// 模块求值时就抓下来（见文件开头关于 import 顺序的说明）。
// window 的判断是为了让这个模块在 node 下也能被导入，好让自检脚本
// 能直接调 parseAuthCallback —— 浏览器里永远走前一个分支。
const initial =
  typeof window === 'undefined'
    ? { fromRecoveryLink: false, errorCode: null }
    : parseAuthCallback(window.location.hash)

/** 本次页面加载是否来自「重置密码」邮件链接 */
export const fromRecoveryLink = initial.fromRecoveryLink

/** 回跳链接里带的错误码，没有则为 null */
export const authLinkError = initial.errorCode

/**
 * 认证邮件回跳地址的前缀，形如 `https://站点/fugan-zhilian/`。
 *
 * 必须是**绝对地址**：邮件是在浏览器之外打开的，相对路径无从解析。
 *
 * ⚠️ 这个值还要跟 Supabase 控制台 → Authentication → URL Configuration →
 *    Redirect URLs 里的白名单对得上。对不上时 Supabase 不会报错，而是
 *    **静默丢弃**它、改用站点的 Site URL —— 表现为本地测试正常、线上点
 *    邮件链接却跳到一个陌生地址。
 */
export function authRedirectBase(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`
}

/** 重置密码邮件的回跳地址：直接落在设置新密码的页面上 */
export function passwordResetRedirect(): string {
  return `${authRedirectBase()}reset-password`
}
