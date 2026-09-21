import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { installGlobalErrorHandlers } from './lib/errorHandlers'
import router from './router'

// 样式导入顺序要紧：先 Element Plus 再自己的全局样式，
// 否则自定义规则会被组件库的默认样式盖掉。
//
// 这里**不再引入 element-plus/dist/index.css** —— 那是全量样式（355 KB）。
// 按需引入由 vite.config.ts 里两个 unplugin 插件完成：
//   - 模板里用到的组件，样式随组件自动带入
//   - 脚本里 import 的 ElMessage / ElMessageBox / ElNotification 同理
// 中文语言包改由 App.vue 的 <el-config-provider> 提供（原先在这里 use 插件时传）
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 全局错误兜底：渲染期的错误由 ErrorBoundary 接住，组件外的同步异常与
// 未处理的 Promise 拒绝由这里接住。两者都是"出了事别让用户面对一片白"。
installGlobalErrorHandlers(app)

app.mount('#app')
