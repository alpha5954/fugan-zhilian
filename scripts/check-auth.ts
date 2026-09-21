// 验证登录/注册/找回密码里的两块纯逻辑。
// 直接跑：node scripts/check-auth.ts
//
// 这两块都属于"写错了也不会报错，只会让用户看到一句莫名其妙的话"的类型，
// 所以值得钉住：
//
//   1. URL 里那个认证回调的识别 —— 认错了的后果是**整个找回密码流程静默失效**：
//      用户点完邮件被当成普通登录送进首页，密码还是没改，而他以为自己改过了。
//   2. 错误码翻译 —— 漏一条就退回英文，而英文在中文界面里等于没提示。
import {
  parseAuthCallback,
  type AuthCallback,
} from '../src/lib/authRedirect.ts'
import { AUTH_CODE_MESSAGES, authErrorInfo } from '../src/lib/errors.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

// ============================================================================
console.log('\n--- 认证回调的识别 ---')
// ============================================================================

/** 断言解析结果 */
function expectParse(label: string, hash: string, want: AuthCallback) {
  const got = parseAuthCallback(hash)
  const ok =
    got.fromRecoveryLink === want.fromRecoveryLink &&
    got.errorCode === want.errorCode
  check(label, ok, ok ? '' : `得到 ${JSON.stringify(got)}`)
}

// Supabase 恢复链接的实际形态。注意令牌全在 hash 里（implicit 流），
// 不是 query —— 用 location.search 去找会一个字段都找不到
expectParse(
  '正式的恢复链接能认出来',
  '#access_token=eyJhbG.xxx&expires_in=3600&refresh_token=yyy&token_type=bearer&type=recovery',
  { fromRecoveryLink: true, errorCode: null },
)

// 不带 # 的情况也要能吃下去：手工拼的地址、或者别处传进来时容易漏掉 #
expectParse(
  '缺了开头的 # 也能解析',
  'access_token=abc&type=recovery',
  { fromRecoveryLink: true, errorCode: null },
)

// 链接过期是这套流程里最常见的失败。此时**没有令牌**，只有错误码 ——
// 只认 access_token 的写法会把它当成"不是恢复链接"，用户就被丢进首页了
expectParse(
  '过期的链接带 error_code',
  '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
  { fromRecoveryLink: false, errorCode: 'otp_expired' },
)

expectParse(
  '错误码和 type=recovery 同时存在',
  '#error_code=otp_expired&type=recovery',
  { fromRecoveryLink: true, errorCode: 'otp_expired' },
)

// type 是别的值时不能误判成恢复流程
expectParse(
  '注册确认链接不算恢复链接',
  '#access_token=abc&type=signup',
  { fromRecoveryLink: false, errorCode: null },
)

expectParse(
  'OAuth 回调不算恢复链接',
  '#access_token=abc&provider_token=zzz&type=bearer',
  { fromRecoveryLink: false, errorCode: null },
)

// 普通访问：没有 hash
expectParse('没有 hash 时什么都不认', '', {
  fromRecoveryLink: false,
  errorCode: null,
})

expectParse('只有 # 时什么都不认', '#', {
  fromRecoveryLink: false,
  errorCode: null,
})

// 参数名相近但不相等，不能模糊匹配
expectParse(
  'type=recoveryx 不算（不做前缀匹配）',
  '#access_token=abc&type=recoveryx',
  { fromRecoveryLink: false, errorCode: null },
)

// 值里带 URL 编码时不能被截断
{
  const got = parseAuthCallback(
    '#error_description=Email+link+is+invalid+or+has+expired&error_code=otp_expired&type=recovery',
  )
  check(
    '带 + 号的描述不影响其它字段',
    got.fromRecoveryLink && got.errorCode === 'otp_expired',
    JSON.stringify(got),
  )
}

// ============================================================================
console.log('\n--- 错误码翻译 ---')
// ============================================================================

