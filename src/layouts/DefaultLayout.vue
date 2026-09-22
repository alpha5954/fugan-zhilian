<script setup lang="ts">
// ============================================================================
// 默认布局 —— 顶部导航栏 + 主内容区
// ============================================================================
// 视觉上做了两处刻意选择，都是为了让界面不像"默认模板"：
//
//   1. 导航用**下划线指示当前项**，而不是填充色药丸。药丸高亮是后台模板的
//      典型做法；下划线更像编辑类/工具类产品的语言，也更安静。
//   2. 字号整体比 Element Plus 默认小一档、行距更紧。这是临床界面该有的
//      密度 —— 医生和治疗师是每天使用的熟练用户，留白过多意味着更多滚动。
// ============================================================================
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

import ErrorBoundary from '@/components/ErrorBoundary.vue'
import MobileTabBar from '@/components/MobileTabBar.vue'
import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'
import { useUserStore } from '@/stores/user'
import type { UserRole } from '@/types'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const alerts = useAlertStore()
const care = useCareStore()

/** 导航项。顺序即展示顺序 */
const navItems = [
  { path: '/dashboard', label: '概览' },
  { path: '/monitor', label: '实时监测' },
  { path: '/alerts', label: '预警记录' },
  { path: '/assessment', label: '康复评估' },
  { path: '/analysis', label: '数据分析' },
  { path: '/devices', label: '我的设备' },
  { path: '/care', label: '监护管理' },
  { path: '/about', label: '关于' },
] as const

const ROLE_LABEL: Record<UserRole, string> = {
  patient: '患者',
  family: '家属',
  therapist: '治疗师',
  admin: '管理员',
}

const roleLabel = computed(() => (user.role ? ROLE_LABEL[user.role] : '未建档'))

// 未登录时（比如在公开的「关于」页）不显示主导航
const showNav = computed(() => user.isLoggedIn)

const alertBadge = computed(() => alerts.unacknowledgedTotal)
const careBadge = computed(() => care.pendingCount)

/**
 * 访客提示条是否已被关闭。
 *
 * 记在 localStorage 里：布局在路由切换之间不会重新挂载，但整页刷新会，
 * 只用内存状态的话用户每次刷新都会再看到一遍，很烦。
 */
const GUEST_TIP_KEY = 'fugan:guest-tip-dismissed'
const guestTipDismissed = ref(localStorage.getItem(GUEST_TIP_KEY) === '1')

function dismissGuestTip() {
  guestTipDismissed.value = true
  localStorage.setItem(GUEST_TIP_KEY, '1')
}

onMounted(() => {
  if (!user.isLoggedIn) return
  if (!care.loaded) void care.fetchAll()
  void alerts.fetchUnacknowledgedCount(care.activePatientId)
})

// 预警角标也要在布局层维护。
//
// 之前只有首页会调 fetchUnacknowledgedCount()，所以在其他页面上角标是
// 过期的 —— 用户明明处理完预警了，切到别的页面红色角标还挂着。
watch(
  () => care.viewingPatientId,
  (pid) => {
    void alerts.fetchUnacknowledgedCount(pid ?? user.userId ?? undefined)
  },
)

