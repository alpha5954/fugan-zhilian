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
    it!.trend!.direction === 'up',
    `${it!.trend!.before.toFixed(1)}° → ${it!.trend!.after.toFixed(1)}°`,
  )
  check(
    '数字用的是保持角度（45~60 区间），不是活动范围（个位数）',
    it!.trend!.after > 40,
    `after=${it!.trend!.after.toFixed(1)}°（若是个位数说明用了 rom_deg）`,
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
    ri.trend?.direction === 'flat',
    `活动范围 ${8}°→${8 + 4 * 3}° 一路上涨，保持角度 ${ri.trend!.before.toFixed(1)}°→${ri.trend!.after.toFixed(1)}° → ${ri.trend?.direction}`,
  )
}

// ============================================================================
console.log('\n--- 数据不足时不能编出趋势 ---')
// ============================================================================
{
  const two = report(run1('屈膝滑动', [60, 80]))
  check(
    '只有 2 天 → 不给方向',
    itemOf(two, '屈膝滑动')!.trend === null,
    JSON.stringify(itemOf(two, '屈膝滑动')!.trend),
  )
  check('并且标出做不了趋势判断', two.hasEnoughData === false)
  check('总结里说明看不出方向', two.headline.includes('看不出'), two.headline)
  check('总结仍然有内容（不是空字符串）', two.headline.trim().length > 0)

  // 边界：刚好 TREND_MIN_POINTS 天就该认账
  const exactly = report(run1('屈膝滑动', Array(TREND_MIN_POINTS).fill(70)))
  check(
    `刚好 ${TREND_MIN_POINTS} 天就有方向了`,
    exactly.items.length === 1 && exactly.items[0]!.trend !== null,
    `得到 ${exactly.items.length} 个动作，trend=${JSON.stringify(exactly.items[0]?.trend?.direction ?? null)}`,
  )
  check('这时 hasEnoughData 为真', exactly.hasEnoughData === true)

  // 一天练多次不能当多天用
  const sameDay = report([
    sess('屈膝滑动', 60, 3),
    sess('屈膝滑动', 62, 3),
    sess('屈膝滑动', 64, 3),
    sess('屈膝滑动', 66, 3),
  ])
  check(
    '同一天的多次记录只算一天',
    itemOf(sameDay, '屈膝滑动')!.points === 1,
    `4 条记录但只有 1 天 → points=${itemOf(sameDay, '屈膝滑动')!.points}`,
  )
  check(
    '只算一天 → 也不给方向',
    itemOf(sameDay, '屈膝滑动')!.trend === null,
  )

  const empty = report([])
  check(
    '完全没有记录时 items 为空（不是一条空条目）',
    empty.headline.length > 0 && empty.items.length === 0,
    empty.headline,
  )
}

// ============================================================================
console.log('\n--- 方向判不出来时，达标状态照样给 ---')
// ============================================================================
// "在往哪个方向走"和"现在达没达标"是两件事：
//
//   方向  需要 ≥ TREND_MIN_POINTS 天，两三个点连不出趋势
//   达标  一次训练就能回答
//
// 原先天数不够时整条丢掉，于是刚练了三天的患者、或者选了「近 7 天」的
// 用户，界面上**一个动作都不显示** —— 连"哪个达标了"都看不到，
// 而那是数据完全支持回答的问题。
{
  const few = report([
    sess('屈膝滑动', 95, 1),
    sess('坐位伸膝', 60, 0),
  ])

  check(
    '记录少也照样列出动作',
    few.items.length === 2,
    few.items.map((i) => i.exercise).join(','),
  )

  const slide = itemOf(few, '屈膝滑动')!
  check('没有方向', slide.trend === null)
  check('但给出最近一次的值', Math.abs(slide.latest - 95) < 1e-9, String(slide.latest))
  check('也给出达标判定', slide.onTarget === true, `目标 ${slide.target}°`)
  check('以及统计到的天数', slide.points === 1, String(slide.points))

  const knee = itemOf(few, '坐位伸膝')!
  check(
    '没达标的那个也照实说',
    knee.onTarget === false,
    `最近 ${knee.latest}° / 目标 ${knee.target}°`,
  )
  // 差 20°/80° = 25%，没超过三成 → 黄灯
  check('灯按"差多少"给，不需要趋势', knee.band === 'yellow', knee.band)

  // 总结要把"能答的答掉"，不能只说一句"看不出趋势"就停
  check(
    '总结里报了达标个数',
    few.headline.includes('1/2') || few.headline.includes('达到目标'),
    few.headline,
  )
}

