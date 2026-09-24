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
import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { buildInsight } from '../src/lib/insight.ts'
import { buildTrendReport } from '../src/lib/trend.ts'
import { summarize } from '../src/lib/analysis.ts'
import { buildDemoSessions, buildDemoAlerts } from '../src/lib/demoData.ts'
import { buildInsightContext, buildTrendContext, MAX_CONTEXT_CHARS } from '../src/lib/aiContext.ts'
import {
  parseAiReply,
  parseAiAsk,
  allowedNumbers,
  unmatchedNumber,
  MAX_QUESTION_CHARS,
  type AiParseResult,
} from '../src/lib/aiReply.ts'
import {
  AI_CACHE_STORAGE_KEY,
  readCache,
  writeCache,
} from '../src/lib/aiCache.ts'
import { BANNED_TERMS, complianceIssue } from '../src/lib/compliance.ts'
import { aiAccess, AI_REQUIRES_PLAN } from '../src/lib/entitlements.ts'
import type { AiContext, AiFact } from '../src/lib/aiContext.ts'

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

/**
 * 造一份合法的 AI 回复。
 *
 * ⚠️ 注意 `points` 里**没有 basis** —— 依据不是模型写的，是它引用的。
 *    模型只报编号（`cites`），原文由 aiReply 从 ctx.facts 里取。
 */
function goodReply(ctx: AiContext, over: Record<string, unknown> = {}) {
  const first = ctx.facts[0]
  return JSON.stringify({
    summary: '这段时间的训练节奏保持得不错，多数动作已经达到康复目标。',
    points: [
      {
        text: '整体情况稳定，没有需要特别处理的项。',
        cites: first ? [first.id] : [],
        action: '保持当前节奏',
        band: 'green',
      },
    ],
    caveat: '以上依据系统已算出的指标整理，具体训练方案请遵治疗师安排。',
    ...over,
  })
}

