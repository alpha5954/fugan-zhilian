<script setup lang="ts">
// ============================================================================
// 页面占位组件
// ============================================================================
// 各页面还是空壳阶段时共用这个。等某个页面真正实现了，把它的
// <PagePlaceholder> 换掉即可，不影响其他页面。
// ============================================================================

defineProps<{
  /** 页面标题 */
  title: string
  /** 一句话说明这个页面是干什么的 */
  description?: string
  /** 后续要在这页实现的功能点 */
  todos?: readonly string[]
}>()
</script>

<template>
  <section class="placeholder">
    <header class="placeholder__header">
      <h1 class="placeholder__title">{{ title }}</h1>
      <p v-if="description" class="placeholder__desc">{{ description }}</p>
    </header>

    <div class="placeholder__body">
      <el-empty description="页面骨架已就位，内容待实现" :image-size="90" />

      <ul v-if="todos?.length" class="placeholder__todos">
        <li v-for="todo in todos" :key="todo">{{ todo }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.placeholder {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.placeholder__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

.placeholder__desc {
  margin: 6px 0 0;
  font-size: 13px;
  color: #909399;
}

.placeholder__body {
  padding: 24px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
}

.placeholder__todos {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 2;
  color: #606266;
  border-top: 1px dashed #e4e7ed;
  padding-top: 16px;
}
</style>
