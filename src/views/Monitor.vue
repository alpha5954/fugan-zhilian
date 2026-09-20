<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="实时监测"
    description="传感器双通道信号的实时展示。这是整套系统最核心的页面。"
    :todos="[
      '设备选择与连接状态指示',
      '应变通道实时波形（电阻变化 ΔR/R₀）',
      '温度通道实时读数与曲线，超过 45°C 阈值时高亮预警',
      '关节活动度实时角度显示',
      '开始 / 暂停 / 结束本次训练，结束后写入 rehab_sessions',
      '波形降采样到 1000 点以内再入库（见 rehab_sessions.waveform 的说明）',
    ]"
  />
</template>
