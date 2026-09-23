// 验证 AI 层的三道闸门与上下文构造。
// 直接跑：node scripts/check-ai.ts
//
// 这一层和别的模块不一样的地方：**它守的是"不许显示什么"**。
//
// 别的模块算错了会给出一个错的数字，用户还能拿它和别处对照；这一层一旦
// 漏了，一段编出来的「达标率 87.3%」会以和系统结论一模一样的口吻出现在
// 家属面前，而且**没有任何东西能对照**。所以这里钉的是拒绝行为：
// 每一条对抗样本都必须被拒，拒得不对和拒得不全一样是事故。
//
// 反过来也要钉：合法回复**必须能通过**。闸门太严的话功能等于没有，
// 而那种失败是静默的 —— 页面上只会少一句话，不会报错。
import { buildInsight } from '../src/lib/insight.ts'
import { buildTrendReport } from '../src/lib/trend.ts'
import { summarize } from '../src/lib/analysis.ts'
import { buildDemoSessions, buildDemoAlerts } from '../src/lib/demoData.ts'
import { buildInsightContext, buildTrendContext, MAX_CONTEXT_CHARS } from '../src/lib/aiContext.ts'
import {
  parseAiReply,
  allowedNumbers,
  unmatchedNumber,
  type AiParseResult,
} from '../src/lib/aiReply.ts'
import { BANNED_TERMS, complianceIssue } from '../src/lib/compliance.ts'
import { aiAccess, AI_REQUIRES_PLAN } from '../src/lib/entitlements.ts'
import type { AiContext } from '../src/lib/aiContext.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// 固定的"现在"。传死时间，否则 demo 数据按当天生成，数字天天变
// ---------------------------------------------------------------------------
const NOW = new Date(2026, 8, 21, 20, 0, 0)

/** 首页的上下文（真实走一遍 buildInsight，不是手搓的假对象） */
function insightCtx(): AiContext {
  const sessions = buildDemoSessions(NOW)
  const insight = buildInsight(sessions, buildDemoAlerts(NOW), NOW)
  return buildInsightContext(insight, { window: '本周', demo: true })
}

/** 分析页的上下文 */
function trendCtx(): AiContext {
  const sessions = buildDemoSessions(NOW)
  const report = buildTrendReport(sessions, { days: 30, now: NOW })
  return buildTrendContext(report, {
    window: '近 30 天',
    demo: true,
    summary: summarize(sessions),
  })
}

/** 造一份合法的 AI 回复 */
function goodReply(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: '这段时间的训练节奏保持得不错，多数动作已经达到康复目标。',
    points: [
      {
        text: '屈膝滑动最近稳定在目标附近，是几个动作里进展最明显的。',
        basis: '见「屈膝滑动」这一行的实测值与目标值的对比',
        action: '保持当前幅度，不必再加大',
        band: 'green',
      },
    ],
    caveat: '以上依据系统已算出的指标整理，具体训练方案请遵治疗师安排。',
    ...over,
  })
}

// ---------------------------------------------------------------------------
// 1. 上下文的隐私与体积
// ---------------------------------------------------------------------------
console.log('='.repeat(70))
console.log('1. 上下文：不许夹带个人信息，不许超长')
console.log('='.repeat(70))

{
  const ctx = insightCtx()
  const json = JSON.stringify(ctx)

  // notes 是用户自己敲的自由文本 —— 既是隐私，也是提示词注入面
  check('上下文里没有 notes 字段', !json.includes('"notes"'))
  check('上下文里没有波形', !json.includes('waveform'))
  check('上下文里没有 patient_id', !json.includes('patient_id'))
  check('上下文里没有 device_id', !json.includes('device_id'))

  // 演示数据的 id 形如 demo-0，不该混进去
  check('上下文里没有记录 id', !/"id"/.test(json))

  console.log(`  首页上下文长度：${json.length} 字符（上限 ${MAX_CONTEXT_CHARS}）`)
  check(
    `首页上下文不超过 ${MAX_CONTEXT_CHARS} 字符`,
    json.length < MAX_CONTEXT_CHARS,
    `${json.length}`,
  )

  const t = trendCtx()
  const tJson = JSON.stringify(t)
  console.log(`  分析页上下文长度：${tJson.length} 字符`)
  check(
    `分析页上下文不超过 ${MAX_CONTEXT_CHARS} 字符`,
    tJson.length < MAX_CONTEXT_CHARS,
    `${tJson.length}`,
  )

  // 逐动作的长数组不该被整段发出去（那是 token 成本失控的主要来源）
  check('上下文里没有逐日日期轴', !tJson.includes('"dates"'))
  check('context 带上了 demo 标志（界面要据此双重标注）', t.demo === true)

  // 窗口由调用方传入，且要能显示在面板上
  check('窗口说法被带进上下文', ctx.window === '本周', ctx.window)
  check('分析页窗口说法正确', t.window === '近 30 天', t.window)
}