// ============================================================================
console.log('\n--- 记录太少时不能说"没有变化" ---')
// ============================================================================
// ⚠️ 这条是本次改动里最容易写错的：**"看不出来"和"没变化"是两回事。**
//
// 只有两天记录、而且没达标时，可以报"记录太少、看不出变化、且未达标"
// （那是事实），但**不能**报"没有明显变化"（那是编了一个我们并不知道的
// 结论）。两条结论必须分开，键也不一样。
{
  const few = report([
    sess('坐位伸膝', 50, 1),
    sess('坐位伸膝', 50, 0),
  ])
  const keys = keysOf(few)

  check(
    '记录不足且未达标 → 给的是"记录还太少"那条',
    keys.includes('trend_insufficient'),
    keys.join(','),
  )
  check(
    '不能给"没有明显变化"那条（那是编结论）',
    !keys.includes('trend_stuck'),
    keys.join(','),
  )
  check(
    '措辞里点出"看不出变化"而不是"没有变化"',
    few.findings.find((f) => f.key === 'trend_insufficient')!.label.includes('看不出'),
    few.findings.find((f) => f.key === 'trend_insufficient')!.label,
  )
  check(
    '依据里写清了只有几天记录',
    few.findings.find((f) => f.key === 'trend_insufficient')!.evidence.includes('天记录'),
    few.findings.find((f) => f.key === 'trend_insufficient')!.evidence,
  )

  // 反过来：记录够了、确实是持平的，才该给 trend_stuck
  const enough = report(run1('坐位伸膝', [50, 50, 50, 50]))
  check(
    '记录够了且确实持平 → 给"没有明显变化"那条',
    keysOf(enough).includes('trend_stuck'),
    keysOf(enough).join(','),
  )
  check(
    '不再给"记录太少"那条',
    !keysOf(enough).includes('trend_insufficient'),
    keysOf(enough).join(','),
  )
}

