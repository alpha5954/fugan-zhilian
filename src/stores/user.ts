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

  async function signOut(): Promise<void> {
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
    signOut,
    reset,
  }
})
