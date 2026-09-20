// ============================================================================
// 设备 store —— 柔性传感器设备列表
// ============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { toMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type { Device, DeviceInsert, DeviceUpdate } from '@/types'

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
   * 拉取当前用户可见的全部设备。
   *
   * 不需要自己加 owner_id 过滤 —— RLS 已经把结果集限定为「自己的 +
   * 自己监护的患者的」。多写一层过滤不仅冗余，还会在监护关系变化时
   * 因为条件写死而漏数据。
   */
  async function fetchAll(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const { data, error: err } = await supabase
        .from('devices')
        .select('*')
        .order('created_at', { ascending: false })

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
    update,
    remove,
    reset,
  }
})
