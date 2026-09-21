// ============================================================================
// 用户 store —— 登录态与当前用户资料
// ============================================================================
// 全应用的登录态唯一来源。路由守卫、导航栏、各页面的角色判断都读这里，
// 不要在组件里自己调 supabase.auth。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { Session } from '@supabase/supabase-js'

import {
  authLinkError,
  authRedirectBase,
  fromRecoveryLink,
  passwordResetRedirect,
} from '@/lib/authRedirect'
import { authErrorInfo, toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type { Profile, ProfileUpdate, UserRole } from '@/types'

export const useUserStore = defineStore('user', () => {
  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  /** Supabase 的登录会话（JWT），由 SDK 自动续期 */
  const session = ref<Session | null>(null)
  /** profiles 表里对应的一行。有 session 不一定有 profile（触发器异常时会缺） */
  const profile = ref<Profile | null>(null)
  const loading = ref(false)
  /**
   * 最近一次失败的中文提示。
   *
   * 存的是**翻译过的**文案（见 lib/errors.ts 的 authErrorInfo），不是
   * Supabase 的英文原文 —— 界面全中文，只有报错冒英文的话用户读不懂。
   */
  const error = ref<string | null>(null)
  /**
   * 上面那条错误对应的错误码。
   *
   * 界面偶尔要针对某一类错误做额外动作，最典型的是 email_not_confirmed：
   * 光提示"去验证邮箱"没用，得顺手给一个「重新发送确认邮件」的按钮。
   * 只存文案的话，界面就只能去匹配字符串，太脆。
   */
  const errorCode = ref<string | null>(null)
  /** init() 是否已跑完 —— 路由守卫靠它区分"未登录"和"还没查完" */
  const initialized = ref(false)

  /**
   * 当前是否处在「从邮件链接进来重设密码」的流程里。
   *
   * 初始值来自模块加载时对 URL 的同步解析（lib/authRedirect.ts）。
   * 一旦为 true，路由守卫会把用户**锁在设置新密码页**上：此刻手里握着的是
   * 一个货真价实的登录会话，用户完全可以到处逛，然后永远想不起来设密码。
   *
   * 链接失效的情况（error_code 存在但没有令牌）不算 recoveryMode ——
   * 那时根本没有会话，把用户锁在改密码页上会让他卡死。那种情况由
   * 设置新密码页自己显示"链接已失效，请重新申请"。
   */
  const recoveryMode = ref(fromRecoveryLink)
  /** 回跳链接自带的错误码（如 otp_expired），给设置新密码页显示用 */
  const linkError = ref<string | null>(authLinkError)

  /** init() 的进行中 Promise，用于幂等；不是响应式状态，所以用普通变量 */
  let initPromise: Promise<void> | null = null
  /** 访客会话的建立过程，同样用于幂等 */
  let guestPromise: Promise<boolean> | null = null

  // -------------------------------------------------------------------------
  // getters
  // -------------------------------------------------------------------------
  const isLoggedIn = computed(() => session.value !== null)
  const userId = computed(() => session.value?.user.id ?? null)
  const email = computed(() => session.value?.user.email ?? null)

  const role = computed<UserRole | null>(() => profile.value?.role ?? null)

  /** 优先用资料里的昵称，没有就退回邮箱前缀 */
  const displayName = computed(() => {
    const name = profile.value?.display_name
    if (name) return name
    const mail = email.value
    return mail ? mail.split('@')[0] : ''
  })

  /**
   * 当前是否处于访客模式。
   *
   * 匿名账号在数据库看来就是普通账号（有 uid、走同一套 RLS），区别只在
   * auth.users.is_anonymous 这个标记。界面据此决定要不要提示「注册后可长期保存」。
   */
  const isGuest = computed(() => session.value?.user.is_anonymous === true)

  const isPatient = computed(() => role.value === 'patient')
  const isFamily = computed(() => role.value === 'family')
  const isTherapist = computed(() => role.value === 'therapist')
  const isAdmin = computed(() => role.value === 'admin')

  /** 家属和治疗师都是"监护者"，在 RLS 里走同一套放行逻辑 */
  const isCaregiver = computed(() => isFamily.value || isTherapist.value)

  // -------------------------------------------------------------------------
  // 错误处理
  // -------------------------------------------------------------------------
  // error 和 errorCode 必须**成对**改动。分开写的话，迟早会漏掉一处，
  // 于是界面上挂着上一次的错误码，据此做出的判断（比如要不要显示
  // 「重新发送确认邮件」）就会错得莫名其妙。
  // -------------------------------------------------------------------------

  function clearError(): void {
    error.value = null
    errorCode.value = null
  }

  /** 认证类错误：翻成中文，并把错误码一起记下来供界面分支用 */
  function setAuthError(e: unknown, fallback: string): void {
    const info = authErrorInfo(e, fallback)
    error.value = info.message
    errorCode.value = info.code
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------
  async function fetchProfile(): Promise<void> {
    const id = userId.value
    if (!id) {
      profile.value = null
      return
    }

    // 先清空上一次的错误。这个方法在每次 auth 状态变化后都会被调用，
    // 一次瞬时失败留下的错误会一直挂在界面上 —— 与其他方法保持一致
    clearError()

    const { data, error: err } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      // 用 maybeSingle 而非 single：查不到时返回 null 而不是抛错，
      // 与 RLS 静默过滤的行为一致，少一层异常处理
      .maybeSingle()

    if (err) {
      error.value = toMessage(err, '读取用户资料失败')
      return
    }
    profile.value = data
  }

  /** 更新自己的资料。只能改列级授权允许的三列，改 role 会被数据库拒绝 */
  async function updateProfile(patch: ProfileUpdate): Promise<boolean> {
    const id = userId.value
    if (!id) return false

    clearError()
    const { data, error: err } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', id)
      // 回读确认：RLS 对 UPDATE 是静默过滤，无权改时既不报错也影响 0 行，
      // 不回读就无法区分"改成功了"和"什么都没发生"
      .select('*')

    if (err) {
      error.value = toMessage(err, '更新资料失败')
      return false
    }
    if (!data?.length) {
      error.value = '更新未生效（可能是权限不足）'
      return false
    }

    profile.value = data[0]
    return true
  }

  // -------------------------------------------------------------------------
  // 访客模式
  // -------------------------------------------------------------------------

  /**
   * 确保当前有一个会话：已有则直接返回，没有就**静默建一个匿名账号**。
   *
   * 为什么必须建：anon 角色在业务表上没有任何授权（迁移 2 刻意如此），
   * 未登录访客查 rehab_sessions 之类会直接拿到 42501 permission denied。
   * 匿名账号拿到的是正常的 authenticated 角色，既有 RLS 原样生效，
   * 所以所有页面和数据层都不用为"访客"这个情况写任何分支。
   *
   * 幂等：路由守卫每次跳转都会调，用 guestPromise 保证只建一次。
   */
  function ensureGuestSession(): Promise<boolean> {
    if (session.value) return Promise.resolve(true)
    guestPromise ??= createGuestSession()
    return guestPromise
  }

  async function createGuestSession(): Promise<boolean> {
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.signInAnonymously({
        // role 会被 handle_new_user 触发器读走写进 profiles。
        // 匿名访客一律按患者建号 —— 治疗师/管理员必须后台提升，见迁移 1 的白名单
        options: { data: { role: 'patient' } },
      })
      if (err) throw err

      session.value = data.session
      if (data.session) await fetchProfile()
      initialized.value = true
      return Boolean(data.session)
    } catch (e) {
      // 最常见的原因：控制台没开启 Anonymous Sign-ins。
      // 守卫收到 false 会退回登录页，用户至少还能用系统
      setAuthError(e, '无法建立访客会话')
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 把访客账号升级为正式账号（即"注册"）。
   *
   * ⚠️ 用的是 updateUser 而不是 signUp。前者作用在**当前这个匿名账号**上，
   *    uid 不变，所以访客期间产生的一切（绑定的设备、保存的训练记录、
   *    监护关系）原样保留。signUp 会新建一个账号，那些数据就成了孤儿 ——
   *    这正是"登录后同步数据"要避免的。
   */
  async function upgradeGuest(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<{ ok: boolean; pendingEmail: string | null }> {
    clearError()
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.updateUser(
        {
          email: email.trim(),
          password,
          data: { display_name: displayName?.trim() || undefined },
        },
        // 换邮箱时 Supabase 会往新地址发一封确认信，这个地址是它的落点
        { emailRedirectTo: authRedirectBase() },
      )
      if (err) throw err

      // 若项目开启了邮箱确认，新邮箱处于待确认状态（user.new_email），
      // 要点邮件里的链接才生效。此时不算失败，但要如实告诉用户去查邮件
      const pendingEmail = data.user?.new_email ?? null

      if (pendingEmail) {
        return { ok: true, pendingEmail }
      }

      // 昵称要单独写入 profiles —— handle_new_user 只在**新建**用户时触发，
      // 升级匿名账号不会触发它，所以 updateUser 的 metadata 到不了 profiles
      if (displayName?.trim()) {
        await updateProfile({ display_name: displayName.trim() })
      }
      await fetchProfile()

      return { ok: true, pendingEmail: null }
    } catch (e) {
      setAuthError(e, '保存账号失败')
      return { ok: false, pendingEmail: null }
    } finally {
      loading.value = false
    }
  }

  /**
   * 邮箱密码登录。
   *
   * 成功后立刻把 profiles 拉回来，而不是等 onAuthStateChange 回调里那个
   * setTimeout 去拉 —— 否则登录页跳转到首页时资料还没到，
   * 导航栏会先空一下再显示用户名。
   */
  async function signIn(email: string, password: string): Promise<boolean> {
    clearError()
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (err) throw err

      session.value = data.session
      await fetchProfile()
      return true
    } catch (e) {
      setAuthError(e, '登录失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 注册新账号。
   *
   * 返回 needsEmailConfirmation 供页面区分两种情况：
   *   - 项目开启了邮箱确认（Supabase 默认开启）→ signUp 不返回 session，
   *     用户必须先去邮箱点确认链接才能登录
   *   - 关闭了邮箱确认 → 直接拿到 session，视为注册即登录
   *
   * role 只能传 patient / family。数据库那边的 handle_new_user 触发器
   * 有白名单，传别的值会被静默降级成 patient —— 治疗师和管理员必须
   * 由后台手动提升，防止有人注册时给自己提权。
   */
  async function signUp(
    email: string,
    password: string,
    options: { displayName?: string; role?: 'patient' | 'family' } = {},
  ): Promise<{ ok: boolean; needsEmailConfirmation: boolean }> {
    clearError()
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // 确认邮件里那个链接点回来的落点。
          // 不显式给的话用的是控制台里的 Site URL，那可能是另一个地址
          // （比如本地开发时填的 localhost），线上就会跳错地方。
          emailRedirectTo: authRedirectBase(),
          // 这些字段会进 auth.users.raw_user_meta_data，
          // 由 handle_new_user 触发器读出来写进 profiles
          data: {
            display_name: options.displayName?.trim() || undefined,
            role: options.role ?? 'patient',
          },
        },
      })
      if (err) throw err

      if (!data.session) {
        return { ok: true, needsEmailConfirmation: true }
      }

      session.value = data.session
      await fetchProfile()
      return { ok: true, needsEmailConfirmation: false }
    } catch (e) {
      setAuthError(e, '注册失败')
      return { ok: false, needsEmailConfirmation: false }
    } finally {
      loading.value = false
    }
  }

  // -------------------------------------------------------------------------
  // 找回密码
  // -------------------------------------------------------------------------

  /**
   * 发送重置密码邮件。
   *
   * 回跳地址指向 `/<base>/reset-password`，用户点邮件后直接落在设置新密码的
   * 页面上，而不是先落到首页再自己找路。
   *
   * ⚠️ 返回 true **不代表这个邮箱存在**。Supabase 对未注册的邮箱同样回成功，
   *    这是刻意的反枚举设计：否则任何人都能拿这个接口试探哪些邮箱注册过。
   *    所以界面上的文案也必须是「如果该邮箱已注册，邮件已发出」这种说法，
   *    不能写成"邮件已发送到 xxx"。
   */
  async function sendPasswordReset(email: string): Promise<boolean> {
    clearError()
    loading.value = true
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: passwordResetRedirect() },
      )
      if (err) throw err
      return true
    } catch (e) {
      setAuthError(e, '发送重置邮件失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /** 重发注册确认邮件。用于「注册了但没收到信」这个最常见的卡点 */
  async function resendConfirmation(email: string): Promise<boolean> {
    clearError()
    loading.value = true
    try {
      const { error: err } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
        options: { emailRedirectTo: authRedirectBase() },
      })
      if (err) throw err
      return true
    } catch (e) {
      setAuthError(e, '重新发送失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 设置新密码。只在「从重置邮件链接进来」的场景下调用 ——
   * 它作用在当前会话上，而那个会话正是点邮件链接建立的。
   */
  async function updatePassword(password: string): Promise<boolean> {
    clearError()
    loading.value = true
    try {
      const { error: err } = await supabase.auth.updateUser({ password })
      if (err) throw err

      // 改密码通常是因为"原密码可能已经泄露了"。把**其它设备**上的会话
      // 一并作废，否则攻击者手里那个旧会话还能继续用，改密码就白改了。
      // 当前这个会话保留，用户不用重新登录。
      //
      // 这一步失败不影响"密码已经改成功"这个事实，所以只记不抛
      const { error: revokeErr } = await supabase.auth.signOut({
        scope: 'others',
      })
      if (revokeErr) {
        console.warn('撤销其它设备的登录态失败：', revokeErr.message)
      }

      await fetchProfile()
      return true
    } catch (e) {
      setAuthError(e, '设置新密码失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /** 退出「重设密码」流程。设完密码、或者用户放弃时调用，之后守卫不再拦人 */
  function exitRecovery(): void {
    recoveryMode.value = false
    linkError.value = null
  }

  async function signOut(): Promise<void> {
    // 与其他方法保持一致。退出失败本身值得让用户看到，但下次再点一次
    // 就该把这条旧错误清掉，而不是叠着显示
    clearError()

    const { error: err } = await supabase.auth.signOut()
    if (err) {
      setAuthError(err, '退出登录失败')
      return
    }
    reset()
  }

  function reset(): void {
    session.value = null
    profile.value = null
    clearError()
    // 恢复流程也要一并退出。不清的话，用户在重设密码页点了「退出登录」之后
    // 会被守卫锁在一个没有会话的页面上，进退不得
    recoveryMode.value = false
    linkError.value = null
    // 两个 Promise 一并清空：登出后再调 init() / ensureGuestSession()
    // 应当能重新走一遍，而不是拿到上一次的结果
    initPromise = null
    guestPromise = null
    initialized.value = false
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------
  /** 幂等 —— 路由守卫每次跳转都会调，重复调用不会重复请求 */
  function init(): Promise<void> {
    initPromise ??= doInit()
    return initPromise
  }

  // 这个方法刻意不在这里清空 error：它由 init() 保证整个会话只执行一次
  // （initPromise 幂等），所以不存在"上一次的错误残留"这一说。清空反而会
  // 把 getSession 失败的原因盖掉，让用户不知道白屏是为什么。
  async function doInit(): Promise<void> {
    // ---------------------------------------------------------------------
    // 订阅必须**早于** getSession()，这个顺序不能换。
    //
    // 用户点重置密码邮件的链接回来时，SDK 解析完 URL 会发出 PASSWORD_RECOVERY
    // 事件。但看 SDK 源码，它是用一句裸的 `setTimeout(..., 0)` 发的，**不进**
    // initialize 的通知队列；而 getSession() 返回之后这里还跟着一次
    // fetchProfile 网络请求。等那之后再订阅，事件早就发完了 ——
    // 用户会被当成普通登录直接进首页，整个找回密码流程静默失效。
    //
    // 换句话说：这里即使已经有了 lib/authRedirect.ts 的同步兜底，
    // 订阅位置也仍然要对——那条兜底只认"页面加载时 URL 里有令牌"，
    // 覆盖不了 SDK 自己触发的场景。
    // ---------------------------------------------------------------------
    //
    // ⚠️ 回调必须是同步的。supabase-js 触发这个回调时持有内部锁，
    //    若在回调里直接 await 别的 supabase 调用（比如 fetchProfile），
    //    会和锁的持有者互相等待，整个 auth 模块死锁。
    //    所以异步工作一律用 setTimeout 推到下一个事件循环再执行。
    supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') recoveryMode.value = true

      session.value = nextSession
      setTimeout(() => {
        if (nextSession) void fetchProfile()
        else profile.value = null
      }, 0)
    })

    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.getSession()
      if (err) throw err

      session.value = data.session
      if (data.session) await fetchProfile()
    } catch (e) {
      setAuthError(e, '初始化登录态失败')
    } finally {
      loading.value = false
      initialized.value = true
    }
    // 注：地址栏里的认证参数（令牌 / 错误码）由路由守卫在这之后清掉。
    // 不能在这里清 —— vue-router 会拿它自己记的那份地址写回去，白清。
    // 详见 lib/authRedirect.ts 里 consumeAuthHashFlag 的说明。
  }

  return {
    // state
    session,
    profile,
    loading,
    error,
    errorCode,
    initialized,
    recoveryMode,
    linkError,
    // getters
    isLoggedIn,
    isGuest,
    userId,
    email,
    role,
    displayName,
    isPatient,
    isFamily,
    isTherapist,
    isAdmin,
    isCaregiver,
    // actions
    init,
    fetchProfile,
    updateProfile,
    ensureGuestSession,
    upgradeGuest,
    signIn,
    signUp,
    signOut,
    reset,
    sendPasswordReset,
    resendConfirmation,
    updatePassword,
    exitRecovery,
  }
})
