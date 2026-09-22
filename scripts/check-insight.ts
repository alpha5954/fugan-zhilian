// 验证结论层的评分与风险分级。
// 直接跑：node scripts/check-insight.ts
//
// 这一层比别处更需要断言：它输出的是一个**数字和一个红黄绿**，
// 算错了不会有任何报错，只会安静地给出一个错的结论 —— 而家属会当真。
//
// 重点钉四类东西：
//   1. 没有数据 / 数据不够时不能编出一个分数来
//   2. 静力动作不能被拿活动度去比保持角度的目标（这是最容易犯的领域错误）
//   3. 预警能不能盖过评分（分数高但有严重预警，必须是红的）
//   4. 时间窗口按**本地**日期算，不是 UTC
import { buildInsight, BAND_LABEL } from '../src/lib/insight.ts'
import type { RiskBand } from '../src/lib/insight.ts'
import type { Alert, RehabSession } from '../src/types/index.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// 构造工具
// ---------------------------------------------------------------------------

/** 固定的"现在"。传死时间而不是用当前时刻，否则断言会随运行时间漂移 */
const NOW = new Date(2026, 8, 21, 20, 0, 0) // 2026-09-21 20:00 本地时间
const DAY = 86_400_000

/** n 天前的某个**本地**时刻，返回 ISO 字符串 */
function daysAgo(n: number, hour = 10, minute = 0): string {
  const d = new Date(NOW.getTime() - n * DAY)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function session(over: Partial<RehabSession> = {}): RehabSession {
  return {
    id: Math.random().toString(36).slice(2),
    patient_id: 'p1',
    device_id: null,
    joint: '膝关节',
    exercise: '屈膝滑动',
    recognized: '屈膝滑动',
    started_at: daysAgo(0),
    ended_at: null,
    duration_s: 32,
    rep_count: 8,
    rom_deg: 90,
    // 默认 null：模拟"动态动作"或"没有保持角度的老记录"。
    // 测静力动作时要显式给值
    hold_deg: null,
    temp_c: 33,
    rms_mv: 0.4,
    confidence: 0.95,
    waveform: null,
    notes: null,
    created_at: daysAgo(0),
    ...over,
  } as RehabSession
}

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: Math.random().toString(36).slice(2),
    patient_id: 'p1',
    device_id: null,
    session_id: null,
    kind: 'temp_high',
    severity: 'warning',
    message: null,
    value: 47.2,
    threshold: 45,
    occurred_at: daysAgo(0),
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: daysAgo(0),
    ...over,
  } as Alert
}

const partOf = (ins: ReturnType<typeof buildInsight>, key: string) =>
  ins.parts.find((p) => p.key === key)!

/** 断言红黄绿 */
function expectBand(label: string, ins: ReturnType<typeof buildInsight>, want: RiskBand) {
  check(label, ins.band === want, `得到 ${ins.band}（${BAND_LABEL[ins.band]}）`)
}

// ============================================================================
console.log('\n--- 没有数据时不能编分数 ---')
// ============================================================================
{
  const ins = buildInsight([], [], NOW)
  check('空数据时 score 为 null', ins.score === null, String(ins.score))
  check('标出 hasAnyData=false', ins.stats.hasAnyData === false)
  check('仍然给出三张卡片', ins.cards.length === 3, `得到 ${ins.cards.length} 张`)
  check(
    '第一张卡片说明今天没训练',
    ins.cards[0]!.headline.includes('还没有'),
    ins.cards[0]!.headline,
  )
  check(
    '建议卡片说清"完成第一次训练后才有建议"',
    ins.cards[2]!.detail.includes('第一次训练'),
    ins.cards[2]!.detail,
  )
  // 没数据不能报红 —— 那会吓到刚装上设备的用户
  check('没数据时不报红', ins.band !== 'red', ins.band)
}

// ============================================================================
console.log('\n--- 权重与取值范围 ---')
// ============================================================================
{
  const ins = buildInsight([session()], [], NOW)
  const sum = ins.parts.reduce((s, p) => s + p.weight, 0)
  check('四个分量权重之和为 1', Math.abs(sum - 1) < 1e-9, String(sum))
  check('分量恰好四个', ins.parts.length === 4, String(ins.parts.length))

  const all = ins.parts.every((p) => p.value >= 0 && p.value <= 1)
  check('每个分量都在 0~1 之间', all, ins.parts.map((p) => `${p.key}=${p.value}`).join(', '))
  check(
    '总分是 0~100 的整数',
    Number.isInteger(ins.score) && ins.score! >= 0 && ins.score! <= 100,
    String(ins.score),
  )
}

