<script setup lang="ts">
// ============================================================================
// 根组件
// ============================================================================
// 只负责渲染当前路由。布局由路由表决定：受保护的页面套 DefaultLayout，
// 登录页不套（见 src/router/index.ts）。
//
// 外面套一层 el-config-provider 是为了设中文语言包。原先是在 main.ts 里
// app.use(ElementPlus, { locale: zhCn })，改成按需引入后插件不再全局安装，
// 语言包改由这个组件提供 —— 否则分页器、日期选择器、确认框的内置文案
// 会退回英文。
// ============================================================================
import { RouterView } from 'vue-router'

import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <el-config-provider :locale="zhCn">
    <RouterView />
  </el-config-provider>
</template>
