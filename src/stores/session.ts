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

/** fetch 的可选筛选条件 */
export interface SessionQuery {
  /** 只看某位患者的记录。不传则返回当前用户可见的全部（由 RLS 决定范围） */
  patientId?: string
  /** 只看某个关节 */
  joint?: JointName
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

  /** 今日训练次数 */
  const todayCount = computed(() => {
    const today = new Date().toISOString().slice(0, 10)
    return sessions.value.filter((s) => s.started_at.slice(0, 10) === today).length
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
  }

  return {
    sessions,
    loading,
    loaded,
    error,
    latest,
    todayCount,
    byId,
    fetch,
    create,
    update,
    remove,
    reset,
  }
})
