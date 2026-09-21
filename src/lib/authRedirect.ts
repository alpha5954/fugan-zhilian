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
  /** hash 里是否带着认证参数（令牌或错误码），决定要不要清地址栏 */
  isAuthCallback: boolean
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
  // refresh_token 也认：正常情况两者成对出现，但只来一个的时候同样得清掉，
  // 那一样是能换会话的凭据
  const hasToken = Boolean(
    params.get('access_token') || params.get('refresh_token'),
  )
  const hasError = Boolean(params.get('error_code') || params.get('error'))
  return {
    fromRecoveryLink: params.get('type') === 'recovery',
    errorCode: params.get('error_code'),
    isAuthCallback: hasToken || hasError,
  }
}

// 模块求值时就抓下来（见文件开头关于 import 顺序的说明）。
// window 的判断是为了让这个模块在 node 下也能被导入，好让自检脚本
// 能直接调 parseAuthCallback —— 浏览器里永远走前一个分支。
const initial =
  typeof window === 'undefined'
    ? { fromRecoveryLink: false, errorCode: null, isAuthCallback: false }
    : parseAuthCallback(window.location.hash)

/** 本次页面加载是否来自「重置密码」邮件链接 */
export const fromRecoveryLink = initial.fromRecoveryLink

/** 回跳链接里带的错误码，没有则为 null */
export const authLinkError = initial.errorCode

/** 地址栏里是否还挂着认证参数（被取走一次后就为 false） */
let pending = initial.isAuthCallback

/**
 * 取走「地址栏里挂着认证参数」这个标记。**只会返回一次 true。**
 *
 * 认证参数必须从地址栏里清掉，原因有三个：
 *
 *   1. **令牌留在地址栏里会漏出去。** 用户会截图、会把地址复制给别人；
 *      页面只要加载任何一个第三方资源，完整 URL（含 access_token）就会
 *      进到 Referer 头里。
 *   2. **刷新会重新触发一遍。** 同一个令牌多半已经用过了，SDK 再解析一次
 *      只会得到一个看不懂的失败 —— 而这次失败和用户的操作毫无关系。
 *   3. 守卫把用户改送到 /reset-password 时用的是 router.replace，
 *      **它不动 hash**，所以那串令牌会原样挂在落地页上。
 *
 * ⚠️ 清这个 hash 必须由 **vue-router** 来做（守卫里返回一个去掉 hash 的
 *    重定向），不能在这里直接调 history.replaceState。
 *
 *    实测过：直接 replaceState 确实把地址栏清干净了，但 **vue-router 会
 *    再把它写回来**。它启动时就把带 hash 的地址记进了自己的
 *    history.state，之后每次保存滚动位置都会拿这份记录做 replaceState，
 *    于是 hash 复活。调用记录长这样：
 *
 *       1. /reset-password#error=...   ← router 初始化
 *       2. /reset-password            ← 直接 replaceState（白做）
 *       3. /reset-password#error=...   ← router 又写回来了
 *
 *    所以这里只负责回答"要不要清"，具体怎么清交给 router。
 *
 * ⚠️ 时机上还必须晚于 SDK：它同样要读这段 hash 才能建立会话。
 *    所以调用点在路由守卫里、`await user.init()` 之后。
 */
export function consumeAuthHashFlag(): boolean {
  if (!pending) return false
  pending = false
  return true
}

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
