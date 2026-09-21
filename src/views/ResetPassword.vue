<script setup lang="ts">
// ============================================================================
// 设置新密码
// ============================================================================
// 用户点重置密码邮件里的链接后落在这里。回跳地址由 user.sendPasswordReset()
// 指定，形如 `/<base>/reset-password#access_token=...&type=recovery`。
//
// 【为什么这里会有一个"会话"】
// 邮件链接里的令牌换来的就是一个正常的登录会话，所以进到这个页面时用户
// 已经是登录状态 —— 页面因此不能按"未登录"来写。而路由那边有一道锁
// （见 router/index.ts），在没设完密码之前不许他去别的地方。
//
// 【三种进不来的情况，要分开说】
//   1. 链接过期 —— URL 里带 error_code，没有令牌。用户什么都没做错，
//      要明确告诉他"重新申请一封"
//   2. 没有会话 —— 直接敲地址进来的，或者中转过程中会话丢了
//   3. 走完了流程 —— 正常显示表单
// 三种情况都甩一句"出错了"是最省事的写法，也是最没用的。
// ============================================================================
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { ElMessage } from 'element-plus'
import type { FormInstance, FormItemRule } from 'element-plus'

import AuthShell from '@/components/AuthShell.vue'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const user = useUserStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)
const capsLock = ref(false)

const form = reactive({ password: '', confirmPassword: '' })

/**
 * 手上有可用的会话吗。
 *
 * 排除访客：匿名账号没有邮箱，改不了密码。理论上走不到（重置流程必然
 * 带着一个正式会话），但页面被直接访问时就会碰到，与其让用户填完表单
 * 再吃一个报错，不如一开始就说清楚。
 */
const hasSession = computed(() => user.isLoggedIn && !user.isGuest)

/**
 * 进不到表单时，到底是哪一种失败。
 *
 * 三种情况的处理办法不一样，笼统说一句"出错了"等于没说：
 *
 *   expired —— URL 里带着 error_code，链接过期或已经用过。用户什么都没做错，
 *              该做的是**重新申请一封**
 *   broken  —— 是恢复链接（recoveryMode），但令牌没能换成会话。链接可能被
 *              邮件客户端截断、或者被安全网关先访问掉了一次
 *   direct  —— 压根不是从邮件来的，直接敲了地址
 *
 * linkError 读的是 store 里那个**在模块加载时同步抓下来**的值：SDK 解析完
 * URL 会把 hash 清空，等组件渲染时再去读 location 就什么都没有了。
 */
type BlockReason = 'expired' | 'broken' | 'direct'

const blockReason = computed<BlockReason | null>(() => {
  if (hasSession.value) return null
  if (user.linkError) return 'expired'
  return user.recoveryMode ? 'broken' : 'direct'
})

const BLOCK_TEXT: Record<BlockReason, { title: string; desc: string }> = {
  expired: {
    title: '链接已失效',
    desc:
      '这封邮件里的链接已经过期，或者之前已经用过一次了 —— ' +
      '重置链接只能用一次，用过之后就作废。请重新申请一封。',
  },
  broken: {
    title: '链接没能验证通过',
    desc:
      '这个链接看起来是重置密码的，但没能换成有效的登录状态。' +
      '常见原因是邮件客户端把链接截断了，或者安全软件先替你打开过一次。' +
      '请重新申请一封，并在收到后直接点击。',
  },
  direct: {
    title: '需要从邮件的链接进入',
    desc:
      '这个页面是给"忘记密码"的邮件链接用的。如果你是直接输入地址打开的，' +
      '请回到登录页点「忘记密码」，我们发一封新的给你。',
  },
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
const passwordRules: FormItemRule[] = [
  { required: true, message: '请输入新密码', trigger: 'blur' },
  { min: 8, message: '密码至少 8 位', trigger: 'blur' },
]

const confirmRules: FormItemRule[] = [
  { required: true, message: '请再次输入新密码', trigger: 'blur' },
  {
    validator: (_rule, value: string, callback) => {
      if (value !== form.password) callback(new Error('两次输入的密码不一致'))
      else callback()
    },
    trigger: 'blur',
  },
]

const passwordLongEnough = computed(() => form.password.length >= 8)

watch(
  () => [form.password, form.confirmPassword],
  () => {
    if (user.error) {
      user.error = null
      user.errorCode = null
    }
  },
)

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
  if (!formRef.value || submitting.value) return

  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    if (await user.updatePassword(form.password)) {
      // 先解锁再跳转。反过来的话守卫会立刻把这次跳转拦回本页，
      // 用户会看到自己"设置成功"了却还停在原地
      user.exitRecovery()
      ElMessage.success('密码已更新，其它设备上的登录已经失效')
      await router.replace('/dashboard')
    }
  } finally {
    submitting.value = false
  }
}

