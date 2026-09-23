// 验证评估结论的生成。
// 直接跑：node scripts/check-findings.ts
//
// 这一层有两个别的模块没有的风险：
//
//   1. **合规**。这个产品不是医疗器械，措辞不能越界成诊断。文案是随时会被
//      改的，靠人记住"不能写症、不能写诊断"迟早会忘 —— 用断言钉住。
//   2. **排序**。结论会按红黄绿排，顺序错了最该看的那条就被埋了。
//      排序逻辑看着简单，改一处权重就可能反过来，而且不会报错。
import { generateSession } from '../src/lib/assessment.ts'
import type { SessionResult } from '../src/lib/assessment.ts'
import { buildFindings, topFindings } from '../src/lib/findings.ts'
import type { Finding } from '../src/lib/findings.ts'
import { BANNED_TERMS } from '../src/lib/compliance.ts'
import { TEMP_ALERT_THRESHOLD } from '../src/lib/simulator.ts'
import type { RehabSession } from '../src/types/index.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

/** 造一条历史记录。字段够用即可，findings 只读 exercise 与 rom/hold */
function past(over: Partial<RehabSession> = {}): RehabSession {
  return {
    id: Math.random().toString(36).slice(2),
    patient_id: 'p1',
    device_id: null,
    joint: 'knee',
    exercise: '屈膝滑动',
    recognized: '屈膝滑动',
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_s: 32,
    rep_count: 8,
    rom_deg: 90,
    hold_deg: null,
    temp_c: 33,
    rms_mv: 0.4,
    confidence: 0.95,
    waveform: null,
    notes: null,
    created_at: new Date().toISOString(),
    ...over,
  } as RehabSession
}

/** 拿一次真实评估结果，按需覆盖字段 */
function session(over: Partial<SessionResult> = {}): SessionResult {
  return { ...generateSession('屈膝滑动', 8), ...over }
}

const keysOf = (fs: Finding[]) => fs.map((f) => f.key)
const find = (fs: Finding[], k: string) => fs.find((f) => f.key === k)

// ============================================================================
console.log('\n--- 合规：措辞不能越界成诊断 ---')
// ============================================================================
// 这一组是这个模块**最该守住**的东西。产品没有 NMPA 注册，
// 给疾病名称、说"诊断"、开治疗方案都越界了。
{
  // 覆盖尽量多的结论类型，一起过筛
  const all: Finding[] = [
    ...buildFindings(session()),
    ...buildFindings(session({ metricValue: 30 })),
    ...buildFindings(session({ tempMax: 50 })),
    ...buildFindings(session({ recognized: '直腿抬高' })),
    ...buildFindings(session({ topConfidence: 0.4 })),
    ...buildFindings(session(), [past(), past(), past({ rom_deg: 50 })]),
    ...buildFindings({ ...generateSession('靠墙静蹲', 4) }),
  ]

  // 疾病名 / 诊断动作 / 治疗方案，都不许出现。
  //
  // ⚠️ 这张表**从这里搬到了 src/lib/compliance.ts** —— 因为 AI 生成的那段
  //    文本也要过同一张表（见 src/lib/aiReply.ts 的合规闸门）。留两份的话
  //    必然各自漂移：哪天有人往这边加一个词，AI 那边不会跟着变，而两边
  //    拦的本来是同一件事。所以只留一处，两个执行点都 import 它。
  const hit = all.filter((f) =>
    BANNED_TERMS.some((w) => f.label.includes(w) || f.action.includes(w)),
  )
  check(
    `没有任何结论使用疾病名或诊断措辞（${all.length} 条过筛）`,
    hit.length === 0,
    hit.map((f) => f.label).join(' / '),
  )

  // 主语必须是"数据/训练"，不能对患者本人下判断
  const blamePatient = all.filter(
    (f) => f.label.startsWith('你') || f.label.includes('患者存在') || f.label.includes('病人'),
  )
  check(
    '结论的主语是数据/训练，不是患者本人',
    blamePatient.length === 0,
    blamePatient.map((f) => f.label).join(' / '),
  )

  // 每条都得有依据 —— 没有数值支撑的结论等于让人信我
  const noEvidence = all.filter((f) => !/\d/.test(f.evidence))
  check(
    '每条结论的依据里都有具体数值',
    noEvidence.length === 0,
    noEvidence.map((f) => `${f.key}: ${f.evidence}`).join(' / '),
  )
}

