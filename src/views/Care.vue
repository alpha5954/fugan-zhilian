<script setup lang="ts">
// ============================================================================
// 监护关系管理
// ============================================================================
// 同一个页面服务两种身份，分区展示：
//   患者侧 —— 我的邀请码、待我确认的申请、正在监护我的人
//   家属侧 —— 凭码发起申请、我发出的申请、我正在监护的人
//
// 一个用户可能同时是两者（比如治疗师自己也是术后患者），所以各分区
// 独立判断、互不排斥，而不是"二选一"的页面切换。
// ============================================================================
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormItemRule } from 'element-plus'

import StateBlock from '@/components/StateBlock.vue'
import { useCareStore } from '@/stores/care'
import { useUserStore } from '@/stores/user'
import type { CareLinkWithName, CareRelation } from '@/types'

const care = useCareStore()
const user = useUserStore()
const router = useRouter()

// ---------------------------------------------------------------------------
// 邀请码
// ---------------------------------------------------------------------------
const inviteCode = computed(() => user.profile?.invite_code ?? '')
const copied = ref(false)

async function copyCode() {
  if (!inviteCode.value) return
  try {
    await navigator.clipboard.writeText(inviteCode.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // 剪贴板 API 在非 HTTPS 或用户拒绝时会失败。不要静默 —— 用户会以为复制成功了
    ElMessage.warning('复制失败，请手动选中邀请码复制')
  }
}

// ---------------------------------------------------------------------------
// 发起申请
// ---------------------------------------------------------------------------
const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  code: '',
  relation: 'family' as CareRelation,
})

const codeRules: FormItemRule[] = [
  { required: true, message: '请输入对方提供的邀请码', trigger: 'blur' },
  {
    pattern: /^[A-Za-z0-9]{6}$/,
    message: '邀请码是 6 位字母数字',
    trigger: 'blur',
  },
]

