// 验证进展结论层（数据分析页的结论）。
// 直接跑：node scripts/check-trend.ts
//
// 这一层和 findings 一样有两个别的模块没有的风险：
//
//   1. **静力动作量错对象**。靠墙静蹲达标看的是「保持角度」，活动范围只有
//      几度。拿活动范围去算趋势，会把一个做得完全正确的患者报成"没有进展"。
//      本项目的 completionOf / summarize / findings 已经各踩过一次，
//      这是第四处 —— 必须单独钉。
//   2. **用太少的点编出趋势**。两个点连一条线，那不是趋势，是画出来的结论。
//      而结论一旦写出来，家属会当真。
import { buildTrendReport } from '../src/lib/trend.ts'
import type { TrendReport } from '../src/lib/trend.ts'
import { metricFor, targetFor, type ExerciseName } from '../src/lib/assessment.ts'
import { TEMP_ALERT_THRESHOLD } from '../src/lib/simulator.ts'
import { TREND_MIN_POINTS } from '../src/lib/scoreConfig.ts'
import type { RehabSession } from '../src/types/index.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

/** 固定的"现在"。传死时间，否则覆盖率之类的断言会随运行时刻漂移 */
const NOW = new Date(2026, 8, 21, 20, 0, 0)
const DAY = 86_400_000

