/// <reference types="vite/client" />

// ============================================================================
// 环境变量类型声明
// ============================================================================
// Vite 只会把 VITE_ 前缀的变量注入前端代码（其余变量即使写在 .env.local
// 里也不会进包）。这里声明后，import.meta.env.VITE_SUPABASE_URL 就有类型了，
// 变量名写错会在编译期报错而不是运行期算出 undefined。
//
// 声明为 string（而非 string | undefined）是刻意的：缺变量时应当尽早炸掉，
// 而不是让 undefined 一路传到运行时才以某个莫名其妙的形式出错。
// 缺失检查在 src/lib/supabase.ts 里做。
// ============================================================================

interface ImportMetaEnv {
  /** Supabase 项目地址，形如 https://xxxxxxxx.supabase.co */
  readonly VITE_SUPABASE_URL: string
  /** Supabase publishable key（或旧版 anon key）—— 公开密钥，会打包进前端 */
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
