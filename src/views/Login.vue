<script setup lang="ts">
// ============================================================================
// 登录页
// ============================================================================
// 当前是空壳。登录表单属于后续阶段的内容，这里只保证路由能跳进来。
//
// 现在能验证的守卫行为：
//   未登录访问 /dashboard 等受保护页面 → 被重定向到本页，地址栏带上
//   ?redirect=<原路径>，登录成功后应当跳回那里。
// ============================================================================
</script>

<template>
  <div class="login">
    <div class="login__panel">
      <div class="login__brand">
        <span class="login__brand-mark">复</span>
        <span class="login__brand-text">复感智联 · 智能评估系统</span>
      </div>

      <el-empty description="登录表单待实现" :image-size="80" />

      <p class="login__hint">
        受保护页面在未登录时会自动跳转到此页并带上
        <code>?redirect=</code> 参数，登录成功后应当跳回原目标页。
      </p>

      <RouterLink to="/about" class="login__link">先看看项目介绍 →</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
  background: linear-gradient(135deg, #f0f5ff 0%, #f5f7fa 100%);
}

.login__panel {
  width: 100%;
  max-width: 380px;
  padding: 32px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 6%);
}

.login__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 8px;
}

.login__brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #409eff, #2b7de9);
  color: #fff;
  font-weight: 600;
}

.login__brand-text {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.login__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: #909399;
  text-align: center;
}

.login__hint code {
  padding: 1px 4px;
  border-radius: 3px;
  background: #f5f7fa;
  color: #606266;
}

.login__link {
  display: block;
  margin-top: 16px;
  font-size: 13px;
  text-align: center;
  color: #409eff;
  text-decoration: none;
}

.login__link:hover {
  text-decoration: underline;
}
</style>
