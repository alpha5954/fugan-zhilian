// 登录 / 注册 / 找回密码的界面端到端验证。
//
// 前置：先起一个服务，二选一
//   npm run dev        # http://localhost:5173/fugan-zhilian/
//   npm run build && npm run preview
// 然后：
//   node supabase/dev/e2e_auth_ui.mjs [baseUrl]
//
// 需要 playwright（`npx playwright install chromium` 装浏览器）。
//
// 【为什么这几条非要真跑不可】
// 找回密码的成败全在"路由守卫有没有把用户拦住"上，而这取决于 SDK 从 URL
// 里换会话的时序 —— 那不是一个读代码能读准的东西。尤其是第 4、5 条：
// 用户点完邮件直接落到首页的话，整个功能等于没做，而界面上看起来一切正常。

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:4173/fugan-zhilian'

const results = []
function check(label, ok, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

/** 打开一个地址，等应用稳定下来，返回最终的 path 和页面文字 */
async function visit(page, path) {
  const errors = []
  const onError = (e) => errors.push(e.message)
  page.on('pageerror', onError)

  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  // 守卫里的 await init() 之后还可能再跳一次（恢复模式的锁），等它落定
  await page.waitForTimeout(1200)

  const text = await page.locator('body').innerText()
  const finalPath = new URL(page.url()).pathname
  page.off('pageerror', onError)
  return { text, finalPath, errors }
}

const browser = await chromium.launch()

try {
  // ========================================================================
  console.log('\n--- 登录页 ---')
  // ========================================================================
  {
    const page = await browser.newPage()
    const { text, finalPath, errors } = await visit(page, '/login')

    check('登录页能打开', finalPath.endsWith('/login'), finalPath)
    check('有邮箱和密码输入框', text.includes('邮箱') && text.includes('密码'))
    check('两个标签页都在', text.includes('登录') && text.includes('注册'))
    check('有「忘记密码」入口', text.includes('忘记密码'))
    check('渲染期没有 JS 异常', errors.length === 0, errors.join(' | '))

    // 切到注册
    await page.getByRole('tab', { name: '注册' }).click()
    await page.waitForTimeout(200)
    const signupText = await page.locator('body').innerText()
    check('切到注册后出现「确认密码」', signupText.includes('确认密码'))
    check('切到注册后能选身份', signupText.includes('患者') && signupText.includes('家属'))

    // 点忘记密码
    await page.getByRole('tab', { name: '登录' }).click()
    await page.waitForTimeout(150)
    await page.getByRole('button', { name: '忘记密码？' }).click()
    await page.waitForTimeout(200)

    const resetText = await page.locator('body').innerText()
    check('忘记密码切到「重置密码」', resetText.includes('重置密码'))
    check('重置模式不再显示密码框', !resetText.includes('确认密码'))
    check('重置模式按钮文案正确', resetText.includes('发送重置邮件'))
    check('重置模式可以返回登录', resetText.includes('返回登录'))

    await page.close()
  }

  // ========================================================================
  console.log('\n--- 邮件链接进来的三种情况 ---')
  // ========================================================================
  {
    // ① 链接过期：URL 里带着 error_code，没有令牌
    const page = await browser.newPage()
    const { text, finalPath, errors } = await visit(
      page,
      '/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
    )
    check('过期链接停在设置新密码页', finalPath.endsWith('/reset-password'), finalPath)
    check('过期链接明说「已失效」', text.includes('链接已失效'), text.slice(0, 120))
    check(
      '过期链接给出重新申请的出口',
      text.includes('重新申请'),
      '页面上没有重新申请的入口',
    )
    check('过期链接不显示密码表单', !text.includes('确认新密码'))
    check('过期链接没有 JS 异常', errors.length === 0, errors.join(' | '))
    await page.close()
  }

  {
    // ② 直接敲地址：不是从邮件来的
    const page = await browser.newPage()
    const { text, finalPath } = await visit(page, '/reset-password')
    check('直接访问停在设置新密码页', finalPath.endsWith('/reset-password'), finalPath)
    check(
      '直接访问提示需要从邮件进入',
      text.includes('需要从邮件的链接进入'),
      text.slice(0, 120),
    )
    await page.close()
  }

  // ========================================================================
  console.log('\n--- 关键：恢复模式必须把用户拦住 ---')
  // ========================================================================
  // 令牌是假的，所以换不到会话；但"这是个恢复链接"这件事必须被认出来，
  // 用户必须被送到 /reset-password。落错地方就说明整套流程静默失效了。
  {
    const page = await browser.newPage()
    const { finalPath, text } = await visit(
      page,
      '/monitor#access_token=fake.token.value&refresh_token=fake&type=recovery',
    )
    check(
      '带令牌访问 /monitor 会被改送到设置新密码页',
      finalPath.endsWith('/reset-password'),
      `最终停在 ${finalPath}`,
    )
    check('页面不是空白', text.trim().length > 0)
    await page.close()
  }

  {
    // 登录页也不能例外：恢复模式优先级高于 guestOnly
    const page = await browser.newPage()
    const { finalPath } = await visit(
      page,
      '/login#access_token=fake.token.value&refresh_token=fake&type=recovery',
    )
    check(
      '带令牌访问 /login 也会被改送到设置新密码页',
      finalPath.endsWith('/reset-password'),
      `最终停在 ${finalPath}`,
    )
    await page.close()
  }

  {
    // 反例：普通的 OAuth 回调（type 不是 recovery）不应该触发这道锁，
    // 否则一次误判就会把所有别的登录方式也锁死
    const page = await browser.newPage()
    const { finalPath } = await visit(
      page,
      '/login#access_token=fake.token.value&refresh_token=fake&type=bearer',
    )
    check(
      'type 不是 recovery 时不受恢复模式影响',
      !finalPath.endsWith('/reset-password'),
      `最终停在 ${finalPath}`,
    )
    await page.close()
  }
} finally {
  await browser.close()
}

console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
process.exit(passed === results.length ? 0 : 1)
