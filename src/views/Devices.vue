<script setup lang="ts">
import PagePlaceholder from '@/components/PagePlaceholder.vue'
</script>

<template>
  <PagePlaceholder
    title="我的设备"
    description="管理柔性传感器设备的绑定与状态。"
    :todos="[
      '设备列表：序列号、型号、在线状态、电量、最后在线时间',
      '绑定新设备（按序列号）',
      '解绑设备（注意：解绑后历史训练记录仍保留，device_id 置空）',
      '设备固件版本显示',
      '注意：未绑定设备目前对普通用户不可见，绑定流程需要单独的 RPC，见 RLS 迁移中的说明',
    ]"
  />
</template>