async function submit() {
  if (!formRef.value) return
  // 前置守卫：输入框上的回车不走按钮的 loading 禁用
  if (submitting.value) return

  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const result = await care.requestByCode(form.code, form.relation)
    if (result.ok) {
      ElMessage.success(result.message)
      form.code = ''
      formRef.value.clearValidate()
    } else {
      ElMessage.error(result.message)
    }
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// 关系操作
// ---------------------------------------------------------------------------
const busyId = ref<string | null>(null)

async function approve(link: CareLinkWithName) {
  busyId.value = link.id
  try {
    const ok = await care.approve(link.id)
    ok
      ? ElMessage.success(`已确认与「${displayName(link)}」的监护关系`)
      : ElMessage.error(care.error ?? '确认失败')
  } finally {
    busyId.value = null
  }
}

async function revoke(link: CareLinkWithName, self: 'patient' | 'caregiver') {
  const who = displayName(link)
  const isReject = self === 'patient' && link.status === 'pending'

  try {
    await ElMessageBox.confirm(
      isReject
        ? `拒绝「${who}」的监护申请？拒绝后对方将无法查看你的数据。`
        : `解除与「${who}」的监护关系？解除后对方立即无法查看你的数据。`,
      isReject ? '拒绝申请' : '解除关系',
      {
        confirmButtonText: isReject ? '拒绝' : '解除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  busyId.value = link.id
  try {
    const ok = await care.revoke(link.id)
    ok
      ? ElMessage.success(isReject ? '已拒绝该申请' : '已解除关系')
      : ElMessage.error(care.error ?? '操作失败')
  } finally {
    busyId.value = null
  }
}

/** 切到该监护对象的数据视图 */
function viewData(link: CareLinkWithName) {
  care.setViewing(link.patient_id)
  router.push({ name: 'dashboard' })
}

// ---------------------------------------------------------------------------

function displayName(link: CareLinkWithName): string {
  return link.counterpart_name || '未命名用户'
}

const RELATION_LABEL: Record<CareRelation, string> = {
  family: '家属',
  therapist: '治疗师',
}

const hasAnyRelation = computed(
  () =>
    care.incoming.length +
      care.outgoing.length +
      care.myCaregivers.length +
      care.myPatients.length >
    0,
)

onMounted(() => {
  void care.fetchAll()
})
</script>

<template>
  <div class="care">
    <!-- ================= 左栏 ================= -->
    <aside class="care__side">
      <!-- 我的邀请码 -->
      <section class="panel">
        <h2 class="panel__title">我的邀请码</h2>
        <p class="panel__desc">
          把这个码发给家人或治疗师，对方凭码就能向你发起监护申请。
          只有你本人能在下方确认是否同意。
        </p>

        <div v-if="inviteCode" class="code">
          <span class="code__value">{{ inviteCode }}</span>
          <el-button size="small" @click="copyCode">
            {{ copied ? '已复制' : '复制' }}
          </el-button>
        </div>
        <el-skeleton v-else :rows="1" animated />

        <p class="panel__note">
          邀请码不可修改 —— 能改就意味着别人可以冒用你的码接收申请。
          如果不慎泄露，可以联系管理员重置。
        </p>
      </section>

      <!-- 发起申请 -->
      <section class="panel">
        <h2 class="panel__title">添加监护对象</h2>
        <p class="panel__desc">
          输入对方给你的邀请码，提交后需等对方确认才会生效。
        </p>

        <el-form
          ref="formRef"
          :model="form"
          label-position="top"
          @submit.prevent="submit"
        >
          <el-form-item label="邀请码" prop="code" :rules="codeRules">
            <el-input
              v-model="form.code"
              placeholder="6 位字母数字"
              maxlength="6"
              class="code-input"
              :disabled="submitting"
              @keyup.enter="submit"
            />
          </el-form-item>

          <el-form-item label="关系">
            <el-radio-group v-model="form.relation" :disabled="submitting">
              <el-radio value="family">家属</el-radio>
              <el-radio value="therapist">治疗师</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-button
            type="primary"
            class="full"
            :loading="submitting"
            @click="submit"
          >
            提交申请
          </el-button>
        </el-form>
      </section>
    </aside>

    <!-- ================= 右栏 ================= -->
    <div class="care__main">
      <StateBlock
        :loading="care.loading"
        :error="care.error"
        :empty="!hasAnyRelation"
        empty-text="还没有监护关系。把左侧的邀请码发给家人，或输入对方的邀请码发起申请。"
        @retry="care.fetchAll()"
      >
        <!-- 待我确认 -->
        <section v-if="care.incoming.length" class="panel">
          <h2 class="panel__title">
            待我确认
            <el-badge :value="care.incoming.length" type="danger" />
          </h2>

          <div v-for="link in care.incoming" :key="link.id" class="row">
            <div class="row__main">
              <span class="row__name">{{ displayName(link) }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ RELATION_LABEL[link.relation] }}
              </el-tag>
              <el-tag size="small" type="warning" effect="plain">待确认</el-tag>
            </div>
            <div class="row__actions">
              <el-button
                size="small"
                type="primary"
                :loading="busyId === link.id"
                @click="approve(link)"
              >
                确认
              </el-button>
              <el-button
                size="small"
                :disabled="busyId === link.id"
                @click="revoke(link, 'patient')"
              >
                拒绝
              </el-button>
            </div>
          </div>

          <p class="panel__note">
            确认后对方即可查看你的训练记录、设备状态与预警，但<strong>不能修改</strong>你的任何资料。
          </p>
        </section>

        <!-- 我发出的申请 -->
        <section v-if="care.outgoing.length" class="panel">
          <h2 class="panel__title">我发出的申请</h2>

          <div v-for="link in care.outgoing" :key="link.id" class="row">
            <div class="row__main">
              <span class="row__name">{{ displayName(link) }}</span>
              <el-tag size="small" type="info" effect="plain">
                {{ RELATION_LABEL[link.relation] }}
              </el-tag>
              <el-tag size="small" type="warning" effect="plain">
                等待对方确认
              </el-tag>
            </div>
            <div class="row__actions">
              <el-button
                size="small"
                :disabled="busyId === link.id"
                @click="revoke(link, 'caregiver')"
              >
                撤回
              </el-button>
            </div>
          </div>
        </section>

        <!-- 我正在监护的人 -->
        <section v-if="care.myPatients.length" class="panel">
          <h2 class="panel__title">我正在监护的人</h2>

          <div v-for="link in care.myPatients" :key="link.id" class="row">
            <div class="row__main">
              <span class="row__name">{{ displayName(link) }}</span>
              <el-tag size="small" type="success" effect="plain">
                {{ RELATION_LABEL[link.relation] }}
              </el-tag>
            </div>
            <div class="row__actions">
              <el-button size="small" @click="viewData(link)">查看数据</el-button>
              <el-button
                size="small"
                :disabled="busyId === link.id"
                @click="revoke(link, 'caregiver')"
              >
                解除
              </el-button>
            </div>
          </div>

          <p class="panel__note">
            点「查看数据」后，各数据页面会切换到该对象；顶部会出现返回自己的提示条。
          </p>
        </section>

        <!-- 正在监护我的人 -->
        <section v-if="care.myCaregivers.length" class="panel">
          <h2 class="panel__title">正在监护我的人</h2>

          <div v-for="link in care.myCaregivers" :key="link.id" class="row">
            <div class="row__main">
              <span class="row__name">{{ displayName(link) }}</span>
              <el-tag size="small" type="success" effect="plain">
                {{ RELATION_LABEL[link.relation] }}
              </el-tag>
            </div>
            <div class="row__actions">
              <el-button
                size="small"
                :disabled="busyId === link.id"
                @click="revoke(link, 'patient')"
              >
                解除
              </el-button>
            </div>
          </div>
        </section>
      </StateBlock>
    </div>
  </div>
</template>

<style scoped>
.care {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 900px) {
  .care {
    grid-template-columns: 1fr;
  }
}

.care__side,
.care__main {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 面板 ---------- */
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
}

.panel__title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink-800);
}

.panel__desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-600);
}

.panel__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-300);
}

.panel__note strong {
  color: var(--ink-400);
}

/* ---------- 邀请码 ---------- */
.code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--r-sm);
  background: linear-gradient(135deg, var(--brand-50) 0%, var(--brand-100) 100%);
  border: 1px dashed var(--brand-300);
}

.code__value {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 4px;
  color: var(--brand-800);
}

.code-input :deep(.el-input__inner) {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 16px;
  letter-spacing: 4px;
  text-transform: uppercase;
}

.full {
  width: 100%;
}

/* ---------- 关系行 ---------- */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-sm);
}

.row__main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.row__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-800);
}

.row__actions {
  display: flex;
  gap: 8px;
}
</style>
