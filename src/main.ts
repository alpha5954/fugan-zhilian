import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { installGlobalErrorHandlers } from './lib/errorHandlers'
import router from './router'

// ---------------------------------------------------------------------------
// 样式导入顺序**不能改**，后面的覆盖前面的：
//   1. tokens      —— 设计令牌，定义所有变量
//   2. element     —— 用令牌覆盖 Element Plus 的主题变量
//   3. style       —— 全局基础样式
//
// 页面级样式写在各自组件的 <style scoped> 里，一律引用 tokens 的变量，
// 不写死颜色和尺寸。
//
// 注意这里**不引入 element-plus/dist/index.css**（那是全量样式 355 KB）。
// 按需引入由 vite.config.ts 里两个 unplugin 插件完成：
//   - 模板里用到的组件，样式随组件自动带入
//   - 脚本里 import 的 ElMessage / ElMessageBox / ElNotification 同理
// 中文语言包由 App.vue 的 <el-config-provider> 提供。
// ---------------------------------------------------------------------------
import './styles/tokens.css'
import './styles/element.css'
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 全局错误兜底：渲染期的错误由 ErrorBoundary 接住，组件外的同步异常与
// 未处理的 Promise 拒绝由这里接住。两者都是"出了事别让用户面对一片白"。
installGlobalErrorHandlers(app)

app.mount('#app')
