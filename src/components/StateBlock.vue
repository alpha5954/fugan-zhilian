<script setup lang="ts">
// ============================================================================
// 加载 / 错误 / 空状态
// ============================================================================
// 四个数据页面共用。把它们套在内容外面：
//
//   <StateBlock :loading="s.loading" :error="s.error" :empty="!s.items.length"
//               empty-text="..." @retry="s.fetchAll()">
//     <el-table :data="s.items" />
//   </StateBlock>
//
// 存在的意义是**错误必须有出口**。之前各页面只在用户主动操作（保存、
// 解绑）时才弹错误提示，而拉取失败时只是静默显示一个空列表 ——
// 用户看到"没有数据"，实际是网络挂了或 RLS 拒绝了，无从判断。
// ============================================================================

withDefaults(
  defineProps<{
    loading?: boolean
    /** store 里的错误文本。有值时优先展示错误，不展示空状态 */
    error?: string | null
    /** 数据为空。注意要排除 loading 中，否则会先闪一下空状态 */
    empty?: boolean
    emptyText?: string
    /** 是否显示重试按钮 */
    retryable?: boolean
  }>(),
  {
    loading: false,
    error: null,
    empty: false,
    emptyText: '暂无数据',
    retryable: true,
  },
)

defineEmits<{ retry: [] }>()
</script>

<template>
  <!-- 加载中 -->
  <div v-if="loading" class="state-block">
    <el-skeleton :rows="4" animated />
  </div>

  <!-- 出错：优先于空状态展示，否则失败会被误读成"没有数据" -->
  <el-alert
    v-else-if="error"
    type="error"
    :closable="false"
    show-icon
    class="state-block"
  >
    <template #title>加载失败</template>
    <p class="state-block__msg">{{ error }}</p>
    <el-button v-if="retryable" size="small" @click="$emit('retry')">
      重试
    </el-button>
  </el-alert>

  <!-- 空 -->
  <div v-else-if="empty" class="state-block">
    <el-empty :description="emptyText" :image-size="80">
      <slot name="empty-action" />
    </el-empty>
  </div>

  <!-- 正常内容 -->
  <slot v-else />
</template>

<style scoped>
.state-block {
  padding: 16px 18px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
}

.state-block__msg {
  margin: 4px 0 10px;
  font-size: 13px;
  line-height: 1.7;
  color: #606266;
}

/* el-alert 自带 padding，这里只补圆角与边框风格 */
.state-block.el-alert {
  padding: 14px 18px;
}
</style>