/** 当前标签高亮。用前缀匹配，这样 /analysis/123 这种子路由也能正确点亮 */
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`)
}

async function handleCommand(command: string) {
  if (command === 'signout') {
    await user.signOut()
    router.push({ name: 'login' })
  }
}
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <RouterLink to="/dashboard" class="brand">
        <img src="/logo.png" alt="" class="brand__mark" />
        <span class="brand__name">复感智联</span>
        <span class="brand__divider" />
        <span class="brand__sub">智能评估系统</span>
      </RouterLink>

      <nav v-if="showNav" class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav__link"
          :class="{ 'is-active': isActive(item.path) }"
        >
          {{ item.label }}
          <span
            v-if="item.path === '/alerts' && alertBadge > 0"
            class="nav__badge"
          >
            {{ alertBadge > 99 ? '99+' : alertBadge }}
          </span>
          <span v-if="item.path === '/care' && careBadge > 0" class="nav__badge">
            {{ careBadge }}
          </span>
        </RouterLink>
      </nav>

      <div class="topbar__right">
        <!-- 访客不显示用户下拉：他们没有"退出登录"的概念，
             需要的是把当前账号保存下来 -->
        <template v-if="user.isLoggedIn && !user.isGuest">
          <el-dropdown @command="handleCommand">
            <span class="account">
              <span class="account__name">{{ user.displayName }}</span>
              <span class="account__role">{{ roleLabel }}</span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="signout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <RouterLink v-else to="/login" class="cta">
          {{ user.isGuest ? '登录 / 注册' : '登录' }}
        </RouterLink>
      </div>
    </header>

    <main class="main">
      <!-- 访客提示。数据已经在云端（匿名账号），说清这一点比说"注册"更有说服力 -->
      <el-alert
        v-if="user.isGuest && !guestTipDismissed"
        type="info"
        show-icon
        class="guest-tip"
        @close="dismissGuestTip"
      >
        <template #title>当前为访客模式</template>
        <p class="guest-tip__text">
          系统已为本次访问创建临时账号，数据存储于云端。该账号仅与当前浏览器关联，
          清除浏览器数据或更换设备后无法恢复 ——
          <RouterLink to="/login" class="guest-tip__link">
            设置邮箱与密码
          </RouterLink>
          可升级为正式账号，现有数据完整保留。
        </p>
      </el-alert>

      <!-- 家属正在查看他人数据时的常驻提示。
           没有这条的话，用户很容易把监护对象的指标当成自己的看，
           尤其在两张表长得一模一样的情况下。 -->
      <div v-if="care.isViewingOther" class="viewing">
        <span class="viewing__text">
          正在查看 <strong>{{ care.activePatientName }}</strong> 的数据
        </span>
        <el-button size="small" @click="care.setViewing(null)">
          返回我自己
        </el-button>
      </div>

      <!-- 套错误边界：某个页面渲染期抛异常时，Vue 会卸载整棵子树，
           用户会看到一片白且点不动。边界把它换成一个能看懂的提示
           和"重新加载"入口 -->
      <!-- 路由切换淡入。
           用 mode="out-in"，时长压在 240ms（出 80 / 入 160）—— 不加 out-in
           的话新旧两页会同时在文档流里，切换瞬间高度会跳一下。

           ⚠️ 样式在本文件的 `<style>` 里（搜「路由切换淡入」）。
              2026-09-22 之前这段注释描述的效果**并不存在** —— Transition
              在，但一行 CSS 都没写。改这段的时候去看一眼那边还在不在。 -->
      <ErrorBoundary>
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </ErrorBoundary>
    </main>

    <!-- 窄屏的底部导航。宽屏下它自己不显示（见组件的样式），
         顶部那行导航照常用 -->
    <MobileTabBar />
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--canvas);
}

/* ==========================================================================
   路由切换淡入
   ==========================================================================
   ⚠️ 这一段原先**不存在**。`<Transition name="page">` 一直在模板里，但全项目
   没有任何 `.page-*` 样式 —— 没有 CSS 时 Vue 判定"无过渡"，`mode="out-in"`
   只让两页依次挂载，视觉上是瞬时切换。而上面那条注释却写着"出 80ms / 入
   160ms…总耗时 240ms"：**注释描述了没写的代码**（README 又抄了一遍，
   两份文档互相背书一个不存在的功能）。

   现在按那段注释本来的意图补上：

     * 出 80ms / 入 160ms。"出"必须短 —— 用户已经点了新页面，让他等旧页面
       慢慢消失是没道理的；"入"稍长一点显得从容。总 240ms。
     * `mode="out-in"` 已在模板里，两页不会同时在文档流里，高度不跳。
     * **只动 opacity，不动 transform** —— 位移会让整页内容看起来在"飞"，
       在数据密集的界面上很晃眼。
   ========================================================================== */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.16s ease;
}

.page-leave-active {
  transition-duration: 0.08s;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
}

/* 动效敏感的人不需要这段淡入。系统里关掉动效之后这里不能还在淡 ——
   useCountUp 里有一模一样的判断，理由见那个文件的注释 */
@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition: none;
  }
}

/* ==========================================================================
   顶栏
   ========================================================================== */
.topbar {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  height: var(--header-h);
  padding: 0 var(--sp-5);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 100;
}

/* ---------- 品牌 ---------- */
.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  text-decoration: none;
}

.brand:hover {
  text-decoration: none;
}

.brand__mark {
  width: 26px;
  height: 26px;
  object-fit: contain;
  /* logo 是白底方图，用圆角让它更像一个"标识"而不是贴上去的图片 */
  border-radius: var(--r-sm);
}

.brand__name {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
  letter-spacing: 0.5px;
}

.brand__divider {
  width: 1px;
  height: 12px;
  background: var(--line-strong);
}

.brand__sub {
  font-size: var(--fs-xs);
  color: var(--ink-400);
  letter-spacing: 0.3px;
}

/* ---------- 导航 ----------
   下划线指示，不用填充药丸。
   药丸高亮是后台模板的典型做法；下划线更安静，也更像工具类产品。 */
.nav {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex: 1;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}

.nav::-webkit-scrollbar {
  display: none;
}

.nav__link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--ink-500);
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.15s;
}

.nav__link:hover {
  color: var(--ink-800);
  text-decoration: none;
}

.nav__link.is-active {
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}

/* 指示条贴在顶栏下沿。用 ::after 而不是 border-bottom，
   是因为要控制它的宽度和出现方式 */
.nav__link::after {
  content: '';
  position: absolute;
  left: var(--sp-3);
  right: var(--sp-3);
  bottom: -1px;
  height: 2px;
  background: transparent;
  transition: background-color 0.15s;
}

.nav__link.is-active::after {
  background: var(--brand-700);
}

.nav__badge {
  display: inline-block;
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-micro);
  line-height: 16px;
  font-weight: var(--fw-medium);
  text-align: center;
}

/* ---------- 右侧区 ---------- */
.topbar__right {
  flex-shrink: 0;
  margin-left: auto;
}

.account {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  cursor: pointer;
  outline: none;
}

.account__name {
  font-size: var(--fs-sm);
  color: var(--ink-700);
  font-weight: var(--fw-medium);
}

.account__role {
  font-size: var(--fs-micro);
  color: var(--ink-400);
}

/* 访客的登录/注册入口做成按钮样式，比普通导航链接更显眼 ——
   它是访客在这个页面上最该被引导去做的动作 */
.cta {
  display: inline-block;
  padding: 5px 14px;
  border-radius: var(--r-sm);
  background: var(--brand-700);
  color: #fff;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.15s;
}

.cta:hover {
  background: var(--brand-800);
  text-decoration: none;
}

/* ==========================================================================
   主内容区
   ========================================================================== */
.main {
  flex: 1;
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--sp-5);
}

/* ---------- 访客提示条 ---------- */
.guest-tip {
  margin-bottom: var(--sp-4);
  border-radius: var(--r-md);
}

.guest-tip :deep(.el-alert__content) {
  width: 100%;
}

.guest-tip__text {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
}

.guest-tip__link {
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}

/* ---------- 正在查看他人的提示条 ---------- */
.viewing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border: 1px solid var(--warn-line);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-md);
  background: var(--warn-bg);
}

.viewing__text {
  font-size: var(--fs-xs);
  color: var(--warn);
}

.viewing__text strong {
  font-weight: var(--fw-semibold);
}

/* ==========================================================================
   窄屏适配
   ==========================================================================
   顶部栏原本是「品牌 + 导航 + 用户区」挤在一行，375px 的手机上会互相
   挤压。改成两行：第一行只留 logo 和用户区，导航换到第二行横向滚动。
   品牌全称在小屏上省掉 —— 保住识别度的是那个图形，不是那串字。
   ========================================================================== */
@media (max-width: 768px) {
  /* 导航整体挪到底部 tab 条了，顶栏只剩品牌与用户区 ——
     一行装得下，不用再折成两行。（80 行→一行的变化：
     顶栏从占 90px 降到 52px。） */
  .nav {
    display: none;
  }

  .brand__sub,
  .brand__divider {
    display: none;
  }

  .topbar {
    gap: var(--sp-3);
    padding: 0 var(--sp-3);
  }

  .main {
    padding: var(--sp-3);
    /* 给底部 tab 条让位。少了这一条，页面最后一行会被永久挡住，
       而且滚到底也翻不上来 —— 因为固定定位的元素不参与文档流 */
    padding-bottom: calc(
      56px + env(safe-area-inset-bottom, 0px) + var(--sp-5)
    );
  }

  .account__name {
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
