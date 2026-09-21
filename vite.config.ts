import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import ElementPlus from 'unplugin-element-plus/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 把站点挂在仓库名的子路径下
  // （https://alpha5954.github.io/fugan-zhilian/），
  // 静态资源必须带这个前缀，否则线上会全部 404。
  base: '/fugan-zhilian/',

  plugins: [
    vue(),

    // ---------------------------------------------------------------------
    // Element Plus 按需引入
    // ---------------------------------------------------------------------
    // 全量引入时 CSS 就有 355 KB、主包 852 KB。按需引入后只打包实际用到的
    // 组件与样式，首屏体积能砍掉一半以上。
    //
    // 两个插件分工不同，缺一不可：
    //   Components —— 处理**模板里**用到的组件（<el-table> 之类）
    //   ElementPlus —— 处理**脚本里**显式 import 的（ElMessage 这类
    //                  服务式 API，它不是组件，模板解析器管不到）
    Components({
      // 生成类型声明，让 vue-tsc 认识这些"凭空出现"的组件。
      // 这个文件要提交进仓库 —— npm run build 先跑 vue-tsc 再跑 vite，
      // 不提交的话 CI 上类型检查会因为找不到组件定义而失败
      dts: 'src/components.d.ts',
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
    ElementPlus({}),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
