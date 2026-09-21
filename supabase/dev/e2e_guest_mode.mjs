// 访客模式的关键路径验证（对真实 Supabase 项目执行）。
//
// 走这条路而不是 Python，是因为要验证的核心就是 supabase-js 客户端的行为：
// signInAnonymously 拿到的会话、updateUser 升级后 uid 是否保持。
// 手写 HTTP 请求测不出客户端这层。
//
// 用法：  node supabase/dev/e2e_guest_mode.mjs
//
// ⚠️ 前置：控制台必须开启 Anonymous Sign-ins
//    （Authentication → Sign In / Providers → Anonymous Sign-ins）
//    未开启的话第一步就会失败，并提示去哪里打开。
// ⚠️ 会创建一个匿名账号并把其中一个升级为正式账号（有邮箱）。
//    跑完去 Authentication → Users 搜 'guest-upgrade-' 删除。
import { createClient } from '../../node_modules/@supabase/supabase-js/dist/index.mjs'

const URL_ = 'https://uliujvggrsnbdejmscny.supabase.co'
const KEY = 'sb_publishable_uuOmJBII0P1m-muljncfOQ_VbekMGKH'

const sb = createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const results = []
function check(label, ok, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

console.log('='.repeat(66))
console.log('1. 匿名登录')
console.log('='.repeat(66))

const { data, error } = await sb.auth.signInAnonymously({
  // role 会被 handle_new_user 触发器读走写进 profiles
  options: { data: { role: 'patient' } },
})

if (error) {
  console.log(`  [FAIL] 匿名登录：${error.message}`)
  console.log()
  console.log('  控制台的 Anonymous Sign-ins 没有开启。去这里打开并保存：')
  console.log('    Authentication → Sign In / Providers → Anonymous Sign-ins')
  process.exit(1)
}

const guestId = data.user.id
check('拿到匿名会话', Boolean(data.session))
check('用户被标记为匿名', data.user.is_anonymous === true, `is_anonymous=${data.user.is_anonymous}`)

console.log()
console.log('='.repeat(66))
console.log('2. 触发器为新账号建档')
console.log('='.repeat(66))

const { data: prof, error: profErr } = await sb
  .from('profiles').select('*').eq('id', guestId).maybeSingle()

check('匿名账号也有 profile（触发器正常触发）', !profErr && Boolean(prof))
if (prof) {
  check('默认角色为 patient（白名单逻辑照常生效）', prof.role === 'patient', prof.role)
  check('自动分配了邀请码', Boolean(prof.invite_code), prof.invite_code ?? '(无)')
}

console.log()
console.log('='.repeat(66))
console.log('3. 匿名账号走的是普通 RLS 通道，没有特殊后门')
console.log('='.repeat(66))

const serial = `GUEST-${String(Date.now()).slice(-8)}`
const { data: dev, error: devErr } = await sb
  .from('devices')
  .insert({ serial_no: serial, owner_id: guestId, status: 'online', firmware: '1.0.0' })
  .select('*')
check('能插入设备', !devErr, devErr?.message)

const { data: sess, error: sessErr } = await sb
  .from('rehab_sessions')
  .insert({ patient_id: guestId, exercise: '屈膝滑动',
            started_at: new Date().toISOString(), rom_deg: 88.5, rms_mv: 0.27 })
  .select('*')
check('能插入训练记录', !sessErr, sessErr?.message)

const { data: mine } = await sb.from('rehab_sessions').select('*')
check('查询结果被 RLS 限定为自己的', mine?.length === 1, `看到 ${mine?.length} 条`)

// 反向验证：匿名账号同样受列级授权约束，不能给自己提权
const { error: escErr } = await sb
  .from('profiles').update({ role: 'admin' }).eq('id', guestId)
check('匿名账号同样不能给自己提权（列级授权生效）', Boolean(escErr), escErr?.message)

console.log()
console.log('='.repeat(66))
console.log('4. 升级为正式账号 —— 「注册即保留数据」的核心承诺')
console.log('='.repeat(66))

const email = `guest-upgrade-${String(Date.now()).slice(-6)}@fugan-test.invalid`
const { data: up, error: upErr } = await sb.auth.updateUser({
  email,
  password: 'Test-Password-2026',
  data: { display_name: '访客升级测试' },
})

check('升级成功（updateUser 而非 signUp）', !upErr, upErr?.message)

if (!upErr) {
  check('★ uid 与访客期间完全一致', up.user.id === guestId,
        `${up.user.id === guestId ? '一致' : '变了！'}`)
  check('不再是匿名账号', up.user.is_anonymous === false)

  const { data: after } = await sb.from('rehab_sessions').select('*')
  check('★ 升级后仍能看到访客期间的训练记录', after?.length === 1, `${after?.length} 条`)

  const { data: devAfter } = await sb.from('devices').select('*')
  check('★ 升级后仍能看到访客期间绑定的设备', devAfter?.length === 1, `${devAfter?.length} 台`)
}

console.log()
console.log('='.repeat(66))
console.log('5. 清理')
console.log('='.repeat(66))

if (sess?.[0]?.id) await sb.from('rehab_sessions').delete().eq('id', sess[0].id)
if (dev?.[0]?.id) await sb.from('devices').delete().eq('id', dev[0].id)
const { data: left } = await sb.from('rehab_sessions').select('*')
check('测试数据已清理', left?.length === 0, `剩余 ${left?.length} 条`)

console.log()
console.log('='.repeat(66))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(66))
console.log(`测试账号：${email}`)
console.log("去 Authentication → Users 搜 'guest-upgrade-' 删除")