// ============================================================================
console.log('\n--- 达标判定按动作类型走 ---')
// ============================================================================
{
  const ok = buildFindings(session({ metricValue: 95, target: 90 }))
  check('达到目标 → 给出达标结论', keysOf(ok).includes('rom_ok'), keysOf(ok).join(','))
  check('达标是绿灯', find(ok, 'rom_ok')!.band === 'green')

  // 阈值是"差多少算严重"：完成度低于 70%（差三成）判红，否则黄。
  // 78/90 = 87% 落在黄档
  const short = buildFindings(session({ metricValue: 78, target: 90 }))
  check('未达目标 → 给出未达标结论', keysOf(short).includes('rom_short'))
  check(
    '差得不多算黄灯',
    find(short, 'rom_short')!.band === 'yellow',
    `完成 ${Math.round((78 / 90) * 100)}%`,
  )

  // 阈值边界：刚好 70% 是黄，69% 是红
  check(
    '完成 70% 仍是黄灯',
    find(buildFindings(session({ metricValue: 63, target: 90 })), 'rom_short')!.band === 'yellow',
  )
  check(
    '完成 69% 转为红灯',
    find(buildFindings(session({ metricValue: 62, target: 90 })), 'rom_short')!.band === 'red',
  )

  const wayShort = buildFindings(session({ metricValue: 20, target: 90 }))
  check(
    '差得很多算红灯（差 3° 和差 40° 不该是同一句话）',
    find(wayShort, 'rom_short')!.band === 'red',
    find(wayShort, 'rom_short')!.evidence,
  )

  // 静力动作：必须用「保持角度」的措辞，且不能拿活动范围去比
  const wall = generateSession('靠墙静蹲', 4)
  const wf = buildFindings(wall)
  const ws = find(wf, 'hold_ok') ?? find(wf, 'hold_short')
  check('静力动作走保持角度那条', Boolean(ws), keysOf(wf).join(','))
  check('措辞用的是「保持角度」', ws!.label.includes('保持角度'), ws!.label)
  check(
    '静力动作不会出现「关节活动度」的判定（那样会误报未达标）',
    !ws!.label.includes('关节活动度'),
    `实际：保持 ${wall.holdAngle.toFixed(1)}° / 目标 ${wall.target}°，活动范围仅 ${wall.romMax.toFixed(1)}°`,
  )
}

// ============================================================================
console.log('\n--- 排序：最该看的排最前 ---')
// ============================================================================
{
  // 一坨问题凑在一起：温度超标(红) + 识别不一致(黄) + 未达标(黄)
  const messy = buildFindings(
    session({ tempMax: TEMP_ALERT_THRESHOLD + 3, recognized: '直腿抬高', metricValue: 40 }),
  )
  check('温度超阈 → 红灯', find(messy, 'temp_high')!.band === 'red')
  check(
    '红灯排在所有黄灯之前',
    messy.findIndex((f) => f.band === 'red') < messy.findIndex((f) => f.band === 'yellow'),
    keysOf(messy).join(' > '),
  )
  check(
    '第一条就是最该先处理的（温度安全）',
    messy[0]!.key === 'temp_high',
    messy[0]!.key,
  )

  // 绿的在最后
  const good = buildFindings(session({ metricValue: 95 }))
  const firstGreen = good.findIndex((f) => f.band === 'green')
  const lastNonGreen = good.map((f) => f.band).lastIndexOf('yellow')
  check(
    '绿灯排在黄灯之后',
    lastNonGreen < 0 || firstGreen > lastNonGreen,
    keysOf(good).join(' > '),
  )
}

