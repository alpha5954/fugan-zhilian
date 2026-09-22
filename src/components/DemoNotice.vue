<script setup lang="ts">
// ============================================================================
// 演示数据声明条
// ============================================================================
// 首页和数据分析页共用。**做成组件而不是各写一份** —— 那两处会漂：
// 一处改了措辞、另一处没改，于是同一个访客在两个页面上看到对"演示数据"
// 的两种不同说明方式。
//
// 本项目已经栽过一次同类问题：传感器参数同时铺在「关于」页和首页折叠区，
// 后来只改了其中一处。
//
// 【为什么必须存在】
// 项目的一条底线是"不把模拟数据说成实测数据"（见 README「数据来源」）。
// 用了演示数据就必须**明确标出来**，而且要给出路 ——
// 告诉用户怎么才能看到自己的真实数据。
//
// 做成中性的信息条而不是警告条：这不是错误，只是要如实说明数据来源。
//
// 文案由调用方用插槽给 —— 各页"怎么才能看到自己的数据"那句不一样
// （首页是绑设备、分析页是去记录一次训练、评估页是等硬件接入），
// 但壳子和标签是同一套。
// ============================================================================
withDefaults(
  defineProps<{
    /**
     * 标签文字。默认「演示数据」。
     *
     * 评估页传「模拟数据」—— 那里的情况不同：数据不是"因为没记录所以拿
     * 示例顶上"，而是**真实采集链路还没接通**（硬件未接入），生成的会话
     * 会被写进数据库。两者都不该被当成实测，但原因不同，标签也要不同。
     */
    tag?: string
  }>(),
  { tag: '演示数据' },
)
</script>

<template>
  <aside class="demo" role="note">
    <span class="demo__tag">{{ tag }}</span>
    <p class="demo__text"><slot /></p>
  </aside>
</template>

<style scoped>
.demo {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--info-line);
  border-radius: var(--r-md);
  background: var(--info-bg);
}

.demo__tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--r-xs);
  background: var(--brand-700);
  color: #fff;
  font-size: var(--fs-micro);
  font-weight: var(--fw-medium);
  line-height: 1.7;
  white-space: nowrap;
}

.demo__text {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-loose);
  color: var(--ink-600);
}
</style>