// ============================================================================
console.log('\n--- 达标度 ---')
// ============================================================================
{
  // 屈膝滑动目标 90°。做满 → 100%
  const full = buildInsight([session({ rom_deg: 90 })], [], NOW)
  check('刚好达标 → 达标度 1.0', partOf(full, 'target').value === 1, String(partOf(full, 'target').value))

  // 超出目标不能超过 1（否则一次超常发挥能把别的短板全补上）
  const over = buildInsight([session({ rom_deg: 200 })], [], NOW)
  check('超出目标也封顶在 1.0', partOf(over, 'target').value === 1, String(partOf(over, 'target').value))

  const half = buildInsight([session({ rom_deg: 45 })], [], NOW)
  check('做一半 → 达标度 0.5', Math.abs(partOf(half, 'target').value - 0.5) < 1e-9, String(partOf(half, 'target').value))

  // ---- 静力动作按「保持角度」参与判定 ----
  // 靠墙静蹲目标 55° 指的是保持角度。静蹲的活动范围天然只有 5~10°，
  // 拿它比 55° 会把做得完全正确的患者判成 0 分。
  //
  // 迁移 9 加了 hold_deg 之后这类动作才算真正接上。
  const staticOk = buildInsight(
    [session({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 55 })],
    [],
    NOW,
  )
  check(
    '静力动作按保持角度参与判定',
    partOf(staticOk, 'target').value === 1,
    `得到 ${partOf(staticOk, 'target').value}`,
  )

  const staticHalf = buildInsight(
    [session({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 27.5 })],
    [],
    NOW,
  )
  check(
    '静力动作不是拿活动范围去比',
    Math.abs(partOf(staticHalf, 'target').value - 0.5) < 1e-9,
    `得到 ${partOf(staticHalf, 'target').value}` +
      `（若约 0.145 说明用了 rom_deg）`,
  )

  // 动态动作与静力动作混在一起时，各按各的指标算
  const mixed = buildInsight(
    [
      session({ exercise: '屈膝滑动', rom_deg: 90, hold_deg: null }),
      session({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 55 }),
    ],
    [],
    NOW,
  )
  check(
    '动态与静力混排时各按各的指标',
    mixed.parts.find((p) => p.key === 'target')!.value === 1,
    String(mixed.parts.find((p) => p.key === 'target')!.value),
  )

  // 老记录没有 hold_deg（这列是后加的，无法还原）。取不到值就跳过，
  // 不要拿 rom_deg 去硬凑 —— 宁可少算，也不要算错
  const legacy = buildInsight(
    [session({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: null })],
    [],
    NOW,
  )
  check(
    '没有 hold_deg 的老记录被跳过而不是硬凑',
    partOf(legacy, 'target').value === 0 &&
      partOf(legacy, 'target').detail.includes('还没有可用于判定'),
    partOf(legacy, 'target').detail,
  )
}

// ============================================================================
console.log('\n--- 进步度 ---')
// ============================================================================
{
  // 基线：3 次 屈膝滑动 rom=45 → 完成度 0.5
  const baseline = [1, 4, 6].map((n) => session({ rom_deg: 45, started_at: daysAgo(9 + n) }))

  // 本周完成度 0.6（rom=54）→ 变化 +20% → 满分
  const up = buildInsight([...baseline, session({ rom_deg: 54 })], [], NOW)
  check(
    '+20% 映射到满分',
    Math.abs(partOf(up, 'progress').value - 1) < 1e-9,
    `${partOf(up, 'progress').value}  ${partOf(up, 'progress').detail}`,
  )
  check(
    '进步文案说"提升 20%"',
    partOf(up, 'progress').detail.includes('提升 20%'),
    partOf(up, 'progress').detail,
  )

  // 持平 → 中间值
  const flat = buildInsight([...baseline, session({ rom_deg: 45 })], [], NOW)
  check(
    '持平映射到 0.5',
    Math.abs(partOf(flat, 'progress').value - 0.5) < 1e-9,
    String(partOf(flat, 'progress').value),
  )
  check('持平文案写"持平"', partOf(flat, 'progress').detail.includes('持平'), partOf(flat, 'progress').detail)

  // 同样幅度下滑 → 0
  const down = buildInsight([...baseline, session({ rom_deg: 36 })], [], NOW)
  check(
    '-20% 映射到 0',
    Math.abs(partOf(down, 'progress').value) < 1e-9,
    `${partOf(down, 'progress').value}  ${partOf(down, 'progress').detail}`,
  )

  // ---- 基线不够时必须取中性值 ----
  // 两次记录算出来的"进步 300%"只会误导人
  const thin = buildInsight(
    [session({ rom_deg: 45, started_at: daysAgo(9) }), session({ rom_deg: 90 })],
    [],
    NOW,
  )
  check('基线不足时不给进步打分', partOf(thin, 'progress').value === 0.5, String(partOf(thin, 'progress').value))
  check('并且标出 hasBaseline=false', thin.stats.hasBaseline === false)
  check(
    '文案说明记录还不够',
    partOf(thin, 'progress').detail.includes('还不够'),
    partOf(thin, 'progress').detail,
  )

  // 刚好 3 次就该认账
  const exactly3 = buildInsight(
    [
      session({ rom_deg: 45, started_at: daysAgo(9) }),
      session({ rom_deg: 45, started_at: daysAgo(11) }),
      session({ rom_deg: 45, started_at: daysAgo(13) }),
      session({ rom_deg: 90 }),
    ],
    [],
    NOW,
  )
  check('基线满 3 次就算够用', exactly3.stats.hasBaseline === true)
}

