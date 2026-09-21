<script setup lang="ts">
// ============================================================================
// 默认布局 —— 顶部导航栏 + 主内容区
// ============================================================================
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'
import { useUserStore } from '@/stores/user'
import type { UserRole } from '@/types'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const alerts = useAlertStore()
const care = useCareStore()

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

// 在布局层拉一次监护关系 —— 角标和"正在查看谁"的提示条都要用，
// 放到各页面里拉会导致切页面时角标闪烁
onMounted(() => {
  if (!user.isLoggedIn) return
  if (!care.loaded) void care.fetchAll()
  void alerts.fetchUnacknowledgedCount(care.activePatientId)
})

// 预警角标也要在布局层维护。
//
// 之前只有首页会调 fetchUnacknowledgedCount()，所以在其他页面上角标是
// 过期的 —— 用户明明处理完预警了，切到别的页面红色角标还挂着。
// 另外家属切换查看对象后也要重算，否则角标显示的是上一个对象的数量。
watch(
  () => care.viewingPatientId,
  (pid) => {
    void alerts.fetchUnacknowledgedCount(pid ?? user.userId ?? undefined)
  },
)

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

const roleLabel = computed(() =>
  user.role ? ROLE_LABEL[user.role] : '未建档',
)

// 未登录时（比如在公开的「关于」页）不显示主导航
const showNav = computed(() => user.isLoggedIn)

// 用精确总数而非按列表统计 —— 列表有 limit，行数一多就会少算。
// 该值由首页挂载时调用 fetchUnacknowledgedCount() 填充。
const alertBadge = computed(() => alerts.unacknowledgedTotal)

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
    <header class="layout__header">
      <RouterLink to="/dashboard" class="layout__brand">
        <span class="layout__brand-mark">复</span>
        <span class="layout__brand-text">复感智联 · 智能评估系统</span>
      </RouterLink>

      <nav v-if="showNav" class="layout__nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="layout__nav-link"
          :class="{ 'is-active': isActive(item.path) }"
        >
          {{ item.label }}
          <span
            v-if="item.path === '/alerts' && alertBadge > 0"
            class="layout__badge"
          >
            {{ alertBadge > 99 ? '99+' : alertBadge }}
          </span>
          <span
            v-if="item.path === '/care' && careBadge > 0"
            class="layout__badge"
          >
            {{ careBadge }}
          </span>
        </RouterLink>
      </nav>

      <div class="layout__actions">
        <!-- 访客不显示用户下拉：他们没有"退出登录"的概念，
             需要的是把当前账号保存下来 -->
        <template v-if="user.isLoggedIn && !user.isGuest">
          <el-dropdown @command="handleCommand">
            <span class="layout__user">
              <span class="layout__user-name">{{ user.displayName }}</span>
              <el-tag size="small" type="info">{{ roleLabel }}</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="signout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <RouterLink v-else to="/login" class="layout__cta">
          {{ user.isGuest ? '登录 / 注册' : '登录' }}
        </RouterLink>
      </div>
    </header>

    <main class="layout__main">
      <!-- 家属正在查看他人数据时的常驻提示。
           没有这条的话，用户很容易把监护对象的指标当成自己的看，
           尤其在两张表长得一模一样的情况下。 -->
      <!-- 访客提示。数据已经在云端（匿名账号），说清这一点比说"注册"更有说服力 -->
      <el-alert
        v-if="user.isGuest && !guestTipDismissed"
        type="info"
        show-icon
        class="guest-tip"
        @close="dismissGuestTip"
      >
        <template #title>访客模式</template>
        <p class="guest-tip__text">
          你可以直接使用全部功能，数据已存在云端。但当前是临时账号，
          换设备或清理浏览器后就找不回来了 ——
          <RouterLink to="/login" class="guest-tip__link">
            设置邮箱密码保存账号
          </RouterLink>
          ，此前的数据会全部保留。
        </p>
      </el-alert>

      <div v-if="care.isViewingOther" class="viewing">
        <span class="viewing__text">
          正在查看 <strong>{{ care.activePatientName }}</strong> 的数据
        </span>
        <el-button size="small" @click="care.setViewing(null)">
          返回我自己
        </el-button>
      </div>

      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f5f7fa;
}

.layout__header {
  display: flex;
  align-items: center;
  gap: 32px;
  height: 60px;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  /* 导航栏常驻顶部，内容滚动时不跟着走 */
  position: sticky;
  top: 0;
  z-index: 100;
}

.layout__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: inherit;
  flex-shrink: 0;
}

.layout__brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #409eff, #2b7de9);
  color: #fff;
  font-weight: 600;
}

.layout__brand-text {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  white-space: nowrap;
}

.layout__nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
}

.layout__nav-link {
  position: relative;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 14px;
  color: #606266;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.15s, color 0.15s;
}

.layout__nav-link:hover {
  background: #f2f6fc;
  color: #409eff;
}

.layout__nav-link.is-active {
  background: #ecf5ff;
  color: #409eff;
  font-weight: 500;
}

.layout__badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  background: #f56c6c;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

.layout__actions {
  flex-shrink: 0;
}

/* 访客的登录/注册入口做成按钮样式，比普通导航链接更显眼 —— 它是访客
   在这个页面上最该被引导去做的动作 */
.layout__cta {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 6px;
  background: #409eff;
  color: #fff;
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.15s;
}

.layout__cta:hover {
  background: #2b7de9;
}

/* ---------- 访客提示条 ---------- */
.guest-tip {
  margin-bottom: 16px;
}

.guest-tip :deep(.el-alert__content) {
  width: 100%;
}

.guest-tip__text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
}

.guest-tip__link {
  color: #409eff;
  font-weight: 500;
  text-decoration: none;
}

.guest-tip__link:hover {
  text-decoration: underline;
}

.layout__user {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
}

.layout__user-name {
  font-size: 14px;
  color: #606266;
}

.layout__main {
  flex: 1;
  padding: 24px;
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

/* ---------- 正在查看他人的提示条 ---------- */
.viewing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid #f5dab1;
  background: #fdf8f0;
}

.viewing__text {
  font-size: 13px;
  color: #a06800;
}

.viewing__text strong {
  color: #7a4f00;
}

/* ==========================================================================
   窄屏适配
   ==========================================================================
   顶部栏原本是「品牌 + 导航 + 用户区」挤在一行，375px 的手机上会互相
   挤压。改成两行：第一行只留 logo 方块和用户区，导航换到第二行横向滚动。
   品牌全称在小屏上省掉 —— 保住识别度的是那个色块，不是那串字。
   ========================================================================== */
@media (max-width: 768px) {
  .layout__header {
    height: auto;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 10px 14px;
  }

  /* 只留 logo 色块，隐去全称 */
  .layout__brand-text {
    display: none;
  }

  .layout__nav {
    /* 换行到第二行，占满整行 */
    order: 3;
    flex: none;
    width: 100%;
    gap: 2px;
  }

  .layout__nav-link {
    /* 触摸目标从 32px 提到 36px，手指点得准一些 */
    padding: 8px 12px;
  }

  .layout__actions {
    margin-left: auto;
  }

  .layout__main {
    padding: 14px;
  }

  .layout__user-name {
    /* 用户区收窄，避免把 logo 挤走 */
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
