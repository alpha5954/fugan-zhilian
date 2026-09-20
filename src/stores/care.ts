// ============================================================================
// 监护关系 store
// ============================================================================
// 同一张 care_links 表从两侧看含义不同：
//   患者侧 —— "谁在监护我"（incoming 待确认 / myCaregivers 已生效）
//   家属侧 —— "我在监护谁"（outgoing 待确认 / myPatients 已生效）
// 所以 store 用同一个列表，按当前用户 id 分出四个视图。
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { useUserStore } from '@/stores/user'
import type { CareLinkRequestResult, CareLinkWithName, CareRelation } from '@/types'

export const useCareStore = defineStore('care', () => {
  const user = useUserStore()

  const links = ref<CareLinkWithName[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const me = computed(() => user.userId)

  /** 待我确认的申请（我是患者） */
  const incoming = computed(() =>
    links.value.filter((l) => l.patient_id === me.value && l.status === 'pending'),
  )

  /** 我发出的、等待对方确认的申请（我是家属/治疗师） */
  const outgoing = computed(() =>
    links.value.filter((l) => l.caregiver_id === me.value && l.status === 'pending'),
  )

  /** 正在监护我的人（已生效） */
  const myCaregivers = computed(() =>
    links.value.filter((l) => l.patient_id === me.value && l.status === 'active'),
  )

  /** 我正在监护的人（已生效）—— 家属视角的"可查看对象"列表 */
  const myPatients = computed(() =>
    links.value.filter((l) => l.caregiver_id === me.value && l.status === 'active'),
  )

  /** 我是否有监护对象。数据页面据此决定要不要显示"查看对象"切换器 */
  const hasPatients = computed(() => myPatients.value.length > 0)

  /** 待办数量：待确认的申请 + 我发出待回应的申请，用于导航栏角标 */
  const pendingCount = computed(
    () => incoming.value.length + outgoing.value.length,
  )

  // -------------------------------------------------------------------------
  // 当前查看对象
  // -------------------------------------------------------------------------
  // 家属登录后，RLS 会把**所有**监护对象的训练记录一并返回。各数据页面
  // 必须显式指定看谁的，否则会把几个人的数据混在一张图里。
  // 患者本人用不到这个 —— viewingPatientId 为空时就是看自己。

  /** 家属选定的查看对象；null 表示看自己的数据 */
  const viewingPatientId = ref<string | null>(null)

  /**
   * 当前实际查看的患者 id。
   *
   * 未登录时返回 undefined 而不是 null —— 各 store 的查询选项都用
   * `patientId?: string` 表示"不指定"，用 null 会在类型上对不上，
   * 也容易被误当成一个真实的 id 传下去。
   */
  const activePatientId = computed<string | undefined>(
    () => viewingPatientId.value ?? user.userId ?? undefined,
  )

  /** 是否正在查看别人的数据 */
  const isViewingOther = computed(
    () =>
      viewingPatientId.value !== null && viewingPatientId.value !== user.userId,
  )

  /** 当前查看对象的显示名，用于页面上的提示条 */
  const activePatientName = computed(() => {
    if (!isViewingOther.value) return user.displayName
    return (
      myPatients.value.find((l) => l.patient_id === viewingPatientId.value)
        ?.counterpart_name ?? '监护对象'
    )
  })

  function setViewing(patientId: string | null): void {
    viewingPatientId.value = patientId
  }

  // -------------------------------------------------------------------------

  async function fetchAll(): Promise<void> {
    const uid = me.value
    if (!uid) return

    loading.value = true
    error.value = null
    try {
      // 不写 .or(patient_id.eq..., caregiver_id.eq...)：RLS 的 care_links_select
      // 本来就只返回与当前用户相关的行，前端再过滤一遍是冗余的，
      // 而且关系变化时容易因为条件写死而漏掉
      const [linksRes, namesRes] = await Promise.all([
        supabase.from('care_links').select('*').order('created_at', { ascending: false }),
        // 姓名单独取 —— 待确认阶段双方读不到对方资料，见迁移 8
        supabase.rpc('get_care_counterparts'),
      ])

      if (linksRes.error) throw linksRes.error
      if (namesRes.error) throw namesRes.error

      const names = new Map(
        (namesRes.data ?? []).map((n) => [n.link_id, n] as const),
      )

      links.value = (linksRes.data ?? []).map((l) => {
        const n = names.get(l.id)
        return {
          ...l,
          counterpart_id: n?.counterpart_id ?? '',
          counterpart_name: n?.display_name ?? null,
        }
      })
      loaded.value = true
    } catch (e) {
      error.value = toMessage(e, '读取监护关系失败')
    } finally {
      loading.value = false
    }
  }

  /**
   * 凭邀请码发起监护申请。
   *
   * 返回值直接把 RPC 的 reason 透给调用方，界面据此给出准确提示
   * （邀请码无效 / 已申请过 / 不能加自己 …），而不是笼统的"操作失败"。
   */
  async function requestByCode(
    code: string,
    relation: CareRelation = 'family',
  ): Promise<CareLinkRequestResult> {
    error.value = null

    const { data, error: err } = await supabase.rpc('request_care_link', {
      // 手输的码容易带空格或写成小写，这里先规整；服务端也会再处理一次
      p_code: code.trim().toUpperCase(),
      p_relation: relation,
    })

    if (err) {
      error.value = toMessage(err, '提交申请失败')
      return { ok: false, reason: 'not_authenticated', message: error.value }
    }

    const result = data as CareLinkRequestResult
    if (result.ok) await fetchAll()
    return result
  }

  /**
   * 把关系改成某个状态。
   *
   * 只能改 status —— 迁移 6 用列级授权把 care_links 的可更新列收窄到了
   * 只剩这一列，改 relation 或 patient_id 会被数据库直接拒绝。
   *
   * 注意"确认生效"只有患者本人能做，这是触发器强制的一行级规则，
   * 家属调用同样会失败并返回明确原因。
   */
  async function setStatus(
    linkId: string,
    status: 'active' | 'revoked',
  ): Promise<boolean> {
    error.value = null

    const { data, error: err } = await supabase
      .from('care_links')
      .update({ status })
      .eq('id', linkId)
      .select('*') // 回读确认：RLS 对 UPDATE 是静默过滤，无权限时不报错也不影响行

    if (err) {
      error.value = toMessage(err, '操作失败')
      return false
    }
    if (!data?.length) {
      error.value = '操作未生效（无权限或关系不存在）'
      return false
    }

    await fetchAll()
    return true
  }

  /** 患者确认申请 */
  function approve(linkId: string): Promise<boolean> {
    return setStatus(linkId, 'active')
  }

  /** 撤销关系，或家属主动退出，或拒绝申请 —— 三者都是改成 revoked */
  function revoke(linkId: string): Promise<boolean> {
    return setStatus(linkId, 'revoked')
  }

  function reset(): void {
    links.value = []
    loaded.value = false
    error.value = null
    viewingPatientId.value = null
  }

  return {
    links,
    loading,
    loaded,
    error,

    incoming,
    outgoing,
    myCaregivers,
    myPatients,
    hasPatients,
    pendingCount,

    viewingPatientId,
    activePatientId,
    isViewingOther,
    activePatientName,

    fetchAll,
    requestByCode,
    setStatus,
    approve,
    revoke,
    setViewing,
    reset,
  }
})
