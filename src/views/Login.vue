<script setup lang="ts">
// ============================================================================
// 登录 / 注册页
// ============================================================================
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormItemRule } from 'element-plus'

import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

type Mode = 'signin' | 'signup'

const mode = ref<Mode>('signin')
const formRef = ref<FormInstance>()
const submitting = ref(false)
/** 注册需要邮箱确认时的成功提示 */
const notice = ref('')

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  displayName: '',
  role: 'patient' as 'patient' | 'family',
})

// ---------------------------------------------------------------------------
// 校验规则
// ---------------------------------------------------------------------------
const emailRules: FormItemRule[] = [
  { required: true, message: '请输入邮箱', trigger: 'blur' },
  { type: 'email', message: '邮箱格式不正确', trigger: ['blur', 'change'] },
]

const passwordRules = computed<FormItemRule[]>(() => [
  { required: true, message: '请输入密码', trigger: 'blur' },
  // Supabase 默认只要求 6 位，这里收紧到 8 位。
  // 注册时若填了短密码，会被这里拦下而不是等服务端报错。
  { min: 8, message: '密码至少 8 位', trigger: 'blur' },
])

const confirmRules = computed<FormItemRule[]>(() => [
  { required: true, message: '请再次输入密码', trigger: 'blur' },
  {
    validator: (_rule, value: string, callback) => {
      if (value !== form.password) callback(new Error('两次输入的密码不一致'))
      else callback()
    },
    trigger: 'blur',
  },
])

// 切换登录/注册时清掉上一次的报错和提示，否则会残留一个对不上的错误信息
watch(mode, () => {
  user.error = null
  notice.value = ''
  formRef.value?.clearValidate()
})

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------
async function handleSubmit() {
  if (!formRef.value) return
  // 前置守卫：按钮的 loading 会禁用点击，但输入框上的 @keyup.enter
  // 不走按钮，快速连按回车能绕过去，重复发起请求
  if (submitting.value) return

  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  notice.value = ''

  try {
    if (mode.value === 'signin') {
      // ⚠️ 访客用已有账号登录会**替换掉当前会话**：匿名账号连同它里面的
      //    数据会变成孤儿，不会跟随到新账号。这是最容易让人丢数据的操作，
      //    必须先讲清楚再让用户决定。
      if (user.isGuest) {
        try {
          await ElMessageBox.confirm(
            '登录已有账号后，当前访客模式下的数据（绑定的设备、保存的训练记录）' +
              '会留在临时账号里，不会跟随过来。\n\n' +
              '想保留这些数据，请改用「保存账号」把当前访客账号升级为正式账号。',
            '当前处于访客模式',
            {
              confirmButtonText: '仍要登录',
              cancelButtonText: '返回',
              type: 'warning',
            },
          )
        } catch {
          return // 用户选择返回
        }
      }

      if (await user.signIn(form.email, form.password)) {
        goAfterAuth()
      }
      return
    }

    // ---- 注册 ----

    // 访客走「升级当前账号」，uid 不变，数据完整保留
    if (user.isGuest) {
      const r = await user.upgradeGuest(
        form.email,
        form.password,
        form.displayName,
      )
      if (!r.ok) return

      if (r.pendingEmail) {
        // 项目开启了邮箱确认：新邮箱处于待确认状态
        notice.value =
          `确认邮件已发送到 ${r.pendingEmail}，请点击邮件中的链接完成验证。` +
          '验证前你仍可以访客身份继续使用，数据不会丢失。'
        mode.value = 'signin'
        return
      }

      ElMessage.success('账号已保存，访客期间的数据全部保留')
      goAfterAuth()
      return
    }

    // 非访客的常规注册（正常流程下走不到 —— 每个访客进来都已持有匿名会话，
    // 但若控制台没开启匿名登录、用户从兜底路径来到这里，仍需要能注册）
    const result = await user.signUp(form.email, form.password, {
      displayName: form.displayName,
      role: form.role,
    })
    if (!result.ok) return

    if (result.needsEmailConfirmation) {
      notice.value =
        `确认邮件已发送到 ${form.email}，请点击邮件中的链接完成验证，然后再登录。`
      form.password = ''
      form.confirmPassword = ''
      mode.value = 'signin'
    } else {
      goAfterAuth()
    }
  } finally {
    submitting.value = false
  }
}

/** 登录成功后的跳转目标 */
function goAfterAuth() {
  const raw = route.query.redirect

  // 只接受站内绝对路径，且排除 // 开头（协议相对 URL，可被用来跳去外站）。
  // route.query 完全由 URL 控制，不校验就等于开放重定向漏洞。
  const target =
    typeof raw === 'string' &&
    raw.startsWith('/') &&
    !raw.startsWith('//')
      ? raw
      : '/dashboard'

  router.replace(target)
}

