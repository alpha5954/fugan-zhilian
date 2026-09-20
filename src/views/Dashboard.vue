<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="概览"
    description="登录后的首页，一屏看清当前康复状态和最需要关注的事。"
    :todos="[
      '今日训练次数、时长与最近一次训练时间',
      '未处理的预警（温度超标、动作异常等），critical 优先级最高',
      '在线设备数量与电量',
      '最近若干次训练记录列表，可跳转到评估详情',
      '家属视角：所监护患者的概览卡片，可切换查看对象',
    ]"
  />
</template>