// ============================================================================
console.log('\n--- 方向的判定与门槛 ---')
// ============================================================================
{
  // 屈膝滑动目标 90°，门槛 = max(2, 90×0.08) = 7.2°
  const up = report(run1('屈膝滑动', [60, 62, 70, 72]))
  check(
    '明显上升 → up',
    itemOf(up, '屈膝滑动')!.trend!.direction === 'up',
    `${itemOf(up, '屈膝滑动')!.trend!.before.toFixed(1)} → ${itemOf(up, '屈膝滑动')!.trend!.after.toFixed(1)}`,
  )

  const down = report(run1('屈膝滑动', [80, 78, 70, 68]))
  check(
    '明显下降 → down',
    itemOf(down, '屈膝滑动')!.trend!.direction === 'down',
    `${itemOf(down, '屈膝滑动')!.trend!.before.toFixed(1)} → ${itemOf(down, '屈膝滑动')!.trend!.after.toFixed(1)}`,
  )

  // 变化 7.0° < 门槛 7.2° → 持平
  const small = report(run1('屈膝滑动', [80, 80, 87, 87]))
  check(
    '变化 7.0° 未达门槛 7.2° → 持平',
    itemOf(small, '屈膝滑动')!.trend!.direction === 'flat',
    `${itemOf(small, '屈膝滑动')!.trend!.delta.toFixed(1)}° / 门槛 ${itemOf(small, '屈膝滑动')!.trend!.threshold.toFixed(1)}°`,
  )

  // 变化 8.0° > 门槛 → 上升
  const over = report(run1('屈膝滑动', [80, 80, 88, 88]))
  check(
    '变化 8.0° 超过门槛 → 上升',
    itemOf(over, '屈膝滑动')!.trend!.direction === 'up',
    `${itemOf(over, '屈膝滑动')!.trend!.delta.toFixed(1)}° / 门槛 ${itemOf(over, '屈膝滑动')!.trend!.threshold.toFixed(1)}°`,
  )

  // ⚠️ 门槛按**目标的比例**算，不是固定度数。
  // 直腿抬高目标只有 10°，门槛取绝对值下限 2°；同样涨 2.5°，
  // 对屈膝滑动（门槛 7.2°）是持平，对直腿抬高就是明显进步
  const legRaise = report(run1('直腿抬高', [8, 8, 10.5, 10.5]))
  const slideSame = report(run1('屈膝滑动', [80, 80, 82.5, 82.5]))
  check(
    '同样涨 2.5°：直腿抬高算进步（门槛 2°）',
    itemOf(legRaise, '直腿抬高')!.trend!.direction === 'up',
    `门槛 ${itemOf(legRaise, '直腿抬高')!.trend!.threshold.toFixed(1)}°`,
  )
  check(
    '同样涨 2.5°：屈膝滑动算持平（门槛 7.2°）',
    itemOf(slideSame, '屈膝滑动')!.trend!.direction === 'flat',
    `门槛 ${itemOf(slideSame, '屈膝滑动')!.trend!.threshold.toFixed(1)}°`,
  )

  // 门槛边界用整数构造，避免浮点误差：直腿抬高门槛恰好 2.0，涨 2.0 不算超
  const exact = report(run1('直腿抬高', [8, 8, 10, 10]))
  check(
    '恰好等于门槛 → 持平（判定用严格大于）',
    itemOf(exact, '直腿抬高')!.trend!.direction === 'flat',
    `Δ${itemOf(exact, '直腿抬高')!.trend!.delta.toFixed(1)}° / 门槛 ${itemOf(exact, '直腿抬高')!.trend!.threshold.toFixed(1)}°`,
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
// ============================================================================
console.log('\n--- 达标余量：同一句"达标"下该做的事不一样 ---')
// ============================================================================
// 80.4°/目标 80°（刚够到）和 95.3°/目标 90°（富余 5.9°）都叫"达标"，
// 但前者要巩固、别加量，后者可以进阶。
//
// 加这一层之前，演示数据下整个分析页只产出一条"都在改善、保持当前方案"，
// 对具体动作没有任何建议 —— 而数据里明明有这四个余量值。
{
  // 刚好压线：80.1° / 目标 80° → 余量 0.1%
  const tight = report(run1('坐位伸膝', [70, 75, 79, 80.1]))
  check(
    '刚够到目标 → 给出"余量很小"',
    keysOf(tight).includes('trend_margin_tight'),
    keysOf(tight).join(','),
  )
  check(
    '而且算黄灯（不是绿灯）—— 它是个需要注意的状态',
    tight.findings.find((f) => f.key === 'trend_margin_tight')!.band === 'yellow',
  )
  check(
    '建议是"先巩固、别加量"',
    tight.findings
      .find((f) => f.key === 'trend_margin_tight')!
      .action.includes('巩固'),
    tight.findings.find((f) => f.key === 'trend_margin_tight')!.action,
  )

  // ⚠️ 余量不足 1% 时不能被四舍五入成「0%」——
  //    实测踩过："只高出 0.1°（0%）"读起来像"一点余量都没有"，比原文更吓人
  check(
    '余量不足 1% 时保留一位小数（不能显示成 0%）',
    /（0\.\d%）/.test(
      tight.findings.find((f) => f.key === 'trend_margin_tight')!.evidence,
    ),
    tight.findings.find((f) => f.key === 'trend_margin_tight')!.evidence,
  )

  // 富余很大：直腿抬高目标 10°，做到 14° 就是 +40%
  const roomy = report(run1('直腿抬高', [10, 12, 13, 14]))
  check(
    '明显超出目标 → 给出"可以考虑进阶"',
    keysOf(roomy).includes('trend_margin_roomy'),
    keysOf(roomy).join(','),
  )
  check(
    '它是绿灯 —— 这是好消息，不是问题',
    roomy.findings.find((f) => f.key === 'trend_margin_roomy')!.band === 'green',
  )
  check(
    '建议是"增加阻力或次数"',
    roomy.findings
      .find((f) => f.key === 'trend_margin_roomy')!
      .action.includes('阻力'),
    roomy.findings.find((f) => f.key === 'trend_margin_roomy')!.action,
  )

  // 余量处在中间那段（5%~10%）→ **两条都不给**。
  // 中间那段本来就是正常的，给建议反而是噪音。
  // 坐位伸膝目标 80°，做到 85 就是 +6.3%
  const middle = report(run1('坐位伸膝', [78, 82, 84, 85]))
  check(
    '余量正常（5%~10%）→ 两条都不给，避免噪音',
    !keysOf(middle).includes('trend_margin_tight') &&
      !keysOf(middle).includes('trend_margin_roomy'),
    keysOf(middle).join(','),
  )

  // 未达标的动作**不能**进这两条 —— 它归 trend_stuck 管。
  // 混进来的话同一次评估里会同时出现"没达标"和"刚好达标"两个相反的判断
  const short = report(run1('坐位伸膝', [50, 50, 50, 50]))
  check(
    '未达标的动作不会进余量结论（归"卡住"那条管）',
    !keysOf(short).includes('trend_margin_tight') &&
      !keysOf(short).includes('trend_margin_roomy'),
    keysOf(short).join(','),
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
    Math.abs(it.trend!.threshold - 7.2) < 0.001,
    String(it.trend!.threshold),
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
