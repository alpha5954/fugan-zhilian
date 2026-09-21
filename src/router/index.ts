// ============================================================================
// 路由表与导航守卫
// ============================================================================

import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

import DefaultLayout from '@/layouts/DefaultLayout.vue'
import { consumeAuthHashFlag } from '@/lib/authRedirect'
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
    // 用户点重置密码邮件里的链接后落在这里。回跳地址由
    // user.sendPasswordReset() 指定（见 lib/authRedirect.ts）。
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('@/views/ResetPassword.vue'),
    // public：链接失效时用户手上根本没有会话，不能因为"没登录"就把他弹走 ——
    // 那样他只会看到一个登录页，完全不知道邮件链接出了什么问题。
    //
    // ⚠️ 绝不能加 guestOnly。链接有效时用户是**登录状态**（那个会话正是点
    //    邮件换来的），而 guestOnly 的判据是"已登录且不是访客"，加了就会被
    //    当场弹回首页 —— 正好把这个页面废掉。
    meta: { public: true, title: '设置新密码' },
  },

  {
    path: '/',
    component: DefaultLayout,
    children: [
      // 落地页是实时监测而不是概览：它由模拟器驱动、不依赖任何历史数据，
      // 访客一进来就能看到四路曲线在动。概览对访客来说是四张空卡片，
      // 作为第一印象太弱。
      { path: '', redirect: { name: 'monitor' } },

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
        path: 'alerts',
        name: 'alerts',
        component: () => import('@/views/Alerts.vue'),
        meta: { title: '预警记录' },
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
        path: 'care',
        name: 'care',
        component: () => import('@/views/Care.vue'),
        meta: { title: '监护管理' },
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

  // -------------------------------------------------------------------------
  // 重置密码流程：把用户**锁在**设置新密码的页面上
  // -------------------------------------------------------------------------
  //
  // 从邮件链接进来时，用户手里是一个货真价实的登录会话（点邮件链接换来的）。
  // 没有这道锁的话他会一路正常地进首页、逛各个页面，然后大概率再也想不起来
  // 自己是来改密码的 —— 下次登录照样进不去，白折腾一趟。
  //
  // 放在最前面，公开页面（比如「关于」）也不放行：此刻该做的只有一件事。
  if (user.recoveryMode && to.name !== 'reset-password') {
    return { name: 'reset-password' }
  }

  // -------------------------------------------------------------------------
  // 把认证参数从地址栏里抹掉
  // -------------------------------------------------------------------------
  // 到这一步 SDK 已经读过 hash、换出会话了（init 里 await 了 getSession），
  // 留着它只有坏处：会随 Referer 头漏给第三方，被截图带走，用户刷新时还会
  // 拿同一个用过的令牌再解析一遍、报出一个和他无关的错误。
  //
  // ⚠️ 必须用 router 的重定向来清，不能直接 history.replaceState ——
  //    vue-router 启动时就把带 hash 的地址记进了自己的 history.state，
  //    之后保存滚动位置时会拿那份记录写回去，直接清等于白清（实测过）。
  //    走重定向的话 router 自己的记录也一起变成不带 hash 的。
  //
  // 放在恢复模式那道锁**之后**：那种情况下 router 会重新拼一个不带 hash 的
  // 地址，hash 自然就没了，不必多绕一次重定向。
  // 先取标记再看 hash，顺序不能反：恢复模式那道锁会先返回，
  // 第二次进来时 hash 已经是空的，若把它写在前面就永远取不掉标记，
  // 这个标记会一直挂着，日后某个带 # 锚点的跳转会被莫名剥掉
  if (consumeAuthHashFlag() && to.hash) {
    return { path: to.path, query: to.query, hash: '', replace: true }
  }

  const isPublic = to.meta.public === true

  // 未登录访问受保护页面 → **静默建立一个访客会话**，而不是踢去登录页。
  //
  // 为什么必须先建会话、不能直接放行：anon 角色在业务表上没有任何授权
  // （迁移 2 里刻意 revoke 掉的），直接放行的话每个数据页面都会拿到
  // 42501 permission denied，满屏报错。
  //
  // 匿名账号拿到的是正常的 authenticated 角色，既有 RLS 原样生效，
  // 所以所有页面和数据层都不用为"访客"写任何分支。
  if (!isPublic && !user.isLoggedIn) {
    const ok = await user.ensureGuestSession()
    if (!ok) {
      // 建不出来时的兜底，最常见的原因是控制台没开启 Anonymous Sign-ins。
      // 退回登录页，用户至少还能用系统
      return { name: 'login', query: { redirect: to.fullPath } }
    }
  }

  // 已登录却想访问登录页 → 送回首页。
  //
  // ⚠️ 只拦**正式账号**。现在每个访客都持有匿名会话，如果不排除访客，
  //    访客点导航栏的「登录 / 注册」会被立刻弹走，永远进不了登录页。
  if (to.meta.guestOnly && user.isLoggedIn && !user.isGuest) {
    return { name: 'monitor' }
  }

  // 角色限制。
  // role 为 null 说明 profile 还没加载出来（或 trigger 建档失败）——
  // 此时放行而不是拦截，否则用户会卡在一个永远进不去的首页上。
  // 该看到的自然看得到，不该看到的会被 RLS 挡掉。
  const allowed = to.meta.roles
  if (allowed?.length && user.role && !allowed.includes(user.role)) {
    return { name: 'monitor' }
  }

  return true
})

router.afterEach((to) => {
  const base = '复感智联 · 智能评估系统'
  document.title = to.meta.title ? `${to.meta.title} · ${base}` : base
})

export default router
