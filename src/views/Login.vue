<script setup lang="ts">
// ============================================================================
// 登录 / 注册 / 申请重置密码
// ============================================================================
// 三个模式共用一个表单，靠 mode 切换，不拆成三个路由：
// 它们填的是同一批字段（邮箱、密码），拆开之后来回跳转会丢掉已填的内容。
//
//   signin —— 已有账号登录
//   signup —— 注册。访客模式下这个动作其实是**升级当前账号**，标签统一写
//             「注册」保证能找到，按钮上再写清"并保存数据"
//   reset  —— 只填邮箱，发一封重置密码的邮件。真正的"设置新密码"在
//             /reset-password，那是用户点邮件链接之后才到的页面
// ============================================================================
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormItemRule } from 'element-plus'

import AuthShell from '@/components/AuthShell.vue'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

type Mode = 'signin' | 'signup' | 'reset'

const mode = ref<Mode>('signin')
const formRef = ref<FormInstance>()
const emailInput = ref<{ focus: () => void }>()
const submitting = ref(false)
/** 成功类的提示（确认邮件已发出之类） */
const notice = ref('')

/**
 * 大写锁定是否打开。
 *
 * 密码输错十次里有八次是这个 —— 而输入框只显示圆点，用户完全看不出来。
 * 这是登录页性价比最高的一个小功能。
 */
const capsLock = ref(false)

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

/** 密码长度是否已达标，用于输密码时的实时反馈 */
const passwordLongEnough = computed(() => form.password.length >= 8)

// ---------------------------------------------------------------------------
// 切换模式
// ---------------------------------------------------------------------------
watch(mode, (_next, prev) => {
  // 上一次的报错必须清掉，否则切换后会留着一个对不上的错误信息
  user.error = null
  user.errorCode = null
  notice.value = ''
  capsLock.value = false
  // 从注册切走时把确认密码清空：它不会再显示，留着下次回来会莫名其妙
  if (prev === 'signup') form.confirmPassword = ''
  formRef.value?.clearValidate()
})

/**
 * 用户一动输入框就把上一次的报错撤掉。
 *
 * 「邮箱或密码不正确」在用户重打密码之后还挂在屏幕上，会让人以为刚才那次
 * 又失败了。错误信息一旦过期就该消失。
 */
watch(
  () => [form.email, form.password, form.confirmPassword],
  () => {
    if (user.error) {
      user.error = null
      user.errorCode = null
    }
  },
)

onMounted(() => {
  void nextTick(() => emailInput.value?.focus())
})

// ---------------------------------------------------------------------------
// 大写锁定
// ---------------------------------------------------------------------------
function syncCapsLock(e: Event | KeyboardEvent) {
  // el-input 把 keydown/keyup 的事件签名写成了 Event | KeyboardEvent，
  // 而 getModifierState 只有 KeyboardEvent 上才有，所以要先收窄再调
  if (!(e instanceof KeyboardEvent)) return
  capsLock.value = e.getModifierState('CapsLock')
}

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
    if (mode.value === 'reset') {
      await handleSendReset()
      return
    }

    if (mode.value === 'signin') {
      await handleSignIn()
      return
    }

    await handleSignUp()
  } finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// 申请重置密码