// ============================================================================
console.log('\n--- 稳定性 ---')
// ============================================================================
{
  const steady = buildInsight(
    [1, 2, 3, 4].map((n) => session({ rom_deg: 90, started_at: daysAgo(n) })),
    [],
    NOW,
  )
  check('每次一样 → 稳定性满分', steady.parts.find((p) => p.key === 'stability')!.value === 1, String(steady.parts.find((p) => p.key === 'stability')!.value))

  // 波动很大：45, 90, 45, 90 —— 均值 0.75，CV 约 0.33，会打到 0
  const jumpy = buildInsight(
    [45, 90, 45, 90].map((r, i) => session({ rom_deg: r, started_at: daysAgo(i) })),
    [],
    NOW,
  )
  const jumpyValue = jumpy.parts.find((p) => p.key === 'stability')!.value
  check('忽大忽小 → 稳定性接近 0', jumpyValue < 0.15, String(jumpyValue))
  check(
    '不稳定时给出可操作的建议',
    jumpy.parts.find((p) => p.key === 'stability')!.detail.includes('放慢'),
    jumpy.parts.find((p) => p.key === 'stability')!.detail,
  )

  const single = buildInsight([session()], [], NOW)
  check('只有一次记录时稳定性取中性值', single.parts.find((p) => p.key === 'stability')!.value === 0.5)
}

// ============================================================================
console.log('\n--- 依从性 ---')
// ============================================================================
{
  const five = buildInsight(
    [0, 1, 2, 3, 4].map((n) => session({ started_at: daysAgo(n) })),
    [],
    NOW,
  )
  check('一周练 5 天 → 依从性满分', five.parts.find((p) => p.key === 'adherence')!.value === 1, String(five.parts.find((p) => p.key === 'adherence')!.value))
  check('训练天数统计为 5', five.stats.weekDays === 5, String(five.stats.weekDays))

  const two = buildInsight([session({ started_at: daysAgo(0) }), session({ started_at: daysAgo(1) })], [], NOW)
  check('一周练 2 天 → 0.4', Math.abs(two.parts.find((p) => p.key === 'adherence')!.value - 0.4) < 1e-9, String(two.parts.find((p) => p.key === 'adherence')!.value))
}

// ============================================================================
console.log('\n--- 训练天数按本地日期算 ---')
// ============================================================================
{
  // 同一天的两个不同时刻，必须只算一天。
  // 这一条在 UTC+8 上是能区分实现的：本地 07:00 属于前一个 UTC 日、
  // 本地 08:00 属于当前 UTC 日 —— 按 UTC 分组会数成 2 天。
  // 在 UTC 机器上两种实现都对，测试不会误报。
  const sameDay = buildInsight(
    [session({ started_at: daysAgo(0, 7) }), session({ started_at: daysAgo(0, 8) })],
    [],
    NOW,
  )
  check('同一天的两个时刻只算一天', sameDay.stats.weekDays === 1, String(sameDay.stats.weekDays))

  // 用本地日期方法独立算一遍，和实现里的算法互为对照
  const sets = [daysAgo(0, 7), daysAgo(1, 3), daysAgo(1, 22), daysAgo(3)]
  const expected = new Set(
    sets.map((iso) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    }),
  ).size
  const got = buildInsight(sets.map((s) => session({ started_at: s })), [], NOW).stats.weekDays
  check(`多天混合：期望 ${expected} 天`, got === expected, `得到 ${got}`)
}