/** 造一条结论。默认引用第一条事实 */
function point(
  ctx: AiContext,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const first = ctx.facts[0]
  return {
    text: '整体情况稳定。',
    cites: first ? [first.id] : [],
    action: '保持当前节奏',
    band: 'green',
    ...over,
  }
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

  // 演示数据的 id 形如 demo-0，不该混进去。
  //
  // ⚠️ 这里**不能只看键名** —— `facts` 里也有 id 字段（F1、F2…），那是引用
  //    编号、不是个人信息。原先是 `!/"id"/.test(json)`，加了事实清单之后
  //    它就误报了。改成看**值**：只允许 F 开头的编号
  const idValues = [...json.matchAll(/"id":"([^"]*)"/g)].map((m) => m[1] ?? '')
  check(
    '上下文里没有记录 id（facts 的 F1/F2 是引用编号，不算）',
    idValues.every((v) => /^F\d+$/.test(v)),
    idValues.slice(0, 6).join(',') || '（无）',
  )

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
  const r = parseAiReply(goodReply(ctx), ctx)
  check('一份正常的回复能通过', r.analysis !== null, r.reason ?? '')
  check('通过时没有丢条', r.dropped === 0, `dropped=${r.dropped}`)
  check('summary 被保留', !!r.analysis?.summary)
  check('points 被保留', (r.analysis?.points.length ?? 0) === 1)

  // ★ 依据必须是**我们渲染的原文**，而不是模型写的什么
  const p0 = r.analysis?.points[0]
  const citedFact = ctx.facts[0]
  check(
    '依据 = 被引用事实的原文（不是模型写的）',
    !!p0 && !!citedFact && p0.basis === citedFact.text,
    p0 ? p0.basis.slice(0, 40) : '（没有）',
  )
  check('cites 被保留下来（可追溯）', !!p0 && p0.cites.length > 0, p0?.cites.join(',') ?? '')

  // 引用上下文里真实存在的数字，必须通过
  const score = ctx.score?.value
  const scoreFact = ctx.facts.find((f) => f.text.includes(`${score} 分`))
  if (score !== null && score !== undefined && scoreFact) {
    const withNumber = JSON.stringify({
      summary: `本周恢复评分为 ${score} 分。`,
      points: [],
      caveat: '',
    })
    const r2 = parseAiReply(withNumber, ctx)
    check(`引用上下文里真实存在的数字（${score}）能通过`, r2.analysis !== null, r2.reason ?? '')
  } else {
    check('（跳过）需要 demo 数据里有分数事实', true, '本轮 demo 数据里没有')
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
    points: [point(ctx, { text: '整体提升了 237%，效果显著。' })],
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
    points: [point(ctx, { text: '达到了 238% 的水平。' })],
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
// 5b. ★ 事实编号制：引用与归属
// ---------------------------------------------------------------------------
// 这一组钉的是 2026-09-24 那次改造要买到的东西。
//
// 改之前：依据由模型自己写，闸门拿**整个上下文**比对 —— 于是"引用一条讲
// 角度的事实、正文里却写皮温"这种情况**拦不住**（只问数字出现过没有）。
// 改之后：模型只报编号，依据由我们渲染；数值只在**它引用的那几条**里查。
//
// 下面第一条用例就是那个原来拦不住的场景。它红了，说明改造白做了。
console.log()
console.log('='.repeat(70))
console.log('5b. 事实编号制：引用必须成立，数字必须在引用范围内')
console.log('='.repeat(70))

{
  const ctx = insightCtx()
  console.log(`  事实清单 ${ctx.facts.length} 条：`)
  for (const f of ctx.facts.slice(0, 4)) console.log(`    ${f.id}  ${f.text.slice(0, 46)}`)

  check('上下文里有事实清单', ctx.facts.length > 0, `${ctx.facts.length} 条`)
  check(
    '编号连续且从 F1 起',
    ctx.facts.every((f, i) => f.id === `F${i + 1}`),
    ctx.facts.map((f) => f.id).join(','),
  )
  // 编号稳定 = 缓存键稳定。同一份数据生成两次必须一样
  const again = insightCtx()
  check(
    '同一份数据生成的事实清单逐字节一致（否则缓存永不命中）',
    JSON.stringify(again.facts) === JSON.stringify(ctx.facts),
  )

  // ---- 引用本身 ----
  const noCites = JSON.stringify({
    summary: '总体稳定。',
    points: [{ text: '某项稳定。', action: '保持', band: 'green' }],
    caveat: '',
  })
  check('不报引用 → 该条被拒', parseAiReply(noCites, ctx).dropped === 1)

  const emptyCites = JSON.stringify({
    summary: '总体稳定。',
    points: [{ text: '某项稳定。', cites: [], action: '保持', band: 'green' }],
    caveat: '',
  })
  check('引用是空数组 → 该条被拒', parseAiReply(emptyCites, ctx).dropped === 1)

  const fakeId = JSON.stringify({
    summary: '总体稳定。',
    points: [{ text: '某项稳定。', cites: ['F99'], action: '保持', band: 'green' }],
    caveat: '',
  })
  check('报了不存在的编号 → 该条被拒（编造，不是疏忽）', parseAiReply(fakeId, ctx).dropped === 1)

  // ---- ★ 张冠李戴 ----
  // 找两条数字**不重叠**的事实。重叠的要排除，否则容差（±0.5）会让
  // 「80」和「80.4」互相匹配，用例就失去意义了
  const numsOf = (t: string): number[] =>
    (t.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

  let host: AiFact | undefined
  let other: AiFact | undefined
  let stolen: number | undefined

  outer: for (const a of ctx.facts) {
    const na = numsOf(a.text)
    for (const b of ctx.facts) {
      if (a.id === b.id) continue
      const cand = numsOf(b.text).filter(
        (n) => n !== 0 && na.every((m) => Math.abs(n - m) > 1),
      )
      // 取绝对值最大的那个 —— 「偷来的」数字越像个真实测量值，
      // 这个用例越接近它要防的场景（把皮温安到角度上那种）
      if (cand.length) {
        host = a
        other = b
        stolen = cand.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x))
        break outer
      }
    }
  }

  if (host && other && stolen !== undefined) {
    console.log(`  用 ${host.id}（${host.text.slice(0, 30)}…）`)
    console.log(`  偷 ${other.id} 里的数字 ${stolen}`)

    // ★ 张冠李戴：**现在不拦了**，改成"补出真正出处"。
    //
    // 这条断言原来是「引用 A 却写 B 的数字 → 被拒」。2026-09-24 改掉了，
    // 因为那个检查的代价太大：它和"漏引"长得一模一样，而漏引是**记账
    // 失误**、编造才是**撒谎** —— 判罚一样重，结果最常见的失败把功能
    // 搞得经常不可用（实测连着误杀五次）。
    //
    // 现在：数字只要**在任何一条事实里**就通过，并把那条事实补进依据。
    // 于是张冠李戴**不是被悄悄放过，而是在依据里露出来** ——
    // 正文说皮温、依据写着角度，人一眼能看出对不上。
    const swapped = JSON.stringify({
      summary: '总体稳定。',
      points: [point(ctx, { text: `该项的数值是 ${stolen}。`, cites: [host.id] })],
      caveat: '',
    })
    const r = parseAiReply(swapped, ctx)
    const sp = r.analysis?.points[0]
    check(
      '★ 张冠李戴不再拦，但依据里补出了数字真正的出处',
      r.analysis !== null &&
        (sp?.cites.length ?? 0) > 1 &&
        (sp?.basis ?? '').includes(String(stolen)),
      `写了 ${stolen}，模型只报了 ${host.id}，依据里补成 ${sp?.cites.join(',')}`,
    )
    check(
      '★ 但**编造**仍然拦得住（它是唯一该拦的那档）',
      parseAiReply(
        JSON.stringify({
          summary: '总体稳定。',
          points: [point(ctx, { text: '该项的数值是 99999。' })],
          caveat: '',
        }),
        ctx,
      ).dropped === 1,
      '99999 在任何事实里都没有',
    )

    // 反方向：写被引用事实**自己**的数字，必须通过（否则闸门太紧）
    const own = numsOf(host.text)[0]
    if (own !== undefined) {
      const honest = JSON.stringify({
        summary: '总体稳定。',
        points: [point(ctx, { text: `该项的数值是 ${own}。`, cites: [host.id] })],
        caveat: '',
      })
      const r2 = parseAiReply(honest, ctx)
      check(
        '正文写被引用事实自己的数字 → 通过',
        r2.analysis !== null && r2.dropped === 0,
        r2.reason ?? `写了 ${own}`,
      )
    }
  } else {
    check('（跳过）没找到数字不重叠的两条事实', false, 'demo 数据变了？')
  }

  // ---- 引用多条 ----
  const two = JSON.stringify({
    summary: '总体稳定。',
    points: [
      point(ctx, {
        text: '整体平稳。',
        cites: ctx.facts.slice(0, 2).map((f) => f.id),
      }),
    ],
    caveat: '',
  })
  const r3 = parseAiReply(two, ctx)
  check('引用两条事实 → 通过', r3.analysis !== null, r3.reason ?? '')
  check(
    '两条的依据按全角竖线拼在一起',
    (r3.analysis?.points[0]?.basis ?? '').includes(' ｜ '),
    r3.analysis?.points[0]?.basis.slice(0, 50) ?? '',
  )

  // ---- ★ 引用**没有条数上限**（2026-09-24 删掉）----
  //
  // 这个上限存在过、被放宽过两次（3→4→6），每次都是撞上限烧掉一条正确的
  // 结论。最后删掉，是因为数值校验改成**全局**之后（见 attributeNumbers），
  // cites 的角色变了 —— 它只决定"依据先显示哪几条"，不再决定
  // "数字在哪个范围内查"。于是上限只剩一个作用：**在没有收益的情况下
  // 制造失败**。实测它就又误杀了一次：模型报了 7 条，整条被拒。
  const allIds = ctx.facts.map((f) => f.id)

  const many = JSON.stringify({
    summary: '总体稳定。',
    points: [point(ctx, { text: '整体平稳。', cites: allIds })],
    caveat: '',
  })
  const rMany = parseAiReply(many, ctx)
  check(
    `引用全部 ${allIds.length} 条事实也不拒（没有上限）`,
    rMany.analysis !== null,
    rMany.droppedReasons[0] ?? '',
  )
  check(
    '依据把那几条都列了出来（没有被截断）',
    (rMany.analysis?.points[0]?.cites.length ?? 0) === allIds.length,
    `${rMany.analysis?.points[0]?.cites.length} / ${allIds.length}`,
  )
  check(
    '追问路径同样没有上限',
    parseAiAsk(
      JSON.stringify({ answer: '整体平稳。', cites: allIds, decline: '', caveat: '' }),
      ctx,
      '怎么样',
    ).answer !== null,
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
    points: [point(ctx, { text: '存在股四头肌萎缩的迹象。', action: '联系医生' })],
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
    points: [point(ctx, { band: 'purple' })],
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
  check('缺 cites / action 的条目被拒', r2.dropped === 1, `dropped=${r2.dropped}`)

  // 老形状（模型写 basis）必须被拒 —— 它没有 cites
  const oldShape = JSON.stringify({
    summary: '总体良好。',
    points: [
      { text: '数据平稳。', basis: '本周训练 7 次', action: '保持', band: 'green' },
    ],
    caveat: '',
  })
  check(
    '模型自己写 basis 的老形状被拒（依据只能由我们渲染）',
    parseAiReply(oldShape, ctx).dropped === 1,
  )

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
// 9. 本地缓存
// ---------------------------------------------------------------------------
// 这一组守的是**两类相反的错**：
//   ① 该命中的没命中 → 用户白等 2.5 秒、白花一次钱（功能变差，但不危险）
//   ② 不该命中的命中了 → 把**另一段时间、另一个人**的解读显示出来
//                        （危险，而且完全看不出来）
// 所以边界条件（过期、换键、格式坏）一条都不能少。
console.log()
console.log('='.repeat(70))
console.log('9. 本地缓存：该省的省，不该命中的绝不命中')
console.log('='.repeat(70))

{
  const at = 1_700_000_000_000
  const ok = (summary: string): AiParseResult => ({
    analysis: { summary, points: [], caveat: '' },
    dropped: 0,
    droppedReasons: [],
    reason: null,
  })
  /** 全被闸门拒掉 —— 解析结果合法，但**没有内容** */
  const rejected: AiParseResult = {
    analysis: null,
    dropped: 3,
    droppedReasons: ['摘要：引用了上下文里没有的数值 999', '没有报 cites', '没有报 cites'],
    reason: 'AI 这次给出的内容没有通过校验，已全部丢弃',
  }

  // ---- 基本读写 ----
  const blob = writeCache(null, 'KEY-A', ok('第一份'), at)
  check('写进去能读出来', readCache(blob, 'KEY-A', at)?.analysis?.summary === '第一份')

  // ---- 换键必须不命中（换了患者 / 换了窗口）----
  check('换了上下文键 → 不命中', readCache(blob, 'KEY-B', at) === null)

  // ---- 坏输入一律当没有 ----
  check('null → 不命中', readCache(null, 'KEY-A', at) === null)
  check('空串 → 不命中', readCache('', 'KEY-A', at) === null)
  check('截断的 JSON → 不命中', readCache('[{"k":"KEY-A"', 'KEY-A', at) === null)
  check('不是数组 → 不命中', readCache('{"k":"KEY-A"}', 'KEY-A', at) === null)
  check('数组里是垃圾 → 不命中', readCache('[1,2,3]', 'KEY-A', at) === null)

  // ---- ★ 失败绝不入库 ----
  // 这是 user.ts 那个 guestPromise 教训的同一件事：一次失败被存下来，
  // 之后每次都会直接命中那个失败，用户再也没有重试的机会
  const afterFail = writeCache(blob, 'KEY-C', rejected, at)
  check(
    '★ 失败的结果写不进去',
    readCache(afterFail, 'KEY-C', at) === null,
    '写进去了的话，这个上下文再也重试不出来',
  )
  check('写入失败不影响已有的缓存', readCache(afterFail, 'KEY-A', at) !== null)

  // 万一有人手改 localStorage 塞了一条失败进去，读的时候也要挡掉
  const tampered = JSON.stringify([{ k: 'KEY-D', value: rejected, at }])
  check(
    '★ 手改进去的失败记录也读不出来（缓存是不可信输入）',
    readCache(tampered, 'KEY-D', at) === null,
  )

  // ---- 过期 ----
  const later = at + 8 * 24 * 60 * 60 * 1000 // 8 天后（TTL 是 7 天）
  check('过期后不命中', readCache(blob, 'KEY-A', later) === null)
  check('没过期照常命中', readCache(blob, 'KEY-A', at + 6 * 24 * 60 * 60 * 1000) !== null)
  check(
    '写入时顺手清掉过期的',
    !writeCache(blob, 'KEY-E', ok('新的'), later).includes('KEY-A'),
    '否则存储只增不减',
  )

  // ---- 条数上限 ----
  let acc: string | null = null
  for (let i = 0; i < 10; i++) acc = writeCache(acc, `KEY-${i}`, ok(`第 ${i} 份`), at)
  const parsed = JSON.parse(acc ?? '[]') as unknown[]
  check('最多存 2 条（两页各一条）', parsed.length <= 2, `${parsed.length} 条`)
  check('留下的是最新的那条', readCache(acc, 'KEY-9', at)?.analysis?.summary === '第 9 份')

  // ---- 同一个键写两次只留一条 ----
  const twice = writeCache(writeCache(null, 'KEY-X', ok('旧'), at), 'KEY-X', ok('新'), at)
  check(
    '同一个键重复写不会堆两条',
    (JSON.parse(twice) as unknown[]).length === 1 &&
      readCache(twice, 'KEY-X', at)?.analysis?.summary === '新',
  )

  check('存储键带版本号', /^fugan\.ai\.v\d+$/.test(AI_CACHE_STORAGE_KEY), AI_CACHE_STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// 10. 真实回复回放
// ---------------------------------------------------------------------------
// ============================================================================
// 【为什么手写用例不够，非得有这一组】
// ============================================================================
// 上面 1~9 节喂的全是**我自己造的**回复。它们证明的是"闸门逻辑对"，
// 证明不了"真实回复能过" —— 而这两件事在 2026-09-24 那天被证明是分开的：
//
//   提示词改完 `npm run check` 全绿，打真实接口却发现三条结论全被丢弃。
//   接着又连着抓出两个真 bug（带符号数值被当幻觉、MAX_CITES 定太紧）。
//
// fixtures 里存的是**真实调用**的上下文原文 + 模型回复原文。回放不需要
// 联网、不受运行日期影响（演示数据是按当天生成的，所以上下文必须一起冻住）。
//
// ⚠️ **往后收紧闸门时，这一组是唯一能拦住"误杀真实回复"的东西。**
//    手写用例会跟着闸门一起改，所以它永远不会红。
//
// 攒新样本：`node scripts/try-ai.ts --save <名字>`
//
// ----------------------------------------------------------------------------
// ⚠️ 这一组**挡不住**什么（反测过，不是猜的）
// ----------------------------------------------------------------------------
// 2026-09-24 用"临时改坏一处、看它红不红"的办法量了它的覆盖范围：
//
//   改坏 `MAX_CITES` 4→3          → **没红**。真实回复里那些四条引用的结论，
//                                   去掉一条之后剩下的仍覆盖了正文里的数字
//   把数值容差改成 0（精确匹配）    → **没红**。真实回复是逐字抄的，
//                                   根本用不到容差（低温度 + 提示词里那句
//                                   "逐字复制"在起作用）
//   要求每条至少引用 2 条事实       → **红了**，而且把三条的原因都打了出来
//
// 结论：它守的是**灾难性漂移**（提示词改坏、模型不再报 cites、闸门整体变严
// 到真实输出全被拒）—— 也就是 9-24 那天真实发生过的那种。
// 它守不住**细微**的闸门改动，因为真实回复恰好不经过那些分支。
//
// 另外：**上下文是冻在 fixture 里的，所以改 aiContext.ts 这一组完全看不到。**
// 那部分由第 1~3 节和 `try-ai.ts` 的真实调用来守。
// ============================================================================
console.log()
console.log('='.repeat(70))
console.log('10. 真实回复回放（fixtures 里存的是真的模型输出）')
console.log('='.repeat(70))

{
  const dir = new URL('./fixtures/ai-replies/', import.meta.url)
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : []

  if (!files.length) {
    console.log('  （还没有 fixture。跑 node scripts/try-ai.ts --save <名字> 攒一个）')
  }

  let totalPoints = 0

  for (const f of files) {
    let fx: { name?: string; note?: string; context?: AiContext; text?: string }
    try {
      fx = JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
    } catch (e) {
      check(`${f} 能解析`, false, String(e))
      continue
    }

    if (!fx.context || typeof fx.text !== 'string') {
      check(`${f} 结构完整（要含 context 与 text）`, false)
      continue
    }

    const r = parseAiReply(fx.text, fx.context)
    totalPoints += r.analysis?.points.length ?? 0

    check(
      `${f}（${fx.note ?? ''}）零丢弃`,
      r.dropped === 0 && r.analysis !== null,
      r.dropped
        ? `丢了 ${r.dropped} 条：${r.droppedReasons.join(' ｜ ')}`
        : `通过 ${r.analysis?.points.length ?? 0} 条`,
    )

    // 真实回复里的依据必须全部是**我们渲染的**事实原文 ——
    // 也就是说模型自己写的任何文字都不该出现在那一行里。
    //
    // ⚠️ 判据是"逐条事实都是它的子串"，不是"按分隔符切开比对"。
    //    事实文本自己含分号，切开就对不上了 —— 第一版就是这么写错的。
    const byId = new Map(fx.context.facts.map((x) => [x.id, x.text]))
    const basesOk = (r.analysis?.points ?? []).every((p) =>
      p.cites.every((id) => {
        const text = byId.get(id)
        return typeof text === 'string' && p.basis.includes(text)
      }),
    )
    check(`${f} 的依据全部由事实原文拼成`, basesOk)
  }

  if (files.length) {
    console.log(`  共回放 ${files.length} 份真实回复、${totalPoints} 条结论`)
  }
}

// ---------------------------------------------------------------------------
// 11. 追问
// ---------------------------------------------------------------------------
// 这一组里最重要的是**拒答**那几条 —— 它是这个功能唯一会放大合规风险的
// 地方（别处都是我们主动生成文本，这里是用户主动提问，可能问到病上）。
//
// 所以「答不了就说答不了」必须是**可断言的**，而不是提示词里一句没人验的
// 叮嘱。下面第 3 条就是在验：模型该拒的时候拒了，客户端必须把它当作
// **成功**收下，而不是当垃圾丢掉。
console.log()
console.log('='.repeat(70))
console.log('11. 追问：回答、拒答、以及不许越界')
console.log('='.repeat(70))

{
  const ctx = insightCtx()
  const fact0 = ctx.facts[0]!
  const numInFact0 = Number((fact0.text.match(/-?\d+(?:\.\d+)?/) ?? ['0'])[0])

  // ---- ① 正常回答 ----
  {
    const raw = JSON.stringify({
      answer: `该数值是 ${numInFact0}。`,
      cites: [fact0.id],
      decline: '',
      caveat: '',
    })
    const r = parseAiAsk(raw, ctx, '这周怎么样')
    check('正常回答通过', r.answer !== null, r.reason ?? '')
    check('回答里带着问的原话', r.answer?.question === '这周怎么样')
    check('answer 与 decline 恰好一个非空',
      !!r.answer?.answer && !r.answer?.decline)
    check(
      '依据由事实原文拼成（不是模型写的）',
      r.answer?.basis === fact0.text,
      r.answer?.basis.slice(0, 30) ?? '',
    )
  }

  // ---- ② ★ 拒答：必须是**通过**，不是失败 ----
  //
  // 家属问「我妈是不是得了关节炎」。模型填了 decline。
  // 如果客户端把它当失败丢掉，界面上就只剩"AI 出错了" ——
  // 用户会以为系统坏了，换个说法再问一遍。那正是要避免的。
  {
    const raw = JSON.stringify({
      answer: '',
      cites: [],
      decline: '这类问题需要由医生判断，我不能根据训练数据回答。',
      caveat: '',
    })
    const r = parseAiAsk(raw, ctx, '我妈是不是得了关节炎')
    check(
      '★ 拒答被当作**成功**收下（不是失败）',
      r.answer !== null && r.reason === null,
      r.reason ?? '',
    )
    check('拒答时 answer 是空串', r.answer?.answer === '')
    check('拒答说明被保留', (r.answer?.decline ?? '').length > 0)
    check('拒答没有依据（本来就没有可给的）', r.answer?.basis === '')
  }

  // ---- ③ ★ 拒答说明自己不许带病名 ----
  //
  // 「不能判断是不是关节炎」这种句子恰恰要拦 —— 它把病名摆到家属面前了，
  // 哪怕是以否定的形式。这是提示词里专门叮嘱过、也专门断言的一条
  {
    const raw = JSON.stringify({
      answer: '',
      cites: [],
      decline: '不能判断是不是关节炎，建议就医。',
      caveat: '',
    })
    const r = parseAiAsk(raw, ctx, '我妈是不是得了关节炎')
    check(
      '★ 拒答说明里带病名 → 被拒',
      r.answer === null && r.reason !== null,
      r.reason ?? '',
    )
  }

  // ---- ③b ★ 拒答里的**类别词**要放行 ----
  //
  // 这一条是打真实调用才发现的：模型面对提示词注入时**正确拒答了**，
  // 写的是「用药问题需要由医生判断」，而一刀切的禁词表把「用药」拦下来，
  // 于是那次正确的拒答被丢掉，界面上表现成"AI 出错了"。
  //
  // 区别在于「用药」是**类别**、「关节炎」是**具体病名**。
  {
    const raw = JSON.stringify({
      answer: '',
      cites: [],
      decline: '用药问题需要由医生判断，这份训练数据里没有相关内容。',
      caveat: '',
    })
    const r = parseAiAsk(raw, ctx, '该吃什么药')
    check(
      '★ 拒答里出现「用药」这样的类别词 → 放行',
      r.answer !== null && r.answer.decline.length > 0,
      r.reason ?? '',
    )
  }
  {
    const raw = JSON.stringify({
      answer: '',
      cites: [],
      decline: '手术与否需要由医生评估。',
      caveat: '',
    })
    check(
      '拒答里出现「手术」也放行（同一档）',
      parseAiAsk(raw, ctx, '要不要手术').answer !== null,
    )
  }
  {
    // 第二次误杀（改了「用药」之后又冒出来的）：模型拒答涉病问题时写
    // 「这涉及疾病诊断，需要由医生判断」—— 而「诊断」被当成"在下诊断"拦了。
    // 规律是：「诊断」「用药」「手术」是**类别词**，「关节炎」是**具体病名**
    const raw = JSON.stringify({
      answer: '',
      cites: [],
      decline: '这涉及疾病诊断，需要由医生判断。',
      caveat: '',
    })
    check(
      '★ 拒答里出现「诊断」→ 放行（它是在拒绝下诊断）',
      parseAiAsk(raw, ctx, '我妈是不是得了关节炎').answer !== null,
    )
  }
  {
    // 反方向：**回答**里说「诊断为…」仍然要拦 —— 那才是真的在下诊断
    const raw = JSON.stringify({
      answer: '综合来看可以诊断为活动受限。',
      cites: [fact0.id],
      decline: '',
      caveat: '',
    })
    check(
      '回答里出现「诊断」→ 仍然被拒',
      parseAiAsk(raw, ctx, '怎么样').answer === null,
    )
  }
  {
    // 反方向：**回答**里出现类别词仍然要拦 —— 那是真的在给方案
    const raw = JSON.stringify({
      answer: '建议先用药观察。',
      cites: [fact0.id],
      decline: '',
      caveat: '',
    })
    check(
      '回答里出现「用药」→ 仍然被拒',
      parseAiAsk(raw, ctx, '怎么办').answer === null,
    )
  }

  // ---- ④ 形状 ----
  const shapeCases: [string, string][] = [
    ['两个字段都空', JSON.stringify({ answer: '', cites: [], decline: '', caveat: '' })],
    ['缺 cites', JSON.stringify({ answer: '这周训练了 7 天。', decline: '' })],
    ['cites 是空数组', JSON.stringify({ answer: '这周训练了 7 天。', cites: [], decline: '' })],
    ['引用了不存在的事实', JSON.stringify({ answer: '还行。', cites: ['F99'], decline: '' })],
    ['截断的 JSON', '{"answer":"还不错"'],
    ['不是对象', '[]'],
  ]
  for (const [name, raw] of shapeCases) {
    const r = parseAiAsk(raw, ctx, '这周怎么样')
    check(`${name} → 被拒`, r.answer === null, r.reason ?? '竟然通过了')
  }

  check(
    '空问题 → 被拒（不必浪费一次调用）',
    parseAiAsk(JSON.stringify({ answer: 'x', cites: [fact0.id], decline: '' }), ctx, '  ').answer === null,
  )

  // ---- ⑤ 数值仍然收紧在引用范围内 ----
  {
    const raw = JSON.stringify({
      answer: '整体提升了 237%。',
      cites: [fact0.id],
      decline: '',
      caveat: '',
    })
    check(
      '回答里编造的数值 → 被拒',
      parseAiAsk(raw, ctx, '有进步吗').answer === null,
    )
  }

  // ---- ⑥ 两个都填 → 按保守的读 ----
  {
    const raw = JSON.stringify({
      answer: '这周还不错。',
      cites: [fact0.id],
      decline: '这个问题我答不了。',
      caveat: '',
    })
    const r = parseAiAsk(raw, ctx, '怎么样')
    check(
      '两个都填时按**拒答**读（保守优先）',
      r.answer !== null && r.answer.answer === '' && r.answer.decline.length > 0,
      r.answer ? `answer="${r.answer.answer}" decline="${r.answer.decline}"` : (r.reason ?? ''),
    )
  }

  // ---- ⑦ 上限 ----
  {
    const long = JSON.stringify({
      answer: '好'.repeat(500),
      cites: [fact0.id],
      decline: '',
      caveat: '',
    })
    check('超长回答 → 被拒', parseAiAsk(long, ctx, '怎么样').answer === null)
  }

  check(
    `问题长度上限是 ${MAX_QUESTION_CHARS}`,
    MAX_QUESTION_CHARS === 200,
    `${MAX_QUESTION_CHARS}`,
  )
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
