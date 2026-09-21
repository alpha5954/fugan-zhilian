<script setup lang="ts">
// ============================================================================
// 认证页外壳
// ============================================================================
// 登录页和设置新密码页共用的外框：居中面板 + 品牌头。
//
// 抽出来不只是为了少写几行 —— 这两个页面此前最容易走散：登录页是设计系统
// 改造（a3ead62）之前写的，品牌标记还停在脚手架时期的「复」字方块，而顶栏
// 早就换成真 logo 了。同一个产品摆出两个 logo，比配色不好看严重得多。
//
// 页脚不放进来：登录页要的是「先看看项目介绍」，设置新密码页要的是
// 「返回登录」，两者语义不同，各自在 slot 里写。
// ============================================================================
</script>

<template>
  <div class="auth">
    <div class="auth__panel">
      <div class="auth__brand">
        <img src="/logo.png" alt="" class="auth__mark" />
        <span class="auth__text">
          <span class="auth__name">复感智联</span>
          <span class="auth__sub">智能评估系统</span>
        </span>
      </div>

      <slot />
    </div>
  </div>
</template>

<style scoped>
.auth {
  display: flex;
  min-height: 100vh;
  padding: var(--sp-6) var(--sp-4);
  box-sizing: border-box;
  background: var(--canvas);
}

/* 面板只用描边，不加阴影 —— tokens.css 里那条「阴影只给浮层用」同样适用于这里。
   登录面板虽然孤立在页面上、看起来像浮层，但它不移动、不消失，
   性质上是静态面板。为了"好看"破例一次，规则就守不住了。 */
.auth__panel {
  /* ⚠️ 用 margin: auto 居中，不要换成 justify-content / align-items: center。
   *
   * 两者在"内容比视口高"时行为完全不同：flex 规范规定自由空间为负时
   * auto 外边距归零，面板因此从顶部开始排、往下溢出，滚动条能把它带回来。
   * 而 center 对齐会让面板**上下都超出**，上沿被裁掉且滚不上去 ——
   * 注册表单（六个字段）在小屏笔记本上正好够得着这个高度。
   */
  margin: auto;
  width: 100%;
  max-width: 384px;
  padding: var(--sp-8) var(--sp-6) var(--sp-6);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-sizing: border-box;
}

/* ---------- 品牌 ---------- */
.auth__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-6);
}

.auth__mark {
  width: 34px;
  height: 34px;
  object-fit: contain;
  flex-shrink: 0;
}

.auth__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.auth__name {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--ink-800);
  letter-spacing: 0.5px;
}

.auth__sub {
  font-size: var(--fs-xs);
  color: var(--ink-400);
  letter-spacing: 0.3px;
}

@media (max-width: 480px) {
  .auth {
    padding: var(--sp-4) var(--sp-3);
  }

  .auth__panel {
    padding: var(--sp-6) var(--sp-5) var(--sp-5);
  }
}
</style>
