// ============================================================================
// 设备 store —— 柔性传感器设备列表
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type {
  ClaimDeviceResult,
  Device,
  DeviceInsert,
  DeviceUpdate,
} from '@/types'

export const useDeviceStore = defineStore('device', () => {
  const devices = ref<Device[]>([])
  const loading = ref(false)
  /** 是否已成功拉取过一次 —— 用来区分"空列表"和"还没查" */
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const onlineCount = computed(
    () => devices.value.filter((d) => d.status === 'online').length,
  )

  const byId = computed(
    () => (id: string) => devices.value.find((d) => d.id === id) ?? null,
  )

  /**
   * 拉取设备列表。
   *
   * RLS 已经把结果集限定为「自己的 + 自己监护的患者的」。但对家属来说，
   * 那是**多个人的设备混在一起** —— 所以查看特定对象时必须显式加
   * ownerId 过滤，否则会把几个监护对象的设备画进同一张表。
   *
   * 不传 ownerId 时返回全部可见设备（患者本人看到的就只是自己的）。
   */
  async function fetchAll(options: { ownerId?: string } = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      let query = supabase
        .from('devices')
        .select('*')
        .order('created_at', { ascending: false })

      if (options.ownerId) query = query.eq('owner_id', options.ownerId)

      const { data, error: err } = await query
      if (err) throw err

      devices.value = data ?? []
      loaded.value = true
    } catch (e) {
      error.value = toMessage(e, '读取设备列表失败')
    } finally {
      loading.value = false
    }
  }

  async function create(payload: DeviceInsert): Promise<Device | null> {
    error.value = null
    const { data, error: err } = await supabase
      .from('devices')
      .insert(payload)
      .select('*')

    if (err) {
      error.value = toMessage(err, '添加设备失败')
      return null
    }
    // insert 有权重校验，无权时直接报错，所以这里不需要回读兜底；
    // 但 .select() 仍要加 —— 没有它拿不到数据库生成的 id 和时间戳
    const created = data?.[0] ?? null
    if (created) devices.value = [created, ...devices.value]
    return created
  }

  /**
   * 添加设备：先尝试认领系统中已存在的无主设备，查无此序列号才登记新设备。
   *
   * 两步合成一个对外动作 —— 用户不关心这台设备是"别人解绑回收的"还是
   * "刚出厂的"，他只知道自己填了个序列号、然后就该绑上。
   *
   * 认领走的是 claim_device() RPC 而不是直接 UPDATE：未绑定设备对普通用户
   * 不可见（RLS 过滤 owner_id is null），直接 UPDATE 根本够不到那一行。
   */
  async function addDevice(
    serialNo: string,
    ownerId: string,
    model = 'FSIFSTS',
  ): Promise<{ ok: boolean; message: string }> {
    const serial = serialNo.trim()
    if (!serial) return { ok: false, message: '请填写设备序列号' }

    error.value = null

    // 1. 先试认领
    const { data, error: rpcErr } = await supabase.rpc('claim_device', {
      p_serial: serial,
    })

    if (rpcErr) {
      error.value = toMessage(rpcErr, '绑定设备失败')
      return { ok: false, message: error.value }
    }

    const result = data as ClaimDeviceResult | null

    if (result?.ok) {
      // 认领成功时本地列表里还没有这台设备，重新拉一次
      await fetchAll()
      return { ok: true, message: result.message }
    }

    // 2. 系统里没有这个序列号 → 当作新设备登记
    if (result?.reason === 'not_found') {
      const created = await create({
        serial_no: serial,
        owner_id: ownerId,
        model,
        status: 'online',
        battery_pct: 100,
        firmware: '1.0.0',
        last_seen_at: new Date().toISOString(),
      })
      return created
        ? { ok: true, message: '已登记新设备并完成绑定' }
        : { ok: false, message: error.value ?? '登记设备失败' }
    }

    return { ok: false, message: result?.message ?? '绑定失败' }
  }

  /**
   * 解绑设备。
   *
   * 置 owner_id 为 null 而不是删行 —— 历史训练记录通过 device_id 关联到
   * 设备，删行会切断这层关联。代价是设备变回无主状态，需要时可以用
   * addDevice() 重新认领。
   */
  async function unbind(id: string): Promise<boolean> {
    error.value = null

    const { data, error: err } = await supabase
      .from('devices')
      .update({ owner_id: null })
      .eq('id', id)
      .select('id')

    if (err) {
      error.value = toMessage(err, '解绑失败')
      return false
    }
    if (!data?.length) {
      error.value = '解绑未生效（无权限或设备不存在）'
      return false
    }

    // 解绑后该设备立即对当前用户不可见，本地列表必须一并移除 ——
    // 留着会变成一条再也操作不了的僵尸记录
    devices.value = devices.value.filter((d) => d.id !== id)
    return true
  }

  /** 固件升级（模拟）：写入新版本号，代表设备已完成升级 */
  async function upgradeFirmware(id: string, version: string): Promise<boolean> {
    return update(id, {
      firmware: version,
      last_seen_at: new Date().toISOString(),
    })
  }

  /** 校准（模拟）：刷新最后在线时间，代表设备响应了校准指令 */
  async function touch(id: string): Promise<boolean> {
    return update(id, { last_seen_at: new Date().toISOString() })
  }

  async function update(id: string, patch: DeviceUpdate): Promise<boolean> {
    error.value = null
    const { data, error: err } = await supabase
      .from('devices')
      .update(patch)
      .eq('id', id)
      .select('*') // 回读确认，见下方说明

    if (err) {
      error.value = toMessage(err, '更新设备失败')
      return false
    }
    // RLS 对 UPDATE 是静默过滤：改别人的设备不报错、影响 0 行。
    // 不回读就无法分辨"改成功了"和"什么都没发生"。
    if (!data?.length) {
      error.value = '更新未生效（无权限或设备不存在）'
      return false
    }

    const updated = data[0]
    devices.value = devices.value.map((d) => (d.id === id ? updated : d))
    return true
  }

  async function remove(id: string): Promise<boolean> {
    error.value = null
    const { data, error: err } = await supabase
      .from('devices')
      .delete()
      .eq('id', id)
      .select('id') // 同样需要回读：删除也是静默过滤

    if (err) {
      error.value = toMessage(err, '删除设备失败')
      return false
    }
    if (!data?.length) {
      error.value = '删除未生效（无权限或设备不存在）'
      return false
    }

    devices.value = devices.value.filter((d) => d.id !== id)
    return true
  }

  function reset(): void {
    devices.value = []
    loaded.value = false
    error.value = null
  }

  return {
    devices,
    loading,
    loaded,
    error,
    onlineCount,
    byId,
    fetchAll,
    create,
    addDevice,
    unbind,
    upgradeFirmware,
    touch,
    update,
    remove,
    reset,
  }
})