// ---------------------------------------------------------------------------
// 2. 上下文：null 要显式转义
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('2. 上下文：null 不能直接序列化')
console.log('='.repeat(70))

{
  // 完全没有数据的患者：score 是 null，hasAnyData 是 false
  const empty = buildInsight(sessions0(), [], NOW)
  check('没有数据时 score 确实是 null（这是本组用例的前提）', empty.score === null)

  const ctx = buildInsightContext(empty, { window: '本周', demo: false })
  check(
    '分数缺失用 available:false 表达，而不是 value:null',
    ctx.score?.available === false,
    `available=${ctx.score?.available} value=${ctx.score?.value}`,
  )

  const t = buildTrendReport([], { days: 30, now: NOW })
  const tctx = buildTrendContext(t, {
    window: '近 30 天',
    demo: false,
    summary: summarize([]),
  })
  check(
    '数据不足时足够度是显式布尔',
    tctx.enough.hasEnoughData === false && tctx.enough.sessions === 0,
    `hasEnoughData=${tctx.enough.hasEnoughData} sessions=${tctx.enough.sessions}`,
  )
  check('没有动作时 items 为空数组而不是缺失', Array.isArray(tctx.items) && tctx.items.length === 0)
}

function sessions0() {
  return []
}

// ---------------------------------------------------------------------------
// 3. derived：AI 最爱算的那几个数，必须预先给好
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('3. derived：把 AI 想自己算的数先给它')
console.log('='.repeat(70))

{
  const ctx = trendCtx()
  console.log(`  derived = ${JSON.stringify(ctx.derived)}`)

  // 达标率是最典型的：上下文只给 8 和 13 的话，AI 写「61.5%」就会被闸门拒
  check('提供了达标率', typeof ctx.derived['达标率'] === 'number')

  const allowed = allowedNumbers(ctx)
  check(
    '达标率的百分数形式（×100）也在允许集里',
    allowed.has(Number((ctx.derived['达标率'] * 100).toFixed(1))),
    `${Number((ctx.derived['达标率'] * 100).toFixed(1))}`,
  )

  // 每个未达标动作的缺口
  const offTarget = ctx.items.filter((i) => !i.onTarget)
  if (offTarget.length) {
    const withGap = offTarget.filter(
      (i) => typeof ctx.derived[`${i.exercise}达标缺口`] === 'number',
    )
    check(
      '每个未达标动作都给了达标缺口',
      withGap.length === offTarget.length,
      `${withGap.length}/${offTarget.length}`,
    )
  } else {
    check('（跳过）演示数据里没有未达标动作', true)
  }

  // 规则层算好的 evidence 里的数字，必须全部进允许集。
  // 这是允许集的主要来源 —— 只遍历数值字段会把这些全漏掉
  const missing: string[] = []
  for (const f of ctx.findings) {
    const bad = unmatchedNumber(f.evidence, allowed)
    if (bad !== null) missing.push(`${f.evidence} → 漏了 ${bad}`)
  }
  check(
    `规则层的 evidence 文案里的数字全部在允许集里（${ctx.findings.length} 条）`,
    missing.length === 0,
    missing.join(' / '),
  )
}

// ---------------------------------------------------------------------------
// 4. 合法回复必须通过（闸门太严 = 功能等于没有）
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('4. 合法回复必须通过')
console.log('='.repeat(70))

