// ============================================================================
// 展示格式化
// ============================================================================
// 数据库返回的时间戳都是 UTC 的 ISO 字符串，直接显示会出现时区错乱，
// 一律经过这里再上屏。
// ============================================================================

const EMPTY = '—'

function toDate(input: string | null | undefined): Date | null {
  if (!input) return null
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

const pad = (n: number) => String(n).padStart(2, '0')

/** '2026-09-20 15:30'（按浏览器本地时区） */
export function formatDateTime(input: string | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** '2026-09-20' */
export function formatDate(input: string | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** '15:30' */
export function formatTime(input: string | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前，超过 7 天退回绝对日期。
 */
export function formatRelative(input: string | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY

  const diff = Date.now() - d.getTime()

  // 未来时间说明设备或服务端时钟有偏差，直接显示绝对值，
  // 免得出现"-5 分钟前"这种莫名其妙的文案
  if (diff < 0) return formatDateTime(input)

  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`

  return formatDate(input)
}

/** 秒数 → '1 分 20 秒' / '45 秒' */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return EMPTY
  if (seconds < 60) return `${Math.round(seconds)} 秒`

  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`

  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/**
 * 数值保留指定位数，null/undefined 显示为占位符。
 * 用于 ROM、温度、置信度这类可能为空的测量值。
 */
export function formatNumber(
  value: number | null | undefined,
  digits = 1,
  suffix = '',
): string {
  if (value == null || Number.isNaN(value)) return EMPTY
  return value.toFixed(digits) + suffix
}