// ============================================================================
console.log('\n--- 限流：一次别给太多 ---')
// ============================================================================
{
  // 一次凑齐五类问题：温度 + 未达标 + 识别不一致 + 轮次不稳 + 较历史回落
  const base = generateSession('屈膝滑动', 8)
  const many = buildFindings(
    {
      ...base,
      tempMax: 50,
      recognized: '直腿抬高',
      metricValue: 30,
      // 幅度忽大忽小 → 触发"轮次不稳"
      reps: base.reps.map((r, i) => ({ ...r, rom: i % 2 ? 20 : 60 })),
    },
    [past({ rom_deg: 95 }), past({ rom_deg: 96 }), past({ rom_deg: 94 })],
  )
  check('这次确实产出了多条结论', many.length >= 5, `${many.length} 条：${keysOf(many).join(',')}`)
  check('默认只给 3 条', topFindings(many, 3).length === 3)
  check('给 1 条时只给 1 条', topFindings(many, 1).length === 1)
  check('取的是排在最前面的那几条', topFindings(many, 3)[0]!.key === many[0]!.key)
  check('总数不足时不会凑数', topFindings(many.slice(0, 2), 3).length === 2)
}

// ============================================================================
console.log('\n--- 与历史对比 ---')
// ============================================================================
{
  const none = buildFindings(session({ metricValue: 90 }), [])
  const progressKeys = keysOf(none).filter((k) => k.startsWith('progress'))
  check(
    '没有历史时不给"进步/退步"的结论',
    progressKeys.length === 0,
    progressKeys.join(',') || '(未生成)',
  )

  // 只有 2 条同动作记录 —— 不够，不能编结论
  const thin = buildFindings(session({ metricValue: 90 }), [past(), past({ rom_deg: 40 })])
  check(
    '同动作历史不足 3 条时也不给',
    keysOf(thin).filter((k) => k.startsWith('progress')).length === 0,
    keysOf(thin).join(','),
  )

  // 3 条基线、本次明显更高 → 进步
  const up = buildFindings(
    session({ metricValue: 95 }),
    [past({ rom_deg: 70 }), past({ rom_deg: 72 }), past({ rom_deg: 68 })],
  )
  check('明显高于历史 → 进步结论', keysOf(up).includes('progress_up'), keysOf(up).join(','))
  check('进步是绿灯', find(up, 'progress_up')!.band === 'green')

  // 明显更低 → 回落（注意措辞：不能写成"退步了"吓人）
  const down = buildFindings(
    session({ metricValue: 50 }),
    [past({ rom_deg: 80 }), past({ rom_deg: 82 }), past({ rom_deg: 78 })],
  )
  check('明显低于历史 → 回落结论', keysOf(down).includes('progress_down'), keysOf(down).join(','))
  check(
    '回落用"有所回落"而不是"退步了"',
    find(down, 'progress_down')!.label.includes('回落') &&
      !find(down, 'progress_down')!.label.includes('退步'),
    find(down, 'progress_down')!.label,
  )

  // **只比同动作** —— 直腿抬高的活动度只有 10° 上下、屈膝滑动接近 100°，
  // 跨动作平均出来的数不代表任何一个动作
  const cross = buildFindings(
    session({ performed: '屈膝滑动', metricValue: 90 }),
    [
      past({ exercise: '直腿抬高', rom_deg: 10 }),
      past({ exercise: '直腿抬高', rom_deg: 11 }),
      past({ exercise: '直腿抬高', rom_deg: 9 }),
    ],
  )
  check(
    '不同动作的历史不参与对比',
    !keysOf(cross).includes('progress_down'),
    keysOf(cross).join(','),
  )

  // 静力动作要比保持角度，不是比活动范围
  const wall = generateSession('靠墙静蹲', 4)
  const wallHist = [
    past({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 30 }),
    past({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 32 }),
    past({ exercise: '靠墙静蹲', rom_deg: 8, hold_deg: 31 }),
  ]
  const wf = buildFindings(wall, wallHist)
  check(
    '静力动作的历史对比用的是保持角度',
    keysOf(wf).includes('progress_up'),
    `本次保持 ${wall.holdAngle.toFixed(1)}°，历史保持 30–32°；` +
      `若拿活动范围（约 8°）去比会得出相反的结论`,
  )
}