const submitLabel = computed(() => {
  if (mode.value === 'signin') return '登录'
  return user.isGuest ? '保存账号' : '注册'
})

/** 访客模式下第二个标签不叫"注册" —— 那是升级当前账号，不是新建 */
const signupTabLabel = computed(() => (user.isGuest ? '保存账号' : '注册'))
</script>

<template>
  <div class="login">
    <div class="login__panel">
      <div class="login__brand">
        <span class="login__brand-mark">复</span>
        <span class="login__brand-text">复感智联 · 智能评估系统</span>
      </div>

      <!-- 访客提示：说清"保存账号"到底做了什么，否则用户会以为是新建一个号 -->
      <el-alert
        v-if="user.isGuest"
        type="info"
        :closable="false"
        show-icon
        class="login__guest"
      >
        <template #title>当前是访客模式</template>
        <p class="login__guest-text">
          你正在使用一个临时账号，数据已经存在云端，但换设备或清理浏览器后就找不回来了。
          设置邮箱和密码即可把它变成正式账号 —— <strong>当前的所有数据都会保留</strong>。
        </p>
      </el-alert>

      <div class="login__tabs">
        <button
          type="button"
          class="login__tab"
          :class="{ 'is-active': mode === 'signin' }"
          @click="mode = 'signin'"
        >
          登录
        </button>
        <button
          type="button"
          class="login__tab"
          :class="{ 'is-active': mode === 'signup' }"
          @click="mode = 'signup'"
        >
          {{ signupTabLabel }}
        </button>
      </div>

      <el-alert
        v-if="notice"
        :title="notice"
        type="success"
        :closable="false"
        show-icon
        class="login__alert"
      />

      <el-form
        ref="formRef"
        :model="form"
        label-position="top"
        @submit.prevent="handleSubmit"
      >
        <el-form-item label="邮箱" prop="email" :rules="emailRules">
          <el-input
            v-model="form.email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item
          v-if="mode === 'signup'"
          label="昵称"
          prop="displayName"
        >
          <el-input
            v-model="form.displayName"
            placeholder="选填，不填则用邮箱前缀"
            maxlength="20"
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password" :rules="passwordRules">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 8 位"
            show-password
            :autocomplete="mode === 'signin' ? 'current-password' : 'new-password'"
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item
          v-if="mode === 'signup'"
          label="确认密码"
          prop="confirmPassword"
          :rules="confirmRules"
        >
          <el-input
            v-model="form.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :disabled="submitting"
          />
        </el-form-item>

        <!-- 访客升级不选身份：匿名账号建号时已按 patient 建档，
             角色不由这里决定。要改身份走后台提升 -->
        <el-form-item v-if="mode === 'signup' && !user.isGuest" label="身份">
          <el-radio-group v-model="form.role" :disabled="submitting">
            <el-radio value="patient">患者</el-radio>
            <el-radio value="family">家属</el-radio>
          </el-radio-group>
          <p class="login__field-hint">
            若需治疗师或管理员身份，注册后由后台手动提升。
          </p>
        </el-form-item>

        <el-alert
          v-if="user.error"
          :title="user.error"
          type="error"
          :closable="false"
          show-icon
          class="login__alert"
        />

        <el-button
          type="primary"
          native-type="submit"
          class="login__submit"
          :loading="submitting"
        >
          {{ submitLabel }}
        </el-button>
      </el-form>

      <p class="login__foot">
        <RouterLink to="/about">先看看项目介绍 →</RouterLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
  background: linear-gradient(135deg, #f0f5ff 0%, #f5f7fa 100%);
}

.login__panel {
  width: 100%;
  max-width: 400px;
  padding: 32px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 6%);
}

.login__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 24px;
}

.login__brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #409eff, #2b7de9);
  color: #fff;
  font-weight: 600;
}

.login__brand-text {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.login__tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  padding: 3px;
  border-radius: 8px;
  background: #f5f7fa;
}

.login__tab {
  flex: 1;
  padding: 7px 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 14px;
  color: #606266;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.login__tab:hover {
  color: #409eff;
}

.login__tab.is-active {
  background: #fff;
  color: #409eff;
  font-weight: 500;
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}

.login__alert {
  margin-bottom: 16px;
}

.login__guest {
  margin-bottom: 16px;
}

.login__guest :deep(.el-alert__content) {
  width: 100%;
}

.login__guest-text {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.75;
  color: #606266;
}

.login__guest-text strong {
  color: #303133;
}

.login__field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #909399;
}

.login__submit {
  width: 100%;
  margin-top: 4px;
}

.login__foot {
  margin: 20px 0 0;
  font-size: 13px;
  text-align: center;
}

.login__foot a {
  color: #409eff;
  text-decoration: none;
}

.login__foot a:hover {
  text-decoration: underline;
}
</style>
