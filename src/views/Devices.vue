<script setup lang="ts">
// ============================================================================
// 设备管理
// ============================================================================
// 硬件尚未接入，校准与升级是**模拟**操作：界面走完整流程，数据库只记录
// 结果状态（固件版本号、最后在线时间），不真的与设备通信。
// 页面底部有明确标注，不伪装成真实操作。
// ============================================================================
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormItemRule } from 'element-plus'

import StateBlock from '@/components/StateBlock.vue'
import { formatRelative } from '@/lib/format'
import { useDeviceStore } from '@/stores/device'
import { useUserStore } from '@/stores/user'
import type { Device, DeviceStatus } from '@/types'

const devices = useDeviceStore()
const user = useUserStore()

/**
 * 设备页始终看**自己**的设备。
 *
 * 即使家属切到了某个监护对象，绑定/解绑也必须作用在自己的设备上 ——
 * 让家属在这里操作别人的设备，既有权限问题（RLS 的 devices_update
 * 只放行 owner_id = auth.uid()），语义上也不对：设备是患者自己戴的。
 * 查看监护对象的设备状态在数据分析页体现。
 */
function loadDevices() {
  void devices.fetchAll({ ownerId: user.userId ?? undefined })
}

const STATUS_LABEL: Record<DeviceStatus, string> = {
  online: '在线',
  offline: '离线',
  maintenance: '维护中',
}

const STATUS_TAG: Record<DeviceStatus, 'success' | 'info' | 'warning'> = {
  online: 'success',
  offline: 'info',
  maintenance: 'warning',
}

/** 正在执行操作的设备 id —— 按行显示 loading，避免整表转圈 */
const busyId = ref<string | null>(null)

// ---------------------------------------------------------------------------
// 窄屏下的表格处理
// ---------------------------------------------------------------------------
// 「操作」列是 fixed="right" 的，宽度 220px。在 375px 的手机上它会浮在
// 右侧、占掉近 60% 的屏宽，把内容挤到读不了。窄屏时取消固定，让用户
// 横向滚动去够 —— 这是表格在小屏上更常见的处理方式。
const narrow = ref(false)
const mq = window.matchMedia('(max-width: 768px)')
const syncNarrow = () => {
  narrow.value = mq.matches
}
syncNarrow()
mq.addEventListener('change', syncNarrow)
onUnmounted(() => mq.removeEventListener('change', syncNarrow))

const onlineCount = computed(() => devices.onlineCount)

// ---------------------------------------------------------------------------
// 添加设备
// ---------------------------------------------------------------------------
const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const form = reactive({
  serialNo: '',
  model: 'FSIFSTS',
})

const serialRules: FormItemRule[] = [
  { required: true, message: '请输入设备序列号', trigger: 'blur' },
  {
    pattern: /^[A-Za-z0-9-]{4,32}$/,
    message: '序列号只能包含字母、数字和连字符，长度 4–32 位',
    trigger: 'blur',
  },
]

function openDialog() {
  form.serialNo = ''
  form.model = 'FSIFSTS'
  dialogVisible.value = true
  // 对话框渲染完再清校验状态，否则清的是上一次的实例
  requestAnimationFrame(() => formRef.value?.clearValidate())
}

async function submit() {
  if (!formRef.value) return
  // 前置守卫：序列号输入框上的 @keyup.enter 不走按钮的 loading 禁用
  if (submitting.value) return

  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  const ownerId = user.userId
  if (!ownerId) {
    ElMessage.error('未获取到当前用户身份，无法绑定设备')
    return
  }

  submitting.value = true
  try {
    const result = await devices.addDevice(form.serialNo, ownerId, form.model)
    if (result.ok) {
      ElMessage.success(result.message)
      dialogVisible.value = false
    } else {
      ElMessage.error(result.message)
    }
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// 行操作
// ---------------------------------------------------------------------------

/**
 * 把 el-table 插槽给出的 row 收窄回 Device。
 *
 * el-table 的插槽类型是 `DefaultRow`（一个泛型记录），不是 `:data` 的元素
 * 类型 —— 组件内部无法从数据推断出行类型。所以在模板里直接 `calibrate(row)`
 * 会被类型检查拒绝。
 *
 * 值得说明的是：这个错误是**改成按需引入之后才出现的**。此前 el-table 是
 * 未声明的全局组件，插槽参数是 any，这段调用从来没被真正检查过。类型变严
 * 反而是好事，只是需要在这里显式声明一次"我知道这是 Device"。
 */
const asDevice = (row: unknown): Device => row as Device

/** 把 1.0.0 升到 1.1.0；解析不出来就退回一个默认版本 */
function nextFirmware(current: string | null): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current ?? '')
  if (!m) return '1.1.0'
  return `${m[1]}.${Number(m[2]) + 1}.0`
}