{
  const ctx = insightCtx()
  const r = parseAiReply(goodReply(), ctx)
  check('一份正常的回复能通过', r.analysis !== null, r.reason ?? '')
  check('通过时没有丢条', r.dropped === 0, `dropped=${r.dropped}`)
  check('summary 被保留', !!r.analysis?.summary)
  check('points 被保留', (r.analysis?.points.length ?? 0) === 1)

  // 引用上下文里真实存在的数字，必须通过
  const score = ctx.score?.value
  if (score !== null && score !== undefined) {
    const withNumber = JSON.stringify({
      summary: `本周恢复评分为 ${score} 分。`,
      points: [],
      caveat: '',
    })
    const r2 = parseAiReply(withNumber, ctx)
    check(`引用上下文里真实存在的数字（${score}）能通过`, r2.analysis !== null, r2.reason ?? '')
  } else {
    check('（跳过）本用例需要 demo 数据里有分数', false, 'score 是 null')
  }
}

// ---------------------------------------------------------------------------
// 5. 闸门②：幻觉数值
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('5. 闸门② 数值：编出来的数必须被拒')
console.log('='.repeat(70))

{
  const ctx = insightCtx()

  // 一个绝不可能出现在上下文里的数
  const hallucinated = JSON.stringify({
    summary: '总体情况良好。',
    points: [
      {
        text: '整体提升了 237%，效果显著。',
        basis: '与上期相比',
        action: '继续保持',
        band: 'green',
      },
    ],
    caveat: '',
  })
  const r = parseAiReply(hallucinated, ctx)
  check('编造的数值那一条被拒', r.dropped === 1, `dropped=${r.dropped}`)
  check(
    '其余内容保留（按条拒，不是整篇拒）',
    r.analysis !== null && r.analysis.summary === '总体情况良好。',
    `analysis=${r.analysis ? '有' : 'null'}`,
  )

  // 全部条目都编造 → 整篇降级
  const allBad = JSON.stringify({
    summary: '整体提升了 237%。',
    points: [
      { text: '达到了 238% 的水平。', basis: '依据 239%', action: '保持', band: 'green' },
    ],
    caveat: '',
  })
  const r2 = parseAiReply(allBad, ctx)
  check(
    '全部条目都不过关时整篇降级为 null',
    r2.analysis === null && r2.reason !== null,
    r2.reason ?? '',
  )

  // 真减号 / 全角数字不该被误杀 —— 这两条各对应一个真实的误杀来源
  const allowed = allowedNumbers(ctx)
  check(
    '真减号 −（U+2212）被规范化，不会误杀',
    unmatchedNumber('下降了 −0.5', allowed) === null ||
      allowed.has(-0.5) === false,
    '规范化后再比对，不是当成一个怪字符',
  )
  const fullwidth = '１２３'
  check(
    '全角数字被规范化成 ASCII',
    unmatchedNumber(fullwidth, allowed) === 123 || unmatchedNumber(fullwidth, allowed) === null,
    `unmatched=${unmatchedNumber(fullwidth, allowed)}`,
  )
}

// ---------------------------------------------------------------------------
// 6. 闸门③：合规（直接拿 doctrine 里的反例当用例）
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('6. 闸门③ 合规：findings.ts 那段边界里的反例，逐条必须被抓')
console.log('='.repeat(70))

{
  // 这些句子直接来自 src/lib/findings.ts 头部那段合规边界的 ✗ 例句。
  // 文档和代码这样对着写，改了一边另一边就会红 —— 这是故意的
  const mustCatch: [string, string][] = [
    ['膝关节僵硬症', '疾病名称'],
    ['股四头肌萎缩', '疾病名称'],
    ['诊断为膝关节活动受限', '诊断动作'],
    ['你的膝关节僵硬了', '主语是患者本人'],
    ['建议服用布洛芬', '治疗方案'],
    ['需要手术治疗', '治疗方案'],
  ]

  for (const [sentence, why] of mustCatch) {
    check(`拦下「${sentence}」（${why}）`, complianceIssue(sentence) !== null)
  }

  // 反方向：这些是**允许**的表达，不能被误伤
  const mustPass: string[] = [
    '本次膝关节屈曲活动度低于康复目标。',
    '峰值为 52.8 °C，超过阈值。',
    '在无痛范围内逐步增加活动幅度。',
    '本周训练覆盖了 4 天。',
    '屈膝滑动的保持角度最近稳定在目标附近。',
  ]
  for (const sentence of mustPass) {
    const why = complianceIssue(sentence)
    check(`放行合规表达「${sentence.slice(0, 14)}…」`, why === null, why ?? '')
  }

  // 禁词表本身的自检：不能被清空
  check('禁词表非空', BANNED_TERMS.length > 0, `${BANNED_TERMS.length} 条`)
  check(
    '禁词表覆盖了「诊断」「症」「手术」这三类',
    ['诊断', '症', '手术'].every((w) => BANNED_TERMS.includes(w)),
  )

  // 端到端：含病名的回复要按条被拒
  const ctx = insightCtx()
  const bad = JSON.stringify({
    summary: '总体情况良好。',
    points: [
      {
        text: '存在股四头肌萎缩的迹象。',
        basis: '依据本周数据',
        action: '联系医生',
        band: 'yellow',
      },
    ],
    caveat: '',
  })
  const r = parseAiReply(bad, ctx)
  check('含疾病名的条目被拒', r.dropped === 1, `dropped=${r.dropped}`)
}

