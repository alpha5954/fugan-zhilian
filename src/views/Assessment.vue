<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="康复评估"
    description="双向 LSTM 模型对康复动作的识别结果，以及面向患者可读的评估结论。"
    :todos="[
      '本次训练的动作识别结果与置信度（对应 rehab_sessions.recognized / confidence）',
      '识别动作与患者所选动作不一致时给出提示（动作可能不标准）',
      '关节活动度（ROM）评估，与康复阶段目标区间对比',
      '单次训练曲线回放：应变与温度双通道',
      '面向患者的中文结论文本，避免直接堆指标',
    ]"
  />
</template>
