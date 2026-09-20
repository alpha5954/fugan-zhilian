// ============================================================================
// 康复训练记录 store
// ============================================================================
// 注意命名：这里的 session 指「一次康复训练」，与用户登录会话无关。
// 登录态在 stores/user.ts 里。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type {
  JointName,
  RehabSession,
  RehabSessionInsert,
  RehabSessionUpdate,
} from '@/types'

/** 今天零点（浏览器本地时区） */
function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** fetch 的可选筛选条件 */
export interface SessionQuery {
  /** 只看某位患者的记录。不传则返回当前用户可见的全部（由 RLS 决定范围） */
  patientId?: string
  /** 只看某个关节 */
  joint?: JointName
  /** 起始时间（含）。传本地时间的 Date，内部转 UTC 后比较 */
  from?: Date
  /** 结束时间（含） */
  to?: Date
  /** 最多取多少条，默认 50 */
  limit?: number
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<RehabSession[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  /** 按开始时间倒序，最近一次在最前 */
  const latest = computed(() => sessions.value[0] ?? null)

  /**
   * 今日训练次数的**精确值**，由 fetchTodayCount() 填充。
   *
   * 下面的 todayCount 只统计当前已加载的那批行，列表一旦分页就会少算。
   * 首页头条数字不能靠这个。
   */
  const todayTotal = ref(0)

  /** 今日训练次数 —— 基于已加载列表，仅用于列表内部展示 */
  const todayCount = computed(() => {
    const start = startOfToday().getTime()
    return sessions.value.filter((s) => new Date(s.started_at).getTime() >= start).length
  })

  const byId = computed(
    () => (id: string) => sessions.value.find((s) => s.id === id) ?? null,
  )

  async function fetch(options: SessionQuery = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      let query = supabase
        .from('rehab_sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(options.limit ?? 50)

      if (options.patientId) query = query.eq('patient_id', options.patientId)
      if (options.joint) query = query.eq('joint', options.joint)
      // 时间范围用 toISOString 转 UTC 再比较。数据库存的是 timestamptz，
      // 直接传本地时间的字符串会差出一个时区偏移。
      if (options.from) query = query.gte('started_at', options.from.toISOString())
      if (options.to) query = query.lte('started_at', options.to.toISOString())

      const { data, error: err } = await query
      if (err) throw err

      sessions.value = data ?? []
      loaded.value = true
    } catch (e) {
      error.value = toMessage(e, '读取训练记录失败')
    } finally {
      loading.value = false
    }
  }

  /**
   * 取今日训练次数的精确值。
   *
   * 时区要注意：按浏览器**本地时区**的今天零点算边界，再转成 UTC ISO
   * 传给 PostgREST。若直接用 UTC 零点，东八区用户在早上 8 点前看到的
   * 「今日」会从前一天算起。
   */
  async function fetchTodayCount(patientId?: string): Promise<void> {
    let query = supabase
      .from('rehab_sessions')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', startOfToday().toISOString())

    // 家属的 RLS 范围是多个监护对象，不指定就统计成所有人的合计
    if (patientId) query = query.eq('patient_id', patientId)

    const { count, error: err } = await query
    if (err) {
      error.value = toMessage(err, '统计今日训练次数失败')
      return
    }
    todayTotal.value = count ?? 0
  }

  async function create(payload: RehabSessionInsert): Promise<RehabSession | null> {
    error.value = null
    const { data, error: err } = await supabase
      .from('rehab_sessions')
      .insert(payload)
      .select('*')

    if (err) {
      error.value = toMessage(err, '保存训练记录失败')
      return null
    }

    const created = data?.[0] ?? null
    if (created) sessions.value = [created, ...sessions.value]
    return created
  }

  async function update(id: string, patch: RehabSessionUpdate): Promise<boolean> {
    error.value = null
    const { data, error: err } = await supabase
      .from('rehab_sessions')
      .update(patch)
      .eq('id', id)
      .select('*')

    if (err) {
      error.value = toMessage(err, '更新训练记录失败')
      return false
    }
    if (!data?.length) {
      error.value = '更新未生效（无权限或记录不存在）'
      return false
    }

    const updated = data[0]
    sessions.value = sessions.value.map((s) => (s.id === id ? updated : s))
    return true
  }

  async function remove(id: string): Promise<boolean> {
    error.value = null
    const { data, error: err } = await supabase
      .from('rehab_sessions')
      .delete()
      .eq('id', id)
      .select('id')

    if (err) {
      error.value = toMessage(err, '删除训练记录失败')
      return false
    }
    if (!data?.length) {
      error.value = '删除未生效（无权限或记录不存在）'
      return false
    }

    sessions.value = sessions.value.filter((s) => s.id !== id)
    return true
  }

  function reset(): void {
    sessions.value = []
    loaded.value = false
    error.value = null
    todayTotal.value = 0
  }

  return {
    sessions,
    loading,
    loaded,
    error,
    latest,
    todayTotal,
    todayCount,
    byId,
    fetch,
    fetchTodayCount,
    create,
    update,
    remove,
    reset,
  }
})
