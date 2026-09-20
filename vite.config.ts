import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 把站点挂在仓库名的子路径下
  // （https://alpha5954.github.io/fugan-zhilian/），
  // 静态资源必须带这个前缀，否则线上会全部 404。
  // 本地 dev 不受影响；构建产物换仓库名时需要同步修改。
  base: '/fugan-zhilian/',

  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
