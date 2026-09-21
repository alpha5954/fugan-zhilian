// ============================================================================
// 预警的展示文案
// ============================================================================
// 枚举本身定义在 types 里（与数据库 check 约束一一对应），这里只管怎么显示。
// 集中放一处：列表页、首页卡片、浏览器通知都要用，散着写迟早对不上。
// ============================================================================

import type { AlertKind, AlertSeverity } from '@/types'

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  temp_high: '温度超标',
  temp_low: '温度过低',
  motion_abnormal: '动作异常',
  device_offline: '设备离线',
  low_compliance: '依从性不足',
}

/** 每种预警对应的处置建议，列表里展开显示 */
export const ALERT_KIND_ADVICE: Record<AlertKind, string> = {
  temp_high:
    '皮肤接触 44 °C 持续 6 小时、或接触 50 °C 仅需 5 分钟即可造成不可逆低温烫伤。请立即调整或移开热源。',
  temp_low: '局部温度偏低，注意保暖。若伴随皮肤发白、麻木，请及时就医。',
  motion_abnormal:
    '动作特征与所选康复动作不符，可能完成得不够标准。建议对照康复指导书确认动作要领，或降低强度重新采集。',
  device_offline: '传感器无有效读数。请检查电极是否贴合、设备是否在连接范围内、电量是否充足。',
  low_compliance: '近期训练频次低于康复方案要求，建议与康复治疗师沟通调整计划。',
}

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: '提示',
  warning: '警告',
  critical: '严重',
}

/** el-tag 的 type 取值 */
export const ALERT_SEVERITY_TAG: Record<
  AlertSeverity,
  'info' | 'warning' | 'danger'
> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
}

/** 列表筛选用的等级选项，含"全部" */
export const SEVERITY_FILTER_OPTIONS = [
  { value: '', label: '全部等级' },
  { value: 'critical', label: '仅严重' },
  { value: 'warning', label: '仅警告' },
  { value: 'info', label: '仅提示' },
] as const