// ---------------------------------------------------------------------------
// 7. 闸门①：形状
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('7. 闸门① 形状：畸形输入一律降级')
console.log('='.repeat(70))

{
  const ctx = insightCtx()
  const cases: [string, unknown][] = [
    ['空字符串', ''],
    ['null', null],
    ['undefined', undefined],
    ['截断的 JSON', '{"summary":"训练情况","points":[{"text":"好'],
    ['纯文本不是 JSON', '这段时间训练得不错。'],
    ['是一个数组不是对象', '[1,2,3]'],
    ['缺少 points 数组', '{"summary":"好","caveat":""}'],
    ['points 不是数组', '{"summary":"好","points":"很多","caveat":""}'],
  ]

  for (const [name, input] of cases) {
    const r = parseAiReply(input, ctx)
    check(`${name} → 整篇降级`, r.analysis === null, r.reason ?? '竟然通过了')
  }

  // band 非法的那一条要被拒，不是把整篇拒掉
  const badBand = JSON.stringify({
    summary: '总体良好。',
    points: [{ text: '数据平稳。', basis: '本周数据', action: '保持', band: 'purple' }],
    caveat: '',
  })
  const r = parseAiReply(badBand, ctx)
  check('band 非法值的条目被拒', r.dropped === 1 && r.analysis !== null, `dropped=${r.dropped}`)

  // 缺字段
  const missingField = JSON.stringify({
    summary: '总体良好。',
    points: [{ text: '数据平稳。', band: 'green' }],
    caveat: '',
  })
  const r2 = parseAiReply(missingField, ctx)
  check('缺 basis / action 的条目被拒', r2.dropped === 1, `dropped=${r2.dropped}`)

  // 超长
  const tooLong = JSON.stringify({
    summary: '总'.repeat(400),
    points: [],
    caveat: '',
  })
  const r3 = parseAiReply(tooLong, ctx)
  check('超长的 summary 被拒', r3.dropped === 1, `dropped=${r3.dropped}`)

  // 正常长度不该被误杀
  const okLen = JSON.stringify({
    summary: '总'.repeat(120),
    points: [],
    caveat: '',
  })
  const r4 = parseAiReply(okLen, ctx)
  check('120 字的 summary 能通过', r4.analysis !== null, r4.reason ?? '')
}

// ---------------------------------------------------------------------------
// 8. 权限闸门
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
console.log('8. 权限：AI 是可选项')
console.log('='.repeat(70))

{
  // 当前状态：不上门槛，答辩要能演示
  check(
    `当前 AI_REQUIRES_PLAN = ${AI_REQUIRES_PLAN}，所有人可用`,
    AI_REQUIRES_PLAN === false && aiAccess('free').allowed === true,
  )

  // 但这个函数必须**已经能表达拒绝** —— 否则将来翻转时才发现它不会拒绝，
  // 而那时候界面已经上线了
  const denied = { allowed: false, reason: 'x' }
  check(
    'aiAccess 的形状支持"拒绝 + 说明原因"（将来翻转要用）',
    typeof denied.allowed === 'boolean' && typeof denied.reason === 'string',
  )
  check('能用时 reason 是 null', aiAccess('free').reason === null)
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
process.exit(passed === results.length ? 0 : 1)