// ---------------------------------------------------------------------------
async function handleSendReset() {
  if (await user.sendPasswordReset(form.email)) {
    // ⚠️ 措辞必须是「如果该邮箱注册过」。
    //    Supabase 对未注册的邮箱同样返回成功，这是刻意的反枚举设计 ——
    //    写成"邮件已发往 xxx"就等于告诉试探者哪些邮箱存在。
    notice.value =
      `如果 ${form.email} 已经注册过，重置密码的邮件已经发出。` +
      '请打开邮件里的链接设置新密码。没收到的话，检查一下垃圾邮件，' +
      '或者过几分钟再试一次。'
    mode.value = 'signin'
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
async function handleSignIn() {
  // ⚠️ 访客用已有账号登录会**替换掉当前会话**：匿名账号连同它里面的
  //    数据会变成孤儿，不会跟随到新账号。这是最容易让人丢数据的操作，
  //    必须先讲清楚再让用户决定。
  if (user.isGuest) {
    try {
      await ElMessageBox.confirm(
        '登录已有账号后，本次会话将切换至该账号。访客模式下产生的数据' +
          '（已绑定设备、已保存训练记录）仍保留在原临时账号中，' +
          '不会随本次登录转移。\n\n' +
          '如需保留这些数据，请改用「注册」将当前访客账号升级为正式账号。',
        '当前为访客模式',
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
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
async function handleSignUp() {
  // 访客走「升级当前账号」，uid 不变，数据完整保留
  if (user.isGuest) {
    const r = await user.upgradeGuest(form.email, form.password, form.displayName)
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
      `确认邮件已发送到 ${form.email}，请点击邮件里的链接完成验证，然后再登录。` +
      '没收到的话，可以用下面的按钮重新发一封。'
    form.password = ''
    form.confirmPassword = ''
    mode.value = 'signin'
  } else {
    goAfterAuth()
  }
}

/** 重发注册确认邮件。注册后没收到信是最常见的卡点，得给条出路 */
async function handleResend() {
  if (submitting.value) return
  submitting.value = true
  try {
    if (await user.resendConfirmation(form.email)) {
      notice.value = `确认邮件已重新发往 ${form.email}，请查收。`
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
    typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')
      ? raw
      : '/dashboard'

  router.replace(target)
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------
const submitLabel = computed(() => {
  if (mode.value === 'reset') return '发送重置邮件'
  if (mode.value === 'signin') return '登录'
  // 访客模式下这个动作确实是把当前匿名账号升级掉，而不是新建一个。
  // 按钮上说得具体些，用户按下去之前就知道数据会跟着走
  return user.isGuest ? '注册并保存数据' : '注册'
})

/**
 * 邮箱没验证是**最常见**的登录失败原因，而且用户看到"邮箱或密码不正确"
 * 会一直怀疑自己密码打错了。这一条单独给个出路：重发确认邮件。
 */
const needsEmailConfirmation = computed(
  () => user.errorCode === 'email_not_confirmed',
)
</script>

<template>
  <AuthShell>
    <!-- 访客提示：说清"注册"对访客到底意味着什么，否则用户会以为是新建一个号、
         进而担心当前数据丢失 -->
    <el-alert
      v-if="user.isGuest && mode !== 'reset'"
      type="info"
      :closable="false"
      show-icon
      class="guest"
    >
      <template #title>当前为访客模式</template>
      <p class="guest__text">
        系统已为本次访问创建临时账号，数据存储于云端。该账号仅与当前浏览器关联，
        清除浏览器数据或更换设备后无法恢复。设置邮箱与密码可将其升级为正式账号，
        <strong>现有数据完整保留</strong>。
      </p>
    </el-alert>

    <div v-if="mode !== 'reset'" class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="tab"
        :class="{ 'is-active': mode === 'signin' }"
        :aria-selected="mode === 'signin'"
        @click="mode = 'signin'"
      >
        登录
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        :class="{ 'is-active': mode === 'signup' }"
        :aria-selected="mode === 'signup'"
        @click="mode = 'signup'"
      >
        注册
      </button>
    </div>

    <!-- 申请重置密码是二级状态，不是第三个标签页：
         它没有独立的入口，只是登录失败时的一条岔路 -->
    <div v-else class="subhead">
      <h2 class="subhead__title">重置密码</h2>
      <p class="subhead__desc">
        填上注册时用的邮箱，我们会发一封邮件过去，点里面的链接就能设置新密码。
      </p>
    </div>

    <el-alert
      v-if="notice"
      :title="notice"
      type="success"
      :closable="false"
      show-icon
      class="alert"
    />

    <el-form
      ref="formRef"
      :model="form"
      label-position="top"
      @submit.prevent="handleSubmit"
    >
      <el-form-item label="邮箱" prop="email" :rules="emailRules">
        <el-input
          ref="emailInput"
          v-model="form.email"
          type="email"
          placeholder="you@example.com"
          autocomplete="email"
          :disabled="submitting"
        />
      </el-form-item>

      <!-- 申请重置只需要邮箱，密码相关的一律不显示 -->
      <template v-if="mode !== 'reset'">
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

        <!-- 标签一律用 label="..." 交给 Element Plus 自己渲染。
             试过用 #label 插槽把「忘记密码？」塞进标签行，结果是必填星号
             （一个 ::before 伪元素）和插槽内容各占一行，标签整个错位。
             EP 的标签内边距和星号都不是为自定义内容准备的，别在这上面较劲 -->
        <el-form-item label="密码" prop="password" :rules="passwordRules">
          <el-input
            v-model="form.password"
            type="password"
            :placeholder="mode === 'signin' ? '请输入密码' : '至少 8 位'"
            show-password
            :autocomplete="
              mode === 'signin' ? 'current-password' : 'new-password'
            "
            :disabled="submitting"
            @keydown="syncCapsLock"
            @keyup="syncCapsLock"
            @blur="capsLock = false"
          />
          <!-- 注册时的实时反馈。不做"密码强度"进度条 ——
               项目只强制了长度一条，画出三格强度条是编出来的信息 -->
          <p
            v-if="mode === 'signup'"
            class="hint"
            :class="{ 'hint--ok': passwordLongEnough }"
          >
            {{ passwordLongEnough ? '长度符合要求' : '至少 8 位' }}
          </p>
          <p v-if="capsLock" class="caps">
            大写锁定已打开，密码可能输错
          </p>

          <!-- 忘记密码右对齐放在输入框下面。放进标签行会和必填星号打架，
               见上面那段注释 -->
          <div v-if="mode === 'signin'" class="fieldfoot">
            <button
              type="button"
              class="fieldfoot__link"
              @click="mode = 'reset'"
            >
              忘记密码？
            </button>
          </div>
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
            @keydown="syncCapsLock"
            @keyup="syncCapsLock"
            @blur="capsLock = false"
          />
        </el-form-item>

        <!-- 访客升级不选身份：匿名账号建号时已按 patient 建档，
             角色不由这里决定。要改身份走后台提升 -->
        <el-form-item v-if="mode === 'signup' && !user.isGuest" label="身份">
          <el-radio-group v-model="form.role" :disabled="submitting">
            <el-radio value="patient">患者</el-radio>
            <el-radio value="family">家属</el-radio>
          </el-radio-group>
          <p class="hint">
            患者看自己的数据；家属远程查看家人的数据，需要对方在监护管理里确认。
            治疗师与管理员由后台提升。
          </p>
        </el-form-item>
      </template>

      <el-alert
        v-if="user.error"
        :title="user.error"
        type="error"
        :closable="false"
        show-icon
        role="alert"
        class="alert"
      >
        <!-- 邮箱没验证时给一条明确的出路，而不是让用户对着
             "邮箱或密码不正确"反复怀疑自己 -->
        <button
          v-if="needsEmailConfirmation"
          type="button"
          class="alert__action"
          :disabled="submitting"
          @click="handleResend"
        >
          重新发送确认邮件
        </button>
      </el-alert>

      <el-button
        type="primary"
        native-type="submit"
        class="submit"
        :loading="submitting"
      >
        {{ submitLabel }}
      </el-button>

      <button
        v-if="mode === 'reset'"
        type="button"
        class="back"
        @click="mode = 'signin'"
      >
        ← 返回登录
      </button>
    </el-form>

    <p class="foot">
      <RouterLink to="/about">先看看项目介绍 →</RouterLink>
    </p>
  </AuthShell>
</template>

<style scoped>
/* ==========================================================================
   标签页
   ==========================================================================
   用下划线指示，不用填充药丸 —— 与顶栏导航同一套语言。
   药丸高亮是后台模板的典型做法；而且这个应用里导航本来就是下划线，
   只有登录页是药丸的话，等于同一个产品两套交互语言。
   ========================================================================== */
.tabs {
  display: flex;
  gap: var(--sp-5);
  margin-bottom: var(--sp-5);
  border-bottom: 1px solid var(--line);
}

.tab {
  position: relative;
  padding: 0 0 9px;
  border: none;
  background: transparent;
  font-size: var(--fs-md);
  font-family: inherit;
  color: var(--ink-400);
  cursor: pointer;
  transition: color 0.15s;
}

.tab:hover {
  color: var(--ink-700);
}

.tab.is-active {
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}

.tab.is-active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--brand-700);
}

/* ---------- 重置密码的二级标题 ---------- */
.subhead {
  margin-bottom: var(--sp-5);
}

.subhead__title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.subhead__desc {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-500);
}

/* ---------- 提示条 ---------- */
.guest {
  margin-bottom: var(--sp-5);
  border-radius: var(--r-sm);
}

.guest :deep(.el-alert__content) {
  width: 100%;
}

.guest__text {
  margin: 5px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-loose);
  color: var(--ink-600);
}

.guest__text strong {
  color: var(--ink-800);
  font-weight: var(--fw-semibold);
}

.alert {
  margin-bottom: var(--sp-4);
  border-radius: var(--r-sm);
}

.alert__action {
  margin-top: 7px;
  padding: 0;
  border: none;
  background: none;
  font-size: var(--fs-xs);
  font-family: inherit;
  color: var(--brand-700);
  font-weight: var(--fw-medium);
  text-decoration: underline;
  cursor: pointer;
}

.alert__action:disabled {
  color: var(--ink-300);
  cursor: not-allowed;
}

/* ==========================================================================
   表单
   ========================================================================== */
/* 输入框下面那行右对齐的小链接。
   el-form-item__content 是 flex-wrap 容器，width:100% 会让它换到下一行 */
.fieldfoot {
  width: 100%;
  margin-top: 5px;
  text-align: right;
}

.fieldfoot__link {
  padding: 0;
  border: none;
  background: none;
  font-size: var(--fs-xs);
  font-family: inherit;
  color: var(--brand-700);
  cursor: pointer;
}

.fieldfoot__link:hover {
  text-decoration: underline;
}

.hint {
  margin: 5px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
  transition: color 0.15s;
}

.hint--ok {
  color: var(--ok);
}

.caps {
  margin: 5px 0 0;
  font-size: var(--fs-xs);
  color: var(--warn);
}

.submit {
  width: 100%;
  margin-top: var(--sp-1);
}

.back {
  display: block;
  width: 100%;
  margin-top: var(--sp-4);
  padding: 0;
  border: none;
  background: none;
  font-size: var(--fs-sm);
  font-family: inherit;
  color: var(--ink-400);
  cursor: pointer;
}

.back:hover {
  color: var(--ink-700);
}

.foot {
  margin: var(--sp-5) 0 0;
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  text-align: center;
}

.foot a {
  color: var(--ink-400);
  text-decoration: none;
}

.foot a:hover {
  color: var(--brand-700);
}
</style>