// ============================================================================
console.log('\n--- 时间窗口的边界 ---')
// ============================================================================
{
  // 第 7 天（daysAgo(6)）应当在窗口内，第 8 天不在
  const inn = buildInsight(
    [session({ started_at: daysAgo(0) }), session({ started_at: daysAgo(6) })],
    [],
    NOW,
  )
  check('第 7 天的记录算本周', inn.stats.weekSessions === 2, String(inn.stats.weekSessions))

  const out = buildInsight(
    [session({ started_at: daysAgo(0) }), session({ started_at: daysAgo(20) })],
    [],
    NOW,
  )
  check('20 天前的记录不算本周', out.stats.weekSessions === 1, String(out.stats.weekSessions))

  // 明显荒谬的时间戳（两天后）要挡住
  const future = buildInsight([session({ started_at: daysAgo(-2) })], [], NOW)
  check('两天后的记录不计入', future.stats.weekSessions === 0, String(future.stats.weekSessions))

  // 但**当天稍晚**的记录必须算进来。
  // 设备时钟比浏览器快几小时是常事，用"此刻"当上界的话，
  // 一条今天 23:00 的记录会被判成未来，今天的训练就从家属眼前消失了
  const laterToday = buildInsight([session({ started_at: daysAgo(0, 23) })], [], NOW)
  check(
    '今天稍晚（时钟偏快）的记录仍算今天',
    laterToday.stats.weekSessions === 1,
    String(laterToday.stats.weekSessions),
  )
  check(
    '它也会出现在"今天的康复情况"卡片里',
    laterToday.cards[0]!.headline.includes('1 次'),
    laterToday.cards[0]!.headline,
  )
}

// ============================================================================
console.log('\n--- 安全事件必须扣分，而且必须说明 ---')
// ============================================================================
// 实测过旧版的行为：有严重温度预警的一周**仍然显示 85 分**，只是把颜色
// 变红了 —— 数字和颜色互相矛盾，而数字的说服力更强。这在医疗产品里
// 不能接受：一个真出过安全问题的一周，分数不该好看。
//
// 现在改成按最严重的等级下调，并把调整写进 adjustments，界面必须展示。
{
  const perfect = [0, 1, 2, 3, 4].map((n) =>
    session({ rom_deg: 90, started_at: daysAgo(n) }),
  )
  const clean = buildInsight(perfect, [], NOW)

  check('无安全事件时不产生调整说明', clean.adjustments.length === 0, clean.adjustments.join('; '))
  check('无调整时 rawScore 与 score 相同', clean.rawScore === clean.score, `${clean.rawScore} vs ${clean.score}`)
  check('全达标且无预警 → 高分', clean.score! >= 80, String(clean.score))
  expectBand('全达标且无预警 → 绿灯', clean, 'green')

  const warned = buildInsight(perfect, [alert({ severity: 'warning' })], NOW)
  check('一般预警会下调分数', warned.score! < clean.score!, `${clean.score} → ${warned.score}`)
  check(
    '下调比例按配置走（×0.85）',
    warned.score === Math.round(clean.score! * 0.85),
    `${warned.score}，期望 ${Math.round(clean.score! * 0.85)}`,
  )
  check(
    '保留调整前的分数，界面才能说"原多少分"',
    warned.rawScore === clean.rawScore,
    String(warned.rawScore),
  )
  check(
    '调整被写进 adjustments 且说的是人话',
    warned.adjustments.length === 1 && warned.adjustments[0]!.includes('安全提醒'),
    warned.adjustments.join('; ') || '(空)',
  )
  expectBand('一般预警 → 黄灯', warned, 'yellow')

  const critical = buildInsight(perfect, [alert({ severity: 'critical' })], NOW)
  check('严重预警下调更多', critical.score! < warned.score!, `${warned.score} → ${critical.score}`)
  check('严重事件后分数落到 60 以下', critical.score! < 60, String(critical.score))
  check(
    '说明里点出是严重安全事件',
    critical.adjustments.some((a) => a.includes('严重安全事件')),
    critical.adjustments.join('; '),
  )
  expectBand('严重预警 → 红灯', critical, 'red')

  // 按**最严重的**那一条算，不累加 —— 3 次一般提醒不等于比 1 次严重 3 倍
  const many = buildInsight(
    perfect,
    [alert({ severity: 'warning' }), alert({ severity: 'warning' }), alert({ severity: 'warning' })],
    NOW,
  )
  check('多条同级预警不累加', many.score === warned.score, `${many.score} vs ${warned.score}`)
  check('但次数要写在说明里', many.adjustments[0]!.includes('3 次'), many.adjustments[0]!)

  // 一周前的预警不该影响本周
  const oldAlert = buildInsight(
    perfect,
    [alert({ severity: 'critical', occurred_at: daysAgo(30) })],
    NOW,
  )
  check('一个月前的预警不影响本周', oldAlert.adjustments.length === 0, oldAlert.adjustments.join('; '))
  expectBand('一个月前的预警不影响本周', oldAlert, 'green')

  // 预警文案要说人话，不是 kind 的英文
  const card = critical.cards.find((c) => c.key === 'risk')!
  check('风险卡片翻译成家属语言', card.headline.includes('皮肤温度偏高'), card.headline)
  check('并给出该怎么做', card.detail.includes('热敷'), card.detail)
  check('未处理的预警会标出来', card.detail.includes('尚未处理'), card.detail)
}

