// ============================================================================
// 用户 store —— 登录态与当前用户资料
// ============================================================================
// 全应用的登录态唯一来源。路由守卫、导航栏、各页面的角色判断都读这里，
// 不要在组件里自己调 supabase.auth。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { Session } from '@supabase/supabase-js'

import { toMessage } from '@/lib/errors'
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
  const error = ref<string | null>(null)
  /** init() 是否已跑完 —— 路由守卫靠它区分"未登录"和"还没查完" */
  const initialized = ref(false)

  /** init() 的进行中 Promise，用于幂等；不是响应式状态，所以用普通变量 */
  let initPromise: Promise<void> | null = null

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

  const isPatient = computed(() => role.value === 'patient')
  const isFamily = computed(() => role.value === 'family')
  const isTherapist = computed(() => role.value === 'therapist')
  const isAdmin = computed(() => role.value === 'admin')

  /** 家属和治疗师都是"监护者"，在 RLS 里走同一套放行逻辑 */
  const isCaregiver = computed(() => isFamily.value || isTherapist.value)

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
    error.value = null

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

    error.value = null
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

  /**
   * 邮箱密码登录。
   *
   * 成功后立刻把 profiles 拉回来，而不是等 onAuthStateChange 回调里那个
   * setTimeout 去拉 —— 否则登录页跳转到首页时资料还没到，
   * 导航栏会先空一下再显示用户名。
   */
  async function signIn(email: string, password: string): Promise<boolean> {
    error.value = null
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
      error.value = toMessage(e, '登录失败')
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
    error.value = null
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
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
      error.value = toMessage(e, '注册失败')
      return { ok: false, needsEmailConfirmation: false }
    } finally {
      loading.value = false
    }
  }

  async function signOut(): Promise<void> {
    // 与其他方法保持一致。退出失败本身值得让用户看到，但下次再点一次
    // 就该把这条旧错误清掉，而不是叠着显示
    error.value = null

    const { error: err } = await supabase.auth.signOut()
    if (err) {
      error.value = toMessage(err, '退出登录失败')
      return
    }
    reset()
  }

  function reset(): void {
    session.value = null
    profile.value = null
    error.value = null
    // initPromise 一并清空，登出后再调 init() 能重新初始化
    initPromise = null
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
    loading.value = true
    try {
      const { data, error: err } = await supabase.auth.getSession()
      if (err) throw err

      session.value = data.session
      if (data.session) await fetchProfile()
    } catch (e) {
      error.value = toMessage(e, '初始化登录态失败')
    } finally {
      loading.value = false
      initialized.value = true
    }

    // 订阅后续的登录、登出、token 续期事件。
    //
    // ⚠️ 回调必须是同步的。supabase-js 触发这个回调时持有内部锁，
    //    若在回调里直接 await 别的 supabase 调用（比如 fetchProfile），
    //    会和锁的持有者互相等待，整个 auth 模块死锁。
    //    所以异步工作一律用 setTimeout 推到下一个事件循环再执行。
    supabase.auth.onAuthStateChange((_event, nextSession) => {
      session.value = nextSession
      setTimeout(() => {
        if (nextSession) void fetchProfile()
        else profile.value = null
      }, 0)
    })
  }

  return {
    // state
    session,
    profile,
    loading,
    error,
    initialized,
    // getters
    isLoggedIn,
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
    signIn,
    signUp,
    signOut,
    reset,
  }
})