/** 模拟一次耗时操作，让界面有真实的过程感 */
function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function calibrate(row: Device) {
  busyId.value = row.id
  try {
    await simulateDelay(1200)
    const ok = await devices.touch(row.id)
    ok
      ? ElMessage.success(`「${row.serial_no}」校准完成，基线已重置`)
      : ElMessage.error(devices.error ?? '校准失败')
  } finally {
    busyId.value = null
  }
}

async function upgrade(row: Device) {
  const target = nextFirmware(row.firmware)
  try {
    await ElMessageBox.confirm(
      `将「${row.serial_no}」的固件从 ${row.firmware ?? '未知'} 升级到 ${target}？` +
        '升级过程中请保持设备连接。',
      '固件升级',
      { confirmButtonText: '开始升级', cancelButtonText: '取消', type: 'info' },
    )
  } catch {
    return // 用户取消
  }

  busyId.value = row.id
  try {
    // 模拟升级耗时。真实实现里这里应当是一个带进度回报的长连接，
    // 而不是一个固定的等待
    await simulateDelay(2500)
    const ok = await devices.upgradeFirmware(row.id, target)
    ok
      ? ElMessage.success(`已升级到 ${target}`)
      : ElMessage.error(devices.error ?? '升级失败')
  } finally {
    busyId.value = null
  }
}

