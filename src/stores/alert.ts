// ============================================================================
// 预警 store
// ============================================================================
// 覆盖热敷温度超标、训练动作异常、设备离线等场景。
// 家属/治疗师读到这里的数据就是他们手机端收到提醒的数据源。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type { Alert, AlertInsert, AlertSeverity } from '@/types'

export interface AlertQuery {
  patientId?: string
  /** 只看未处理的 */
  onlyUnacknowledged?: boolean
  /** 只看某个等级及以上？这里不做比较，限定单一等级 */
  severity?: AlertSeverity
  limit?: number
}

/** 严重程度排序权重 —— 列表里关键的排前面 */
const SEVERITY_WEIGHT: Record<AlertSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
}

export const useAlertStore = defineStore('alert', () => {
  const alerts = ref<Alert[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  /**
   * 未处理预警的**精确总数**，由 fetchUnacknowledgedCount() 填充。
   *
   * 与下面基于列表计算的 unacknowledgedCount 不同：那个只统计当前已加载
   * 的那批行，列表分页或加了 limit 之后就会少算。导航栏红点要给准数，
   * 所以用单独一次 head 请求取。
   */
  const unacknowledgedTotal = ref(0)

  /** 未处理数量 —— 基于已加载列表，仅用于列表内部展示 */
  const unacknowledgedCount = computed(
    () => alerts.value.filter((a) => a.acknowledged_at === null).length,
  )

  /** 未处理且为 critical 的数量，用于决定提示的紧迫程度 */
  const criticalCount = computed(
    () =>
      alerts.value.filter((a) => a.acknowledged_at === null && a.severity === 'critical')
        .length,
  )

  /**
   * 按「等级从重到轻，同级按时间从新到旧」排序的列表。
   * 严重的排前面 —— 家属一眼要看的是最要紧的那条。
   */
  const sorted = computed(() =>
    [...alerts.value].sort((a, b) => {
      const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
      if (w !== 0) return w
      return b.occurred_at.localeCompare(a.occurred_at)
    }),
  )

  async function fetch(options: AlertQuery = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      let query = supabase
        .from('alerts')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(options.limit ?? 50)

      if (options.patientId) query = query.eq('patient_id', options.patientId)
      if (options.onlyUnacknowledged) query = query.is('acknowledged_at', null)
      if (options.severity) query = query.eq('severity', options.severity)

      const { data, error: err } = await query
      if (err) throw err

      alerts.value = data ?? []
      loaded.value = true
    } catch (e) {
      error.value = toMessage(e, '读取预警列表失败')
    } finally {
      loading.value = false
    }
  }

  /**
   * 取未处理预警的精确总数。
   *
   * `head: true` 让 PostgREST 只返回计数和响应头、不返回任何行数据，
   * 比拉回全部行再在本地统计便宜得多。RLS 依然生效，统计范围仍是
   * 当前用户可见的那些预警。
   */
  async function fetchUnacknowledgedCount(patientId?: string): Promise<void> {
    // 必须先把上一次的错误清掉。否则一次瞬时网络抖动（国内访问 Supabase
    // 很常见）留下的错误会**一直挂在界面上** —— 后续请求即使全部成功，
    // 因为没有清空，用户看到的仍是那条旧错误，只能整页刷新才能消掉。
    error.value = null

    let query = supabase
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .is('acknowledged_at', null)

    // 家属的 RLS 范围是多个监护对象，不指定就统计成所有人的合计
    if (patientId) query = query.eq('patient_id', patientId)

    const { count, error: err } = await query
    if (err) {
      error.value = toMessage(err, '统计未处理预警失败')
      return
    }
    unacknowledgedTotal.value = count ?? 0
  }

  async function create(payload: AlertInsert): Promise<Alert | null> {
    error.value = null
    const { data, error: err } = await supabase
      .from('alerts')
      .insert(payload)
      .select('*')

    if (err) {
      error.value = toMessage(err, '创建预警失败')
      return null
    }

    const created = data?.[0] ?? null
    if (created) alerts.value = [created, ...alerts.value]
    return created
  }

  /**
   * 标记预警为已读 / 取消已读。
   *
   * 家属和治疗师都有这个权限（RLS 的 alerts_update 策略放行监护者），
   * 但只能改 acknowledged_at 和 acknowledged_by 两列 —— 想改 severity
   * 把 critical 降级成 info 会被列级授权直接拒绝。
   */
  async function setAcknowledged(
    id: string,
    acknowledged: boolean,
    operatorId: string | null,
  ): Promise<boolean> {
    error.value = null

    const { data, error: err } = await supabase
      .from('alerts')
      .update({
        acknowledged_at: acknowledged ? new Date().toISOString() : null,
        acknowledged_by: acknowledged ? operatorId : null,
      })
      .eq('id', id)
      .select('*') // 回读确认

    if (err) {
      error.value = toMessage(err, '标记预警失败')
      return false
    }
    // 关键：RLS 对 UPDATE 是静默过滤。无权修改别人的预警时，Supabase
    // 既不返回 error 也不影响任何行。若不回读确认，界面会显示"标记成功"
    // 但刷新后状态又变回去。
    if (!data?.length) {
      error.value = '标记未生效（无权限或预警不存在）'
      return false
    }

    const updated = data[0]
    alerts.value = alerts.value.map((a) => (a.id === id ? updated : a))
    // 已处理数量变了，同步刷新精确计数（用户主动操作，多一次请求无感）
    void fetchUnacknowledgedCount()
    return true
  }

  async function acknowledge(id: string, operatorId: string | null): Promise<boolean> {
    return setAcknowledged(id, true, operatorId)
  }

  async function unacknowledge(id: string): Promise<boolean> {
    return setAcknowledged(id, false, null)
  }

  async function remove(id: string): Promise<boolean> {
    error.value = null
    const { data, error: err } = await supabase
      .from('alerts')
      .delete()
      .eq('id', id)
      .select('id')

    if (err) {
      error.value = toMessage(err, '删除预警失败')
      return false
    }
    if (!data?.length) {
      error.value = '删除未生效（无权限或预警不存在）'
      return false
    }

    alerts.value = alerts.value.filter((a) => a.id !== id)
    return true
  }

  function reset(): void {
    alerts.value = []
    loaded.value = false
    error.value = null
    unacknowledgedTotal.value = 0
  }

  return {
    alerts,
    loading,
    loaded,
    error,
    unacknowledgedTotal,
    unacknowledgedCount,
    criticalCount,
    sorted,
    fetch,
    fetchUnacknowledgedCount,
    create,
    setAcknowledged,
    acknowledge,
    unacknowledge,
    remove,
    reset,
  }
})
