<script setup lang="ts">
// ============================================================================
// 错误边界
// ============================================================================
// 套在 RouterView 外面。某个页面在渲染期抛异常时，Vue 会把整个子树卸载 ——
// 用户看到的是一片白，且没有任何提示，也点不动。这个组件把那种情况接住，
// 换成一个能看懂的提示和"重新加载"入口。
//
// 只接**渲染期**的错误（渲染函数、生命周期钩子、侦听器、setup）。
// 异步操作里没 catch 的 Promise 拒绝走 lib/errorHandlers.ts 的全局处理。
// ============================================================================
import { onErrorCaptured, ref } from 'vue'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err as Error
  // 返回 false 阻止继续向上冒泡，否则会一路传到 app.config.errorHandler
  // 并被重复处理一遍
  console.error('[错误边界] 页面渲染失败：', err)
  return false
})

function reload() {
  window.location.reload()
}

function dismiss() {
  error.value = null
}

/** 复制错误信息，便于用户把问题反馈给开发 */
async function copyDetail() {
  try {
    await navigator.clipboard.writeText(
      `错误：${error.value?.message}\n堆栈：\n${error.value?.stack ?? '(无)'}\n地址：${window.location.href}`,
    )
  } catch {
    // 剪贴板不可用就静默失败，不值得为此再弹一个错误
  }
}
</script>

<template>
  <div v-if="error" class="boundary">
    <div class="boundary__box">
      <h2 class="boundary__title">页面出错了</h2>
      <p class="boundary__desc">
        这个页面在渲染时遇到问题，内容可能不完整。重新加载通常能恢复 ——
        你的数据保存在云端，不受影响。
      </p>
      <pre class="boundary__detail">{{ error.message }}</pre>
      <div class="boundary__actions">
        <el-button type="primary" @click="reload">重新加载</el-button>
        <el-button @click="dismiss">尝试继续</el-button>
        <el-button text @click="copyDetail">复制错误详情</el-button>
      </div>
    </div>
  </div>

  <slot v-else />
</template>

<style scoped>
.boundary {
  display: grid;
  place-items: center;
  min-height: 60vh;
  padding: 24px;
}

.boundary__box {
  max-width: 520px;
  padding: 28px 32px;
  background: #fff;
  border: 1px solid #fbc4c4;
  border-radius: 12px;
}

.boundary__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #f56c6c;
}

.boundary__desc {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.8;
  color: #606266;
}

.boundary__detail {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: #fafafa;
  font-size: 12px;
  line-height: 1.6;
  color: #909399;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: auto;
}

.boundary__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 18px;
}
</style>