/** 造一个 Supabase 形态的错误：它不是 Error 实例，是个普通对象 */
function authErr(code: string, message = 'raw english text') {
  return { code, message, status: 400 }
}

{
  const { code, message } = authErrorInfo(authErr('invalid_credentials'))
  check('密码错翻译成中文', message === '邮箱或密码不正确', message)
  check('错误码原样保留', code === 'invalid_credentials', String(code))
}

{
  // 这一条是登录页那个「重新发送确认邮件」按钮的判据。
  // 码丢了按钮就不会出现，所以单独钉一下
  const { code, message } = authErrorInfo(authErr('email_not_confirmed'))
  check(
    '邮箱未验证：给出错误码供界面分支',
    code === 'email_not_confirmed',
    String(code),
  )
  check('邮箱未验证：说的是"去点邮件里的链接"', /确认邮件/.test(message), message)
}

{
  const { message } = authErrorInfo(authErr('otp_expired'), '设置新密码失败')
  check('链接过期翻译成中文', /失效|过期/.test(message), message)
}

{
  const { message } = authErrorInfo(authErr('same_password'))
  check('新旧密码相同能识别', /不能和当前密码相同/.test(message), message)
}

// ---- 没有错误码时的兜底 ----
{
  const { message } = authErrorInfo({ message: 'Invalid login credentials' })
  check('没有 code 时按英文原文匹配', message === '邮箱或密码不正确', message)
}

{
  const { message } = authErrorInfo({
    message: 'Email not confirmed',
    status: 400,
  })
  check('英文原文大小写不敏感', /确认邮件/.test(message), message)
}

{
  const { message } = authErrorInfo({ message: 'Failed to fetch' })
  check('网络故障有专门文案', /网络/.test(message), message)
}

// ---- 完全不认识的情况 ----
{
  const { code, message } = authErrorInfo(authErr('some_new_code'))
  check('不认识的码：用中文兜底而不是甩原文', message === '操作失败，请重试（some_new_code）', message)
  check('不认识的码也保留下来', code === 'some_new_code', String(code))
}

{
  const { message } = authErrorInfo(authErr('unknown', 'Brand New English'))
  check('兜底文案里不含英文原文', !/Brand New/.test(message), message)
}

{
  const { message } = authErrorInfo(null, '登录失败')
  check('null 用调用方的兜底文案', message === '登录失败', message)
}

{
  const { message } = authErrorInfo(undefined)
  check('undefined 有默认兜底', message.length > 0, message)
}

// ---- 整张表 ----
// 逐条遍历，而不是挑几个测：新加条目时漏翻英文，只有这样才拦得住
{
  const containsCJK = /[一-鿿]/
  const bad: string[] = []
  for (const [code, msg] of Object.entries(AUTH_CODE_MESSAGES)) {
    if (!msg.trim()) bad.push(`${code}: 空文案`)
    else if (!containsCJK.test(msg)) bad.push(`${code}: ${msg}`)
  }
  check(
    `错误码表里 ${Object.keys(AUTH_CODE_MESSAGES).length} 条全是中文`,
    bad.length === 0,
    bad.join('; '),
  )
}

// 翻译结果里出现英文，用户就等于没有提示。
// "Invalid login credentials" 是这条路径上最典型的一句
{
  const englishLeftovers: string[] = []
  for (const code of Object.keys(AUTH_CODE_MESSAGES)) {
    const { message } = authErrorInfo(authErr(code, 'Invalid login credentials'))
    // 允许夹带错误码（括号里的东西），但不能整句英文照抄
    if (/invalid login credentials/i.test(message)) {
      englishLeftovers.push(`${code}: ${message}`)
    }
  }
  check(
    '没有任何一条会把英文原文透出来',
    englishLeftovers.length === 0,
    englishLeftovers.join('; '),
  )
}

// ============================================================================
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
process.exit(passed === results.length ? 0 : 1)
