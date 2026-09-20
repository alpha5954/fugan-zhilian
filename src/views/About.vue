<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="关于本项目"
    description="项目背景与技术介绍。此页面无需登录即可访问，方便评审直接查看。"
    :todos="[
      '项目背景：面向人因工程与康复检测的柔性多模态传感与评估系统',
      '技术路线：仿鱼鳞凹纹理结构（θ=120°、R=3mm）+ MWCNTs/GR/VO₂/SR 多元纳米复合材料',
      '核心指标：应变 GF 20.09、检测范围 0-100%、温度 TCR -1.04%°C⁻¹、R²=0.9962、6500 次循环',
      '算法：双向 LSTM 康复动作识别，四类膝关节动作准确率 0.94',
      '参赛信息与团队介绍',
      '演示视频或操作 DEMO 入口',
    ]"
  />
</template>
