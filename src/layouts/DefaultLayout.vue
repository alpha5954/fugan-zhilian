<script setup lang="ts">
// ============================================================================
// 默认布局 —— 顶部导航栏 + 主内容区
// ============================================================================
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

import { useAlertStore } from '@/stores/alert'
import { useUserStore } from '@/stores/user'
import type { UserRole } from '@/types'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const alerts = useAlertStore()

/** 导航项。顺序即展示顺序 */
const navItems = [
  { path: '/dashboard', label: '概览' },
  { path: '/monitor', label: '实时监测' },
  { path: '/assessment', label: '康复评估' },
  { path: '/analysis', label: '数据分析' },
  { path: '/devices', label: '我的设备' },
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

// 只有拉取过数据才显示角标 —— 否则一进页面就先闪一个 0，很怪
const alertBadge = computed(() =>
  alerts.loaded ? alerts.unacknowledgedCount : 0,
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
            v-if="item.path === '/dashboard' && alertBadge > 0"
            class="layout__badge"
          >
            {{ alertBadge > 99 ? '99+' : alertBadge }}
          </span>
        </RouterLink>
      </nav>

      <div class="layout__actions">
        <el-dropdown v-if="user.isLoggedIn" @command="handleCommand">
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

        <RouterLink v-else to="/login" class="layout__nav-link">登录</RouterLink>
      </div>
    </header>

    <main class="layout__main">
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
</style>
