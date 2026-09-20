// ============================================================================
// 路由表与导航守卫
// ============================================================================

import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { useUserStore } from '@/stores/user'
import type { UserRole } from '@/types'

// ---------------------------------------------------------------------------
// 路由元信息的类型扩展
// ---------------------------------------------------------------------------
declare module 'vue-router' {
  interface RouteMeta {
    /** 无需登录即可访问。不写则默认需要登录 */
    public?: boolean
    /** 只允许未登录用户访问（如登录页）——已登录时会被送回首页 */
    guestOnly?: boolean
    /** 允许访问的角色。不写则不限角色 */
    roles?: UserRole[]
    /** 页面标题，用于 document.title */
    title?: string
  }
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------
// 除登录页和关于页外，所有页面都在 DefaultLayout 之下（顶部导航 + 主内容区）。
// 各视图用动态 import 懒加载：首屏只加载登录页和布局，其余页面按需拉取。
// ---------------------------------------------------------------------------
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true, guestOnly: true, title: '登录' },
  },

  {
    path: '/',
    component: DefaultLayout,
    children: [
      { path: '', redirect: { name: 'dashboard' } },

      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '概览' },
      },
      {
        path: 'monitor',
        name: 'monitor',
        component: () => import('@/views/Monitor.vue'),
        meta: { title: '实时监测' },
      },
      {
        path: 'assessment',
        name: 'assessment',
        component: () => import('@/views/Assessment.vue'),
        meta: { title: '康复评估' },
      },
      {
        path: 'analysis',
        name: 'analysis',
        component: () => import('@/views/Analysis.vue'),
        meta: { title: '数据分析' },
      },
      {
        path: 'devices',
        name: 'devices',
        component: () => import('@/views/Devices.vue'),
        meta: { title: '我的设备' },
      },
      {
        path: 'about',
        name: 'about',
        component: () => import('@/views/About.vue'),
        // 关于页做成公开的：项目介绍给评审看，不该拦在登录后面
        meta: { public: true, title: '关于本项目' },
      },
    ],
  },

  // 兜底：未匹配的路径送回首页
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: { name: 'dashboard' },
  },
]

// ---------------------------------------------------------------------------
// 路由器实例
// ---------------------------------------------------------------------------
const router = createRouter({
  // 用 BASE_URL 而非 '/'：vite.config.ts 里 base 配的是 /fugan-zhilian/，
  // 部署到 GitHub Pages 子路径后，写死 '/' 会导致路由和静态资源全部错位。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  // 切换页面回到顶部；浏览器前进后退时恢复原来的位置
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})

// ---------------------------------------------------------------------------
// 导航守卫
// ---------------------------------------------------------------------------
//
// ⚠️ 这里做的角色/登录检查**只是用户体验层面的**，不是安全边界。
//
//    前端代码全部跑在用户浏览器里，攻击者改几行 JS、或者干脆绕过界面
//    直接调 Supabase 的 REST 接口，就能跳过这里的任何判断。
//
//    真正的权限边界在数据库那一侧——20 条 RLS 策略 + 列级授权（见
//    supabase/migrations/20260920090100_rls_policies.sql）。
//    守卫的作用是"别让用户点到他不该看的页面然后看到一片空白或报错"，
//    而不是"阻止他访问数据"。
//
router.beforeEach(async (to) => {
  const user = useUserStore()

  // 首次进入时初始化登录态。
  //
  // 这里的 await 是必需的：不等待的话，刷新页面时 getSession() 还没返回，
  // user.isLoggedIn 仍是 false，会被误判成未登录而踢到登录页——
  // 表现为"一刷新就掉登录"。
  if (!user.initialized) {
    await user.init()
  }

  const isPublic = to.meta.public === true

  // 未登录访问受保护的页面 → 去登录页，并记下原本要去哪
  if (!isPublic && !user.isLoggedIn) {
    return {
      name: 'login',
      query: { redirect: to.fullPath },
    }
  }

  // 已登录却想访问登录页 → 送回首页
  if (to.meta.guestOnly && user.isLoggedIn) {
    return { name: 'dashboard' }
  }

  // 角色限制。
  // role 为 null 说明 profile 还没加载出来（或 trigger 建档失败）——
  // 此时放行而不是拦截，否则用户会卡在一个永远进不去的首页上。
  // 该看到的自然看得到，不该看到的会被 RLS 挡掉。
  const allowed = to.meta.roles
  if (allowed?.length && user.role && !allowed.includes(user.role)) {
    return { name: 'dashboard' }
  }

  return true
})

router.afterEach((to) => {
  const base = '复感智联 · 智能评估系统'
  document.title = to.meta.title ? `${to.meta.title} · ${base}` : base
})

export default router