/** 放弃重设：退出这个会话，回登录页重新走一遍 */
async function handleCancel() {
  user.exitRecovery()
  await user.signOut()
  await router.replace('/login')
}
</script>

<template>
  <AuthShell>
    <!-- ---------- 进不到表单：说清是哪一种 ---------- -->
    <template v-if="blockReason">
      <h2 class="title">{{ BLOCK_TEXT[blockReason].title }}</h2>
      <p class="desc">{{ BLOCK_TEXT[blockReason].desc }}</p>
      <RouterLink to="/login" class="action">
        {{ blockReason === 'direct' ? '去登录页 →' : '重新申请一封 →' }}
      </RouterLink>
    </template>

    <!-- ---------- 正常流程 ---------- -->
    <template v-else>
      <h2 class="title">设置新密码</h2>
      <p class="desc">
        正在为
        <strong class="desc__email">{{ user.email }}</strong>
        设置新密码。设置完成后，其它设备上的登录会自动失效。
      </p>

      <el-form
        ref="formRef"
        :model="form"
        label-position="top"
        @submit.prevent="handleSubmit"
      >
        <el-form-item label="新密码" prop="password" :rules="passwordRules">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 8 位"
            show-password
            autocomplete="new-password"
            :disabled="submitting"
            @keydown="syncCapsLock"
            @keyup="syncCapsLock"
            @blur="capsLock = false"
          />
          <p class="hint" :class="{ 'hint--ok': passwordLongEnough }">
            {{ passwordLongEnough ? '长度符合要求' : '至少 8 位' }}
          </p>
          <p v-if="capsLock" class="caps">大写锁定已打开，密码可能输错</p>
        </el-form-item>

        <el-form-item
          label="确认新密码"
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

        <el-alert
          v-if="user.error"
          :title="user.error"
          type="error"
          :closable="false"
          show-icon
          role="alert"
          class="alert"
        />

        <el-button
          type="primary"
          native-type="submit"
          class="submit"
          :loading="submitting"
        >
          设置新密码
        </el-button>
      </el-form>

      <p class="foot">
        <button type="button" class="foot__link" @click="handleCancel">
          放弃重设，返回登录
        </button>
      </p>
    </template>
  </AuthShell>
</template>

<style scoped>
.title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-xl);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
}

.desc {
  margin: 0 0 var(--sp-5);
  font-size: var(--fs-sm);
  line-height: var(--lh-loose);
  color: var(--ink-500);
}

.desc__email {
  color: var(--ink-800);
  font-weight: var(--fw-medium);
  /* 邮箱可能很长，别让它把面板撑破 */
  word-break: break-all;
}

.action {
  display: inline-block;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--brand-700);
  text-decoration: none;
}

.action:hover {
  text-decoration: underline;
}

/* ---------- 表单 ---------- */
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

.alert {
  margin-bottom: var(--sp-4);
  border-radius: var(--r-sm);
}

.submit {
  width: 100%;
  margin-top: var(--sp-1);
}

.foot {
  margin: var(--sp-5) 0 0;
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line-soft);
  text-align: center;
}

.foot__link {
  padding: 0;
  border: none;
  background: none;
  font-size: var(--fs-xs);
  font-family: inherit;
  color: var(--ink-400);
  cursor: pointer;
}

.foot__link:hover {
  color: var(--ink-700);
}
</style>