function daysAgo(n: number, hour = 10): string {
  const d = new Date(NOW.getTime() - n * DAY)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

let seq = 0

/**
 * 造一条记录。
 *
 * `value` 是**判定用的那个量**，按动作类型自动落到正确的字段 ——
 * 静力动作落到 hold_deg，动态动作落到 rom_deg。测试代码里如果手动去写
 * rom_deg，就很容易跟着实现一起错。
 *
 * 静力动作的 rom_deg 固定给 8°（真实情况就是几度，只有姿势微调），
 * 这样"实现误用了 rom_deg"时断言能立刻发现。
 */
function sess(
  exercise: ExerciseName,
  value: number,
  day: number,
  over: Partial<RehabSession> = {},
): RehabSession {
  const isHold = metricFor(exercise) === 'hold'
  return {
    id: `s${seq++}`,
    patient_id: 'p1',
    device_id: null,
    joint: '膝关节',
    exercise,
    recognized: exercise,
    started_at: daysAgo(day),
    ended_at: null,
    duration_s: 32,
    rep_count: 8,
    rom_deg: isHold ? 8 : value,
    hold_deg: isHold ? value : null,
    temp_c: 33,
    rms_mv: 0.4,
    confidence: 0.95,
    waveform: null,
    notes: null,
    created_at: daysAgo(day),
    ...over,
  } as RehabSession
}

/** 一个动作 n 天，值取自 values（values[0] 是最早那天） */
function run1(
  exercise: ExerciseName,
  values: number[],
  over: Partial<RehabSession> = {},
): RehabSession[] {
  return values.map((v, i) => sess(exercise, v, values.length - 1 - i, over))
}

const report = (sessions: RehabSession[], days = 30): TrendReport =>
  buildTrendReport(sessions, { days, now: NOW })

const itemOf = (r: TrendReport, exercise: string) =>
  r.items.find((i) => i.exercise === exercise)

const keysOf = (r: TrendReport) => r.findings.map((f) => f.key)

// ============================================================================
console.log('\n--- 合规：措辞不能越界成诊断 ---')
// ============================================================================
{
  // 覆盖尽量多的结论类型，一起过筛
  const all = [
    report([
      ...run1('屈膝滑动', [60, 65, 70, 75, 80]),
      ...run1('坐位伸膝', [50, 52, 51, 53, 52]),
      ...run1('直腿抬高', [6, 6, 6, 6, 6]),
      ...run1('靠墙静蹲', [40, 42, 41, 43, 44]),
    ]),
    report(run1('屈膝滑动', [60, 65, 70, 75, 80], { temp_c: 48 })),
    report(run1('屈膝滑动', [60, 65, 70, 75, 80], { confidence: 0.4 })),
    // 30 天里只练 3 天 → 覆盖率偏低
    report([
      sess('屈膝滑动', 60, 29),
      sess('屈膝滑动', 65, 20),
      sess('屈膝滑动', 70, 1),
    ]),
    report([]),
  ].flatMap((r) => r.findings)

  const BANNED = ['诊断', '症', '炎', '病变', '处方', '服药', '用药', '手术治疗']
  const hit = all.filter(
    (f) => BANNED.some((w) => f.label.includes(w) || f.action.includes(w)),
  )
  check(
    `没有任何结论使用疾病名或诊断措辞（${all.length} 条过筛）`,
    hit.length === 0,
    hit.map((f) => f.label).join(' / '),
  )

  const blame = all.filter(
    (f) => f.label.startsWith('你') || f.label.includes('患者存在') || f.label.includes('病人'),
  )
  check(
    '结论的主语是数据/训练，不是患者本人',
    blame.length === 0,
    blame.map((f) => f.label).join(' / '),
  )

  const noEvidence = all.filter((f) => !/\d/.test(f.evidence))
  check(
    '每条结论的依据里都有具体数值',
    noEvidence.length === 0,
    noEvidence.map((f) => `${f.key}: ${f.evidence}`).join(' / '),
  )
}

// ============================================================================
console.log('\n--- 静力动作必须按「保持角度」算，不能拿活动范围 ---')
// ============================================================================
// 靠墙静蹲达标看的是保持角度（目标 55°），活动范围天然只有几度。
// 拿活动范围算趋势，会把一个从 47° 进步到 56° 的患者报成"没有进展"。
{
  const r = report(run1('靠墙静蹲', [47, 49, 50, 54, 56]))
  const it = itemOf(r, '靠墙静蹲')

  check('静力动作能产出趋势', Boolean(it), r.items.map((i) => i.exercise).join(','))
  check(
    '判定用的量标成「保持角度」',
    it!.metricName === '保持角度',
    it!.metricName,
  )
  check(
    '方向按保持角度判为改善',
    it!.direction === 'up',
    `${it!.before.toFixed(1)}° → ${it!.after.toFixed(1)}°`,
  )
  check(
    '数字用的是保持角度（45~60 区间），不是活动范围（个位数）',
    it!.after > 40,
    `after=${it!.after.toFixed(1)}°（若是个位数说明用了 rom_deg）`,
  )

  // ⚠️ 反向测试：活动范围在涨、保持角度没动 → 必须判"持平"
  //
  // 这条是关键。正向测试只能证明"静力动作能出结论"；只有反向测试能证明
  // **实现真的在用 hold_deg**，而不是碰巧两个量都在涨。
  const rev = report(
    [47, 48, 47, 48, 47].map((hold, i) =>
      sess('靠墙静蹲', hold, 4 - i, { rom_deg: 8 + i * 3 }),
    ),
  )
  const ri = itemOf(rev, '靠墙静蹲')!
  check(
    '活动范围在涨、保持角度没动 → 判为持平（证明用的是 hold_deg）',
    ri.direction === 'flat',
    `活动范围 ${8}°→${8 + 4 * 3}° 一路上涨，保持角度 ${ri.before.toFixed(1)}°→${ri.after.toFixed(1)}° → ${ri.direction}`,
  )
}

// ============================================================================
console.log('\n--- 数据不足时不能编出趋势 ---')
// ============================================================================
{
  const two = report(run1('屈膝滑动', [60, 80]))
  check('只有 2 天 → 不给趋势', two.items.length === 0, two.items.map((i) => i.exercise).join(','))
  check('并且标出数据不够', two.hasEnoughData === false)
  check('总结里说明看不出趋势', two.headline.includes('看不出'), two.headline)
  check('总结仍然有内容（不是空字符串）', two.headline.trim().length > 0)

  // 边界：刚好 TREND_MIN_POINTS 天就该认账
  const exactly = report(run1('屈膝滑动', Array(TREND_MIN_POINTS).fill(70)))
  check(
    `刚好 ${TREND_MIN_POINTS} 天就算够用`,
    exactly.items.length === 1,
    `得到 ${exactly.items.length} 个动作`,
  )

  // 一天练多次不能当多天用
  const sameDay = report([
    sess('屈膝滑动', 60, 3),
    sess('屈膝滑动', 62, 3),
    sess('屈膝滑动', 64, 3),
    sess('屈膝滑动', 66, 3),
  ])
  check(
    '同一天的多次记录只算一天',
    sameDay.items.length === 0,
    `4 条记录但只有 1 天 → ${sameDay.items.length} 个动作`,
  )

  const empty = report([])
  check('空数据不报错且有话说', empty.headline.length > 0 && empty.items.length === 0, empty.headline)
}

// ============================================================================
console.log('\n--- 方向的判定与门槛 ---')
// ============================================================================
{
  // 屈膝滑动目标 90°，门槛 = max(2, 90×0.08) = 7.2°
  const up = report(run1('屈膝滑动', [60, 62, 70, 72]))
  check(
    '明显上升 → up',
    itemOf(up, '屈膝滑动')!.direction === 'up',
    `${itemOf(up, '屈膝滑动')!.before.toFixed(1)} → ${itemOf(up, '屈膝滑动')!.after.toFixed(1)}`,
  )

  const down = report(run1('屈膝滑动', [80, 78, 70, 68]))
  check(
    '明显下降 → down',
    itemOf(down, '屈膝滑动')!.direction === 'down',
    `${itemOf(down, '屈膝滑动')!.before.toFixed(1)} → ${itemOf(down, '屈膝滑动')!.after.toFixed(1)}`,
  )

  // 变化 7.0° < 门槛 7.2° → 持平
  const small = report(run1('屈膝滑动', [80, 80, 87, 87]))
  check(
    '变化 7.0° 未达门槛 7.2° → 持平',
    itemOf(small, '屈膝滑动')!.direction === 'flat',
    `${itemOf(small, '屈膝滑动')!.delta.toFixed(1)}° / 门槛 ${itemOf(small, '屈膝滑动')!.threshold.toFixed(1)}°`,
  )

  // 变化 8.0° > 门槛 → 上升
  const over = report(run1('屈膝滑动', [80, 80, 88, 88]))
  check(
    '变化 8.0° 超过门槛 → 上升',
    itemOf(over, '屈膝滑动')!.direction === 'up',
    `${itemOf(over, '屈膝滑动')!.delta.toFixed(1)}° / 门槛 ${itemOf(over, '屈膝滑动')!.threshold.toFixed(1)}°`,
  )

  // ⚠️ 门槛按**目标的比例**算，不是固定度数。
  // 直腿抬高目标只有 10°，门槛取绝对值下限 2°；同样涨 2.5°，
  // 对屈膝滑动（门槛 7.2°）是持平，对直腿抬高就是明显进步
  const legRaise = report(run1('直腿抬高', [8, 8, 10.5, 10.5]))
  const slideSame = report(run1('屈膝滑动', [80, 80, 82.5, 82.5]))
  check(
    '同样涨 2.5°：直腿抬高算进步（门槛 2°）',
    itemOf(legRaise, '直腿抬高')!.direction === 'up',
    `门槛 ${itemOf(legRaise, '直腿抬高')!.threshold.toFixed(1)}°`,
  )
  check(
    '同样涨 2.5°：屈膝滑动算持平（门槛 7.2°）',
    itemOf(slideSame, '屈膝滑动')!.direction === 'flat',
    `门槛 ${itemOf(slideSame, '屈膝滑动')!.threshold.toFixed(1)}°`,
  )

  // 门槛边界用整数构造，避免浮点误差：直腿抬高门槛恰好 2.0，涨 2.0 不算超
  const exact = report(run1('直腿抬高', [8, 8, 10, 10]))
  check(
    '恰好等于门槛 → 持平（判定用严格大于）',
    itemOf(exact, '直腿抬高')!.direction === 'flat',
    `Δ${itemOf(exact, '直腿抬高')!.delta.toFixed(1)}° / 门槛 ${itemOf(exact, '直腿抬高')!.threshold.toFixed(1)}°`,
  )
}

// ============================================================================
console.log('\n--- 达标看的是最近一次，不是历史平均 ---')
// ============================================================================
{
  // 前四次都在 70°，最后一次 92° —— 历史平均 74° 不达标，但最近一次达标了
  const r = report(run1('屈膝滑动', [70, 70, 70, 70, 92]))
  const it = itemOf(r, '屈膝滑动')!
  check(
    '最近一次 92° ≥ 目标 90° → 判为达标',
    it.onTarget === true,
    `历史平均 ${((70 * 4 + 92) / 5).toFixed(1)}°，最近一次 ${it.latest.toFixed(1)}°`,
  )
  check('latest 取的是最后一天的均值', Math.abs(it.latest - 92) < 1e-9, String(it.latest))

  // 反过来：一路 92°，最后一次掉到 70°
  const drop = report(run1('屈膝滑动', [92, 92, 92, 92, 70]))
  check(
    '一路达标但最近一次掉下去 → 判为未达标',
    itemOf(drop, '屈膝滑动')!.onTarget === false,
    `最近一次 ${itemOf(drop, '屈膝滑动')!.latest.toFixed(1)}°`,
  )
}

// ============================================================================
console.log('\n--- 温度 ---')
// ============================================================================
{
  // ⚠️ over 会应用到 run1 造出来的**每一条**记录上，所以这里必须显式
  //    只让一条越阈值 —— 否则测的是"越阈 4 次"，跑出来是红灯。
  //    （第一版就是这么写错的，断言红了才发现是测试的问题不是代码的问题。）
  const onlyOne = [
    sess('屈膝滑动', 60, 3, { temp_c: TEMP_ALERT_THRESHOLD }),
    sess('屈膝滑动', 65, 2),
    sess('屈膝滑动', 70, 1),
    sess('屈膝滑动', 75, 0),
  ]

  // 阈值边界：刚好等于阈值也算越阈（判定用的是 >=）
  const exact = report(onlyOne)
  check(
    '刚好等于阈值也算越阈',
    keysOf(exact).includes('trend_temp_over'),
    `temp_c = ${TEMP_ALERT_THRESHOLD}，阈值 ${TEMP_ALERT_THRESHOLD}`,
  )
  check(
    '只越一次算黄灯',
    exact.findings.find((f) => f.key === 'trend_temp_over')!.band === 'yellow',
    exact.findings.find((f) => f.key === 'trend_temp_over')!.band,
  )
  check(
    '温度排在第一条（安全优先）',
    exact.findings[0]!.key === 'trend_temp_over',
    exact.findings[0]!.key,
  )

  // 反复越阈值 → 红灯。偶尔一次可能是热敷久了，反复说明做法有问题
  const many = report(
    run1('屈膝滑动', [60, 65, 70, 75, 78], { temp_c: TEMP_ALERT_THRESHOLD + 2 }),
  )
  check(
    '越阈值 5 次 → 红灯',
    many.findings.find((f) => f.key === 'trend_temp_over')!.band === 'red',
    `${many.findings.find((f) => f.key === 'trend_temp_over')!.band}：${many.findings.find((f) => f.key === 'trend_temp_over')!.evidence}`,
  )

  const clean = report(run1('屈膝滑动', [60, 65, 70, 75]))
  check('不越阈值就不提温度', !keysOf(clean).includes('trend_temp_over'), keysOf(clean).join(','))
}

// ============================================================================
console.log('\n--- 训练覆盖率的分母是"观察到的跨度"，不是窗口长度 ---')
// ============================================================================
// 一个三天前才开始训练、每天都练的患者，覆盖率是 100%，
// 不该被说成"练得太少"。分母用窗口长度就会误报。
{
  const fresh = report([
    sess('屈膝滑动', 60, 2),
    sess('屈膝滑动', 65, 1),
    sess('屈膝滑动', 70, 0),
  ])
  check(
    '刚开始 3 天、天天练 → 不报"练得太少"',
    !keysOf(fresh).includes('trend_low_adherence'),
    keysOf(fresh).join(',') || '(无结论)',
  )

  // 30 天里只练了 3 天 → 报
  const sparse = report([
    sess('屈膝滑动', 60, 29),
    sess('屈膝滑动', 65, 20),
    sess('屈膝滑动', 70, 1),
  ])
  check(
    '30 天里只练 3 天 → 报"练得太少"',
    keysOf(sparse).includes('trend_low_adherence'),
    keysOf(sparse).join(','),
  )
}

// ============================================================================
console.log('\n--- 排序与好消息 ---')
// ============================================================================
{
  // 达标的一个 + 未达标的一个 → 未达标的排前面
  const r = report([
    ...run1('屈膝滑动', [85, 90, 92, 95]), // 达标、上升
    ...run1('坐位伸膝', [50, 50, 50, 50]), // 未达标、持平
  ])
  check(
    '未达标的动作排在达标的前面',
    r.items[0]!.exercise === '坐位伸膝',
    r.items.map((i) => `${i.exercise}${i.onTarget ? '(达标)' : '(未达标)'}`).join(' > '),
  )
  check(
    '未达标且没改善 → 给出专门结论',
    keysOf(r).includes('trend_stuck'),
    keysOf(r).join(','),
  )

  // 全都达标且都在上升 → 要有好消息，不能只报问题
  const good = report([
    ...run1('屈膝滑动', [85, 88, 92, 95]),
    ...run1('坐位伸膝', [75, 78, 82, 85]),
  ])
  check(
    '全都在改善 → 给出绿灯结论',
    keysOf(good).includes('trend_up'),
    keysOf(good).join(','),
  )
  check(
    '好消息是绿灯',
    good.findings.find((f) => f.key === 'trend_up')!.band === 'green',
  )

  // 全都持平且达标 → 也要说一句，不能什么都不说
  const flatAll = report([
    ...run1('屈膝滑动', [92, 92, 92, 92]),
    ...run1('坐位伸膝', [82, 82, 82, 82]),
  ])
  check(
    '全部持平且达标 → 给"平台期正常"的结论',
    keysOf(flatAll).includes('trend_flat_all'),
    keysOf(flatAll).join(','),
  )
}

// ============================================================================
console.log('\n--- 窗口的说法与短窗口提示 ---')
// ============================================================================
{
  check('days=30 → 文案是"近 30 天"', report([], 30).windowLabel === '近 30 天', report([], 30).windowLabel)
  check('days=0 → 文案是"全部时间"', report([], 0).windowLabel === '全部时间', report([], 0).windowLabel)
  check('days=7 → 标记为短窗口', report([], 7).shortWindow === true)
  check('days=30 → 不是短窗口', report([], 30).shortWindow === false)
  check('days=0（全部时间）→ 不是短窗口', report([], 0).shortWindow === false)

  // 结论必须带窗口 —— 不带的话会被误当成"整体情况"
  const r = report(run1('屈膝滑动', [60, 65, 70, 75]), 30)
  check(
    '总结里带上了窗口',
    r.headline.includes('近 30 天'),
    r.headline,
  )
}

// ============================================================================
console.log('\n--- 每个动作都要有目标可依 ---')
// ============================================================================
{
  const r = report(run1('屈膝滑动', [60, 65, 70, 75]))
  const it = itemOf(r, '屈膝滑动')!
  check(
    '趋势项带上了该动作的康复目标',
    it.target === targetFor('屈膝滑动'),
    `${it.target}°`,
  )
  check(
    '门槛按目标的比例算（90 × 8% = 7.2°）',
    Math.abs(it.threshold - 7.2) < 0.001,
    String(it.threshold),
  )
}

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
process.exit(passed === results.length ? 0 : 1)
