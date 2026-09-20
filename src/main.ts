import { createPinia } from 'pinia'
import { createApp } from 'vue'

import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'

// 样式导入顺序要紧：先 Element Plus 再自己的全局样式，
// 否则自定义规则会被组件库的默认样式盖掉。
import 'element-plus/dist/index.css'
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
// 语言包设为中文，否则分页器、日期选择器等内置文案会是英文
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')
