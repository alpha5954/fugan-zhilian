<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="数据分析"
    description="跨时间维度的趋势分析，用图表呈现康复进展。"
    :todos="[
      '关节活动度随时间的变化趋势（折线图）',
      '训练频次与依从性统计（柱状图 / 日历热力图）',
      '应变灵敏度与温度读数的历史分布',
      '预警事件的时间分布，辨认是否存在反复出现的风险时段',
      '按周 / 月生成汇总报告，支持导出',
      '图表统一用 ECharts，注意响应式容器尺寸',
    ]"
  />
</template>