// ============================================================================
console.log('\n--- 数据不足时分数要向中间值收敛 ---')
// ============================================================================
// 没有这一层的话，"本周只练了 1 次"也能算出一个看起来很确切的分数。
// 实测过：1 次做满 85 分、1 次不达标 30 分 —— **1 个样本给出了 55 分的
// 区分度**，那不是在描述患者，是在描述随机性。
{
  const one = buildInsight([session({ rom_deg: 90 })], [], NOW)
  check(
    '1 次记录会产生调整说明',
    one.adjustments.some((a) => a.includes('数据偏少')),
    one.adjustments.join('; '),
  )

  const five = buildInsight(
    [0, 1, 2, 3, 4].map((n) => session({ rom_deg: 90, started_at: daysAgo(n) })),
    [],
    NOW,
  )
  check(
    '5 次记录不再收缩',
    !five.adjustments.some((a) => a.includes('数据偏少')),
    five.adjustments.join('; ') || '(无调整)',
  )

  // 收缩要显著缩小"1 个样本"的区分度
  const oneBad = buildInsight([session({ rom_deg: 27 })], [], NOW)
  const spread = one.score! - oneBad.score!
  check(
    '1 个样本的区分度被压到 30 分以内',
    spread < 30,
    `做满 ${one.score} vs 三成 ${oneBad.score}，差 ${spread} 分`,
  )

  check(
    'rawScore 保留未收缩的值',
    one.rawScore !== one.score,
    `raw ${one.rawScore} → ${one.score}`,
  )
}

// ============================================================================
console.log('\n--- 分数与风险色现在是一致的 ---')
// ============================================================================
// 这两者曾经是分开的：分数只反映恢复情况，风险单独用颜色表达。
// 但实测截图发现那会产生"92 分被涂成橙色"这种自相矛盾的画面 ——
// 数字和颜色说的不是一回事，而家属只会记住数字。
//
// 现在安全事件直接扣分，两个轴合并成一个：**分数已经把安全算进去了**。
// 颜色仍从分数推出，所以两者必然一致。这条断言就是钉住这一点 ——
// 哪天有人把安全惩罚拿掉，这里会立刻变红。
{
  const perfect = [0, 1, 2, 3, 4].map((n) =>
    session({ rom_deg: 90, started_at: daysAgo(n) }),
  )

  const cases: [string, Alert[], RiskBand][] = [
    ['无预警', [], 'green'],
    ['一般预警', [alert({ severity: 'warning' })], 'yellow'],
    ['严重预警', [alert({ severity: 'critical' })], 'red'],
  ]

  for (const [label, alerts, want] of cases) {
    const ins = buildInsight(perfect, alerts, NOW)
    check(
      `${label}：评分色与风险色一致（${ins.score} 分）`,
      ins.scoreBand === ins.band,
      `${ins.scoreBand} / ${ins.band}`,
    )
    expectBand(`${label}：等级符合预期`, ins, want)
  }

  // 分数低但没预警 → 也要报红
  const poor = buildInsight([session({ rom_deg: 9, started_at: daysAgo(0) })], [], NOW)
  check('分数低于 60 → 报红', poor.scoreBand === 'red', `${poor.score} / ${poor.scoreBand}`)

  // 没有分数时不该出现警告色 —— "还没开始"不是"需要注意"
  const empty = buildInsight([], [], NOW)
  check('没有分数时不为红', empty.scoreBand !== 'red', empty.scoreBand)
}

