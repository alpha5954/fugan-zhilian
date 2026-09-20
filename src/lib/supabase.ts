// ============================================================================
// Supabase 客户端单例
// ============================================================================
// 全应用共用这一个实例。不要在各处重复 createClient —— 每个实例都会
// 独立维护自己的 auth 状态和定时刷新，多个实例会导致登录态不同步。
// ============================================================================

import { createClient } from '@supabase/supabase-js'

import type { Database } from '@/types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 缺配置时立刻炸掉，并且把怎么修写清楚。
// 如果放任不管，错误会以「网络请求 401」的形式在某个业务页面才暴露出来，
// 排查成本高得多。
if (!supabaseUrl || !supabaseKey) {
  const missing = [
    !supabaseUrl && 'VITE_SUPABASE_URL',
    !supabaseKey && 'VITE_SUPABASE_ANON_KEY',
  ]
    .filter(Boolean)
    .join('、')

  throw new Error(
    `缺少环境变量：${missing}\n` +
      '请在项目根目录创建 .env.local（可复制 .env.example），填入 Supabase 项目的配置。\n' +
      '取值位置：Supabase 控制台 → 选择项目 → Settings → API',
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: {
    // 登录态存 localStorage 并在过期前自动续期，刷新页面不掉登录
    persistSession: true,
    autoRefreshToken: true,
    // 从邮件链接或 OAuth 跳回时，SDK 自动从 URL 里解析会话
    detectSessionInUrl: true,
  },
})