// ============================================================================
console.log('\n--- 每条结论都是完整的 ---')
// ============================================================================
{
  const all = [
    ...buildFindings(session()),
    ...buildFindings(session({ tempMax: 50 })),
    ...buildFindings(session({ recognized: '直腿抬高' })),
    ...buildFindings(session(), [past(), past(), past()]),
  ]
  check('每条都有非空的结论', all.every((f) => f.label.trim().length > 0))
  check('每条都有非空的依据', all.every((f) => f.evidence.trim().length > 0))
  check('每条都有"该做什么"', all.every((f) => f.action.trim().length > 0))
  check(
    '每条的语气都是三档之一',
    all.every((f) => ['red', 'yellow', 'green'].includes(f.band)),
  )
  // 查重要按**单次调用**看 —— 上面那批是多次调用拼起来的，同 key 重复很正常
  const one = buildFindings(session({ tempMax: 50, recognized: '直腿抬高' }))
  check(
    '同一次评估里不会出现重复的结论',
    new Set(keysOf(one)).size === one.length,
    keysOf(one).join(','),
  )
}

// ============================================================================
console.log('\n--- 小于测量误差的变化，不能报成"进步" ---')
// ============================================================================
// 这个阈值原来是不假思索的 0.05。它**低于测量误差**：
// 膝关节活动度的最小可检测变化（MDC）大约 5°~10°，换算成相对值约
// 6%~11% —— 也就是说，小于 MDC 的变化**无法与测量误差区分**。
//
// 拿 5% 当门槛，等于把传感器的噪声和患者当天的状态起伏都报成"有进步"。
// 家属看到"较以往有进步"会真的以为好转了。
//
// 现在取 0.12（MDC 相对区间的上沿）。宁可不报，也不要报一个和噪声
// 分不开的"进步" —— 平台上出现的每一次"进步"都应该是可信的。
{
  const hist = (rom: number) => [
    past({ rom_deg: rom }),
    past({ rom_deg: rom }),
    past({ rom_deg: rom }),
  ]

  // +6.7%：落在 MDC 区间内，与噪声分不开，不该说进步
  const noise = buildFindings(session({ metricValue: 96 }), hist(90))
  check(
    '变化 6.7% 不报"进步"（低于测量误差）',
    !keysOf(noise).includes('progress_up'),
    keysOf(noise).join(',') || '(未生成进步结论)',
  )

  // +24%：远超 MDC，必须报出来，否则这项功能等于没有
  const real = buildFindings(session({ metricValue: 112 }), hist(90))
  check(
    '变化 24% 报"进步"',
    keysOf(real).includes('progress_up'),
    keysOf(real).join(',') || '(未生成进步结论)',
  )
  check(
    '措辞限定为"本次"，与首页那句周度进步区分开',
    find(real, 'progress_up')!.label.includes('本次'),
    find(real, 'progress_up')!.label,
  )

  // 反方向同理：小幅回落也不该报警，单次波动很正常
  const dip = buildFindings(session({ metricValue: 84 }), hist(90))
  check(
    '变化 -6.7% 不报"回落"',
    !keysOf(dip).includes('progress_down'),
    keysOf(dip).join(',') || '(未生成回落结论)',
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