console.log('\n--- 预警要说明处理状态 ---')
// ============================================================================
// 原先只在有未处理项时才写"（尚未处理）"，导致已处理的预警看起来
// 和没处理的一模一样，家属不知道该不该再做什么。
{
  const pending = buildInsight(
    [session()],
    [alert({ severity: 'warning', acknowledged_at: null })],
    NOW,
  )
  check(
    '未处理时标出来',
    pending.cards[1]!.detail.includes('尚未处理'),
    pending.cards[1]!.detail,
  )

  const done = buildInsight(
    [session()],
    [alert({ severity: 'warning', acknowledged_at: daysAgo(0) })],
    NOW,
  )
  check(
    '已处理时也要说出来',
    done.cards[1]!.detail.includes('已处理'),
    done.cards[1]!.detail,
  )
}

// ============================================================================
console.log('\n--- 分数低也要报红 ---')
// ============================================================================
{
  // 一次都不达标、只练了一天
  const poor = buildInsight(
    [session({ rom_deg: 9, started_at: daysAgo(0) })],
    [],
    NOW,
  )
  check('完成度极低 → 分数低', poor.score! < 60, String(poor.score))
  expectBand('分数低于 60 → 红灯', poor, 'red')
}

// ============================================================================
console.log('\n--- 一句话解释要具体 ---')
// ============================================================================
{
  const baseline = [9, 11, 13].map((n) => session({ rom_deg: 45, started_at: daysAgo(n) }))
  const improved = buildInsight([...baseline, session({ rom_deg: 54 })], [], NOW)
  check(
    '有明确进步时把幅度说出来',
    /\d+%/.test(improved.headline),
    improved.headline,
  )

  const noHistory = buildInsight([session({ rom_deg: 90 })], [], NOW)
  check('没有基线时给的是达标率', noHistory.headline.includes('康复目标'), noHistory.headline)
}

// ============================================================================
console.log('\n--- 三张卡片 ---')
// ============================================================================
{
  const ins = buildInsight(
    [session({ rep_count: 10, started_at: daysAgo(0) })],
    [],
    NOW,
  )
  check('卡片顺序是 今天/风险/建议', ins.cards.map((c) => c.key).join(',') === 'today,risk,advice', ins.cards.map((c) => c.key).join(','))
  check('今天卡片报出次数与组数', ins.cards[0]!.headline.includes('1 次') && ins.cards[0]!.headline.includes('10 组'), ins.cards[0]!.headline)

  // 动作识别对不上 → 标准度下降
  const unmatched = buildInsight(
    [session({ recognized: '直腿抬高', started_at: daysAgo(0) }), session({ recognized: '屈膝滑动', started_at: daysAgo(0) })],
    [],
    NOW,
  )
  check(
    '动作标准度按识别结果算',
    unmatched.cards[0]!.detail.includes('50%'),
    unmatched.cards[0]!.detail,
  )

  // 没有 recognized 时不硬编一个标准度
  const noRec = buildInsight([session({ recognized: null })], [], NOW)
  check(
    '没有识别结果时不编标准度',
    !noRec.cards[0]!.detail.includes('标准度'),
    noRec.cards[0]!.detail,
  )
}

// ============================================================================
console.log('\n--- 建议随最弱项变化 ---')
// ============================================================================
{
  // 依从性最弱：只练 1 天
  const lazy = buildInsight([session({ rom_deg: 90, started_at: daysAgo(0) })], [], NOW)
  check(
    '训练天数不足时建议补频次',
    lazy.cards[2]!.headline.includes('训练'),
    lazy.cards[2]!.headline,
  )

  // 有未处理的严重预警时，建议必须先说预警
  const urgent = buildInsight(
    [session({ rom_deg: 90, started_at: daysAgo(0) })],
    [alert({ severity: 'critical', kind: 'device_offline' })],
    NOW,
  )
  check(
    '有严重预警时建议优先谈预警',
    urgent.cards[2]!.headline.includes('预警'),
    urgent.cards[2]!.headline,
  )
  expectBand('建议卡片也是红的', urgent.cards[2]!, 'red')
}

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
process.exit(passed === results.length ? 0 : 1)
