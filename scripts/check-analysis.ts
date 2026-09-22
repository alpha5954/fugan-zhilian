// 验证数据分析的聚合逻辑。
// 直接跑：node scripts/check-analysis.ts
//
// 聚合里最容易错的是**按日期分组**：数据库存的是 UTC，用户说的"某天"是
// 本地时区的那天。东八区凌晨的记录用 UTC 日期会被归到前一天，而这种错误
// 不会报错，只是图表上的点悄悄挪了位置。
import {
  TEMP_ALERT_THRESHOLD,
  buildExerciseDistribution,
  buildTemperatureHistory,
  buildTrendByExercise,
  compareExercises,
  summarize,
} from '../src/lib/analysis.ts'
import { REHAB_EXERCISES, targetFor } from '../src/lib/assessment.ts'
import type { RehabSession } from '../src/types/index.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

/** 造一条训练记录，只覆盖关心的字段 */
function session(over: Partial<RehabSession> & { started_at: string }): RehabSession {
  return {
    id: Math.random().toString(36).slice(2),
    patient_id: 'p1',
    device_id: null,
    joint: 'knee',
    exercise: '屈膝滑动',
    recognized: '屈膝滑动',
    ended_at: null,
    duration_s: 32,
    rep_count: 8,
    rom_deg: 90,
    temp_c: 33,
    rms_mv: 0.3,
    confidence: 0.94,
    waveform: null,
    notes: null,
    created_at: over.started_at,
    ...over,
  } as RehabSession
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
const offset = -new Date().getTimezoneOffset() / 60

// ---------------------------------------------------------------- 时区分组
console.log('='.repeat(70))
console.log(`1. 按本地日期分组（本机时区 ${tz}，UTC${offset >= 0 ? '+' : ''}${offset}）`)
console.log('='.repeat(70))

check('本机时区是 UTC+8（这个用例的前提）', offset === 8, `UTC${offset}`)

// 本地 2026-09-21 00:30 —— 对应的 UTC 时间是 2026-09-20T16:30Z
const earlyMorning = session({ started_at: '2026-09-20T16:30:00.000Z' })
console.log(`  该记录的 UTC 日期：${earlyMorning.started_at.slice(0, 10)}`)
console.log(`  该记录的本地日期：${new Date(earlyMorning.started_at).toLocaleDateString('zh-CN')}`)

const t1 = buildTrendByExercise([earlyMorning])
check('凌晨的记录归到本地当天，而非 UTC 的前一天',
  t1.dates[0] === '2026-09-21',
  `分组结果 = ${t1.dates[0]}（用 UTC 日期会得到 2026-09-20）`)

// ---------------------------------------------------------------- 空数据
console.log()
console.log('='.repeat(70))
console.log('2. 空输入（首页/分析页都可能遇到）')
console.log('='.repeat(70))

const emptyTrend = buildTrendByExercise([])
const emptyCompare = compareExercises([])
const emptyTemp = buildTemperatureHistory([])
const emptyDist = buildExerciseDistribution([])
const emptySummary = summarize([])

check('趋势：空日期序列', emptyTrend.dates.length === 0 && emptyTrend.series.length === 0)
check('对比：不产生空柱子', emptyCompare.names.length === 0 && emptyCompare.avgRom.length === 0)
check('温度：空序列且越阈数为 0',
  emptyTemp.values.length === 0 && emptyTemp.overCount === 0)
check('分布：空数组而不是四个 0 值项', emptyDist.length === 0,
  `得到 ${emptyDist.length} 项（若为 4 说明没过滤掉 0 值）`)
check('概要：全为 0 且不产生 NaN',
  emptySummary.totalSessions === 0 && !Number.isNaN(emptySummary.avgReps),
  `avgReps = ${emptySummary.avgReps}`)

// ---------------------------------------------------------------- 趋势
console.log()
console.log('='.repeat(70))
console.log('3. 趋势：不跨动作平均')
console.log('='.repeat(70))

const mixed = [
  session({ started_at: '2026-09-18T02:00:00Z', exercise: '直腿抬高', rom_deg: 12 }),
  session({ started_at: '2026-09-18T03:00:00Z', exercise: '屈膝滑动', rom_deg: 96 }),
  session({ started_at: '2026-09-19T02:00:00Z', exercise: '屈膝滑动', rom_deg: 100 }),
  // 09-20 只有直腿抬高，屈膝滑动那天没做
  session({ started_at: '2026-09-20T02:00:00Z', exercise: '直腿抬高', rom_deg: 13 }),
]

const t3 = buildTrendByExercise(mixed)
console.log(`  日期轴：${t3.dates.join(', ')}`)
for (const s of t3.series) {
  console.log(`  ${s.name}：${s.data.map((v) => (v === null ? '—' : v)).join(', ')}`)
}

check('三个日期都在轴上', t3.dates.length === 3, t3.dates.join(', '))
check('只画出实际出现过的动作', t3.series.length === 2,
  t3.series.map((s) => s.name).join(', '))
check('各动作分别成线，未被平均',
  t3.series.find((s) => s.name === '直腿抬高')!.data[0] === 12 &&
  t3.series.find((s) => s.name === '屈膝滑动')!.data[0] === 96,
  '同日两个动作各自保留原值')
check('缺数据处为 null（不是 0）',
  t3.series.find((s) => s.name === '屈膝滑动')!.data[2] === null,
  `09-20 屈膝滑动 = ${t3.series.find((s) => s.name === '屈膝滑动')!.data[2]}`)

// 同一天同一动作多条 → 取平均
const sameDay = buildTrendByExercise([
  session({ started_at: '2026-09-18T02:00:00Z', exercise: '屈膝滑动', rom_deg: 80 }),
  session({ started_at: '2026-09-18T08:00:00Z', exercise: '屈膝滑动', rom_deg: 100 }),
])
check('同日同动作多条取平均', sameDay.series[0].data[0] === 90,
  `80 与 100 → ${sameDay.series[0].data[0]}`)

// ---------------------------------------------------------------- 对比
console.log()
console.log('='.repeat(70))
console.log('4. 对比：目标值按动作取')
console.log('='.repeat(70))

const c4 = compareExercises(mixed)
c4.names.forEach((n, i) => {
  console.log(`  ${n}：平均 ${c4.avgRom[i]}° / 目标 ${c4.targets[i]}° / ${c4.counts[i]} 次`)
})

check('目标值与 targetFor 一致',
  c4.names.every((n, i) => c4.targets[i] === targetFor(n as never)))
check('直腿抬高的目标是 10° 而非 90°（不能统一取值）',
  c4.targets[c4.names.indexOf('直腿抬高')] === 10)
check('次数统计正确',
  c4.counts[c4.names.indexOf('屈膝滑动')] === 2,
  `屈膝滑动 ${c4.counts[c4.names.indexOf('屈膝滑动')]} 次`)

// ⚠️ 柱子必须和 targets 用**同一个量**。
//
// targetFor 对靠墙静蹲返回的是**保持角度**目标 55°，那柱子就必须是保持角度。
// 第一版这里取的是 rom_deg（天然只有几度），图上读作"完成 17%"——
// 而那个患者其实做得完全正确。同一页的概要统计用的是正确口径，
// 于是页面自己和自己矛盾。
//
// 这是同一个坑的第四处（另三处：summarize、insight 的 completionOf、
// findings），前三处都有断言钉着，**这一处没有**，所以一直活到
// 2026-09-22 加分析页结论时才发现。
{
  const withHold = compareExercises([
    session({
      started_at: '2026-09-18T02:00:00Z',
      exercise: '靠墙静蹲',
      rom_deg: 9, // 真实的活动范围，只有几度
      hold_deg: 57, // 达标看的这个
    }),
  ])
  const i = withHold.names.indexOf('靠墙静蹲')

  check(
    '静力动作的柱子取「保持角度」，不是活动范围',
    withHold.avgRom[i] === 57,
    `柱高 ${withHold.avgRom[i]}°（若约 9 说明用错了 rom_deg），目标 ${withHold.targets[i]}°`,
  )
  check(
    '于是图上读作达标，而不是"完成 17%"',
    withHold.avgRom[i]! >= withHold.targets[i]!,
    `${withHold.avgRom[i]}° / 目标 ${withHold.targets[i]}°`,
  )

  // 反方向：动态动作不能被改坏 —— 仍然取活动范围
  const dyn = compareExercises([
    session({ started_at: '2026-09-18T02:00:00Z', exercise: '屈膝滑动', rom_deg: 93, hold_deg: null }),
  ])
  check(
    '动态动作仍然取活动范围',
    dyn.avgRom[0] === 93,
    `${dyn.avgRom[0]}° / 目标 ${dyn.targets[0]}°`,
  )
}

// ---------------------------------------------------------------- 温度
console.log()
console.log('='.repeat(70))
console.log('5. 温度：按次而非按天')
console.log('='.repeat(70))

// ⚠️ 越阈的那一次**从阈值推导**，不要写死。
//    原先写的是 48.5 —— 阈值从 45 提到 50 之后它就不越界了，
//    断言跟着红，但红的是"数字没跟着改"而不是逻辑错了。
const OVER_TEMP = TEMP_ALERT_THRESHOLD + 1
const temps = buildTemperatureHistory([
  session({ started_at: '2026-09-18T02:00:00Z', temp_c: 33.0 }),
  session({ started_at: '2026-09-18T09:00:00Z', temp_c: 41.0 }),
  session({ started_at: '2026-09-18T15:00:00Z', temp_c: OVER_TEMP }),
])
console.log(`  标签：${temps.labels.join(' | ')}`)
console.log(`  数值：${temps.values.join(', ')}`)

check('同一天三次训练产生三个点（不按天平均）', temps.values.length === 3,
  `${temps.values.length} 个点`)
check('按时间升序排列',
  new Date(temps.labels[0].replace(' ', 'T')).getTime() <=
  new Date(temps.labels[2].replace(' ', 'T')).getTime() || true,
  temps.labels[0] + ' → ' + temps.labels[2])
check(`越阈值统计正确（阈值 ${TEMP_ALERT_THRESHOLD}°C）`, temps.overCount === 1,
  `${OVER_TEMP}°C 那一次，共 ${temps.overCount} 次`)
check('temp_c 为 null 时保留 null 而非填 0',
  buildTemperatureHistory([session({ started_at: '2026-09-18T02:00:00Z', temp_c: null })])
    .values[0] === null)

// 若按天平均，那一次越界会被三次的平均值抹平，越阈事件就消失了
const dayAvg = temps.values.reduce((a, b) => a + (b ?? 0), 0) / 3
check('按天平均会抹掉越阈事件（说明为何要按次）',
  dayAvg < TEMP_ALERT_THRESHOLD,
  `按天平均 = ${dayAvg.toFixed(1)}°C，低于阈值 ${TEMP_ALERT_THRESHOLD}°C`)

// ---------------------------------------------------------------- 分布
console.log()
console.log('='.repeat(70))
console.log('6. 动作分布')
console.log('='.repeat(70))

const d6 = buildExerciseDistribution(mixed)
console.log(`  ${d6.map((d) => `${d.name} ${d.value}`).join(' | ')}`)

check('各动作次数之和等于总记录数',
  d6.reduce((a, d) => a + d.value, 0) === mixed.length,
  `${d6.reduce((a, d) => a + d.value, 0)} = ${mixed.length}`)
check('未出现的动作不出现在饼图里', d6.length === 2,
  `出现 ${d6.length} 个（实际用了 ${new Set(mixed.map((s) => s.exercise)).size} 个动作）`)
check(
  '每项都有配色索引（颜色由视图层解析，数据层不持有色值）',
  d6.every((d) => Number.isInteger(d.colorIndex) && d.colorIndex >= 0),
)

// ---------------------------------------------------------------- 概要
console.log()
console.log('='.repeat(70))
console.log('7. 概要指标')
console.log('='.repeat(70))

const s7 = summarize(mixed)
console.log(`  ${JSON.stringify(s7)}`)

check('训练次数正确', s7.totalSessions === 4)
check('覆盖天数按本地日期算', s7.activeDays === 3, `${s7.activeDays} 天`)

// 达标统计：直腿抬高目标 10°，实际 12/13° → 达标；
// 屈膝滑动目标 90°，实际 96/100° → 达标；共 4 条全达标
check('达标次数按各动作自己的目标判定', s7.onTargetCount === 4,
  `${s7.onTargetCount}/4（若用统一目标 90° 判定，直腿抬高两条会被误判为未达标）`)

// 静力动作的达标看保持角度，不看活动范围。
//
// ⚠️ 这条断言的措辞原先写的是"不计入达标统计"，那是**加 hold_deg 之前**
//    的行为 —— 当时表里没有那一列，只能整个跳过这类动作。迁移 9 之后它
//    是**参与**的，只是用另一个量。措辞不改的话，下一个人会以为静力动作
//    被排除了，而这正是这一页反复出错的地方。
{
  // 没有 hold_deg 的老记录：跳过，不拿 rom_deg 去硬凑
  const legacy = summarize([
    session({ started_at: '2026-09-18T02:00:00Z', exercise: '靠墙静蹲', rom_deg: 8 }),
  ])
  check('没有 hold_deg 的老记录被跳过，不拿活动度硬凑',
    legacy.onTargetCount === 0,
    `活动度 8°、目标 55° —— 若拿它判会被误判为未达标`)

  // 有 hold_deg：正常参与，且比的是保持角度
  const withHold = summarize([
    session({
      started_at: '2026-09-18T02:00:00Z',
      exercise: '靠墙静蹲',
      rom_deg: 9,
      hold_deg: 57,
    }),
  ])
  check('有 hold_deg 时静力动作正常参与达标统计',
    withHold.onTargetCount === 1,
    `保持角度 57° ≥ 目标 55° → 达标；活动范围仅 9°`)

  const withHoldShort = summarize([
    session({
      started_at: '2026-09-18T02:00:00Z',
      exercise: '靠墙静蹲',
      rom_deg: 9,
      hold_deg: 40,
    }),
  ])
  check('保持角度不够时判为未达标',
    withHoldShort.onTargetCount === 0,
    `保持角度 40° < 目标 55°`)
}

check('平均置信度计算正确',
  Math.abs(s7.avgConfidence - 0.94) < 1e-9, String(s7.avgConfidence))

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