async function unbind(row: Device) {
  try {
    await ElMessageBox.confirm(
      `解绑「${row.serial_no}」后，该设备将从列表中移除，` +
        '历史训练记录会保留但不再关联到这台设备。',
      '确认解绑',
      { confirmButtonText: '解绑', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  busyId.value = row.id
  try {
    const ok = await devices.unbind(row.id)
    ok
      ? ElMessage.success('已解绑。若需重新绑定，用同一序列号再添加一次即可。')
      : ElMessage.error(devices.error ?? '解绑失败')
  } finally {
    busyId.value = null
  }
}

// ---------------------------------------------------------------------------

onMounted(loadDevices)
</script>

<template>
  <div class="devices">
    <!-- 概要 -->
    <section class="summary">
      <div class="summary__item">
        <span class="summary__label">已绑定设备</span>
        <p class="summary__value">{{ devices.devices.length }}</p>
      </div>
      <div class="summary__item">
        <span class="summary__label">在线</span>
        <p class="summary__value">{{ onlineCount }}</p>
      </div>
      <div class="summary__item">
        <span class="summary__label">离线 / 维护</span>
        <p class="summary__value">
          {{ devices.devices.length - onlineCount }}
        </p>
      </div>
    </section>

    <!-- 表格 -->
    <section class="panel">
      <header class="panel__head">
        <h2 class="panel__title">设备列表</h2>
        <div class="panel__actions">
          <el-button :loading="devices.loading" @click="loadDevices">
            刷新
          </el-button>
          <el-button type="primary" @click="openDialog">添加设备</el-button>
        </div>
      </header>

      <!-- 拉取失败时给出重试出口；表格自带的 empty-text 只覆盖"确实没有数据" -->
      <StateBlock :error="devices.error" @retry="loadDevices" />

      <el-table
        v-loading="devices.loading"
        :data="devices.devices"
        style="width: 100%"
        empty-text="还没有绑定设备。点右上角「添加设备」输入序列号即可绑定。"
      >
        <el-table-column label="序列号" min-width="150">
          <template #default="{ row }">
            <span class="mono">{{ row.serial_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="model" label="型号" width="110" />

        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status as DeviceStatus]" size="small">
              {{ STATUS_LABEL[row.status as DeviceStatus] }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="电量" width="120">
          <template #default="{ row }">
            <div v-if="row.battery_pct != null" class="battery">
              <div class="battery__track">
                <div
                  class="battery__fill"
                  :class="{
                    'battery__fill--low': row.battery_pct < 20,
                    'battery__fill--mid':
                      row.battery_pct >= 20 && row.battery_pct < 50,
                  }"
                  :style="{ width: `${row.battery_pct}%` }"
                />
              </div>
              <span class="battery__text">{{ row.battery_pct }}%</span>
            </div>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="固件" width="100">
          <template #default="{ row }">
            <span class="mono">{{ row.firmware ?? '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="最后在线" min-width="120">
          <template #default="{ row }">
            <span class="muted">{{ formatRelative(row.last_seen_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column
          label="操作"
          width="220"
          :fixed="narrow ? false : 'right'"
        >
          <template #default="{ row }">
            <el-button
              size="small"
              :loading="busyId === row.id"
              @click="calibrate(asDevice(row))"
            >
              校准
            </el-button>
            <el-button
              size="small"
              :disabled="busyId === row.id"
              @click="upgrade(asDevice(row))"
            >
              升级
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="busyId === row.id"
              @click="unbind(asDevice(row))"
            >
              解绑
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <p class="footnote">
      硬件尚未接入，<strong>校准</strong>与<strong>升级</strong>为模拟操作：
      界面走完整流程，数据库只记录结果状态（固件版本号、最后在线时间），
      不真的与设备通信。解绑是真实操作 —— 会把设备的归属置空，
      之后可用同一序列号重新添加。
    </p>

    <!-- 添加设备对话框 -->
    <el-dialog
      v-model="dialogVisible"
      title="添加设备"
      width="440px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="formRef"
        :model="form"
        label-position="top"
        @submit.prevent="submit"
      >
        <el-form-item label="设备序列号" prop="serialNo" :rules="serialRules">
          <el-input
            v-model="form.serialNo"
            placeholder="如 FSIFSTS-2026-0001"
            :disabled="submitting"
            @keyup.enter="submit"
          />
          <p class="field-hint">
            序列号印在设备背面。若该设备此前被解绑，用同一序列号即可重新认领。
          </p>
        </el-form-item>

        <el-form-item label="型号" prop="model">
          <el-input v-model="form.model" disabled />
          <p class="field-hint">当前仅支持自研型号 FSIFSTS。</p>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button :disabled="submitting" @click="dialogVisible = false">
          取消
        </el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          绑定
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.devices {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 概要 ---------- */
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.summary__item {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.summary__label {
  font-size: 12px;
  color: var(--ink-400);
}

.summary__value {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--ink-800);
  font-variant-numeric: tabular-nums;
}

/* ---------- 表格面板 ---------- */
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.panel__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-800);
}

.panel__actions {
  display: flex;
  gap: 8px;
}

/* ---------- 单元格 ---------- */
.mono {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 13px;
}

.muted {
  color: var(--ink-300);
  font-size: 13px;
}

.battery {
  display: flex;
  align-items: center;
  gap: 8px;
}

.battery__track {
  flex: 1;
  height: 6px;
  min-width: 40px;
  border-radius: var(--r-xs);
  background: var(--line-soft);
  overflow: hidden;
}

.battery__fill {
  height: 100%;
  border-radius: var(--r-xs);
  background: var(--ok);
  transition: width 0.3s;
}

.battery__fill--mid {
  background: var(--warn);
}

.battery__fill--low {
  background: var(--danger);
}

.battery__text {
  font-size: 12px;
  color: var(--ink-600);
  font-variant-numeric: tabular-nums;
}

/* ---------- 其他 ---------- */
.footnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-300);
}

.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-400);
}
</style>
