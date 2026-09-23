// 打一次**真实的** AI 分析，把结果过一遍闸门，报告有没有被误杀。
// 直接跑：node scripts/try-ai.ts            （概览页的上下文）
//        node scripts/try-ai.ts analysis   （数据分析页的上下文）
//
// ============================================================================
// 【这个脚本不在 npm run check 里，是故意的】
// ============================================================================
// 它**要联网、要花真钱**，而且结果不确定 —— 而 `npm run check` 是每次提交都
// 跑、还卡着部署的闸门。把这两件事混在一起，结果就是要么闸门变得不可靠，
// 要么每次提交都花几毛钱。
//
// ============================================================================
// 【那它解决什么问题】
// ============================================================================
// `check-ai.ts` 里的对抗样本**全是手写的**，而手写样本证明不了真实分布 ——
// 模型实际会怎么组织句子、会不会老实报 cites、会不会引用范围外的数字，
// 只能拿真的回复来看。
//
// ⚠️ **改完提示词或 temperature，一定要跑一次这个。** 尤其是提示词：
//    如果模型开始不报 cites，每一条结论都会被拒，而 `check-ai.ts`
//    全绿 —— 那里喂的是我自己造的合规回复。
//
// 用法上它同时是「真实语料采集器」：输出的 JSON 可以贴进 check-ai.ts
// 当固定用例（那才是"改了之后有没有变差"的基线）。
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs'

import { buildInsightContext, buildTrendContext } from '../src/lib/aiContext.ts'
import { parseAiReply, allowedNumbers } from '../src/lib/aiReply.ts'
import { buildInsight } from '../src/lib/insight.ts'
import { buildTrendReport } from '../src/lib/trend.ts'
import { summarize } from '../src/lib/analysis.ts'
import { buildDemoAlerts, buildDemoSessions } from '../src/lib/demoData.ts'

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------
// 读的是 .env.local —— 那两个值是**发布用的公开值**（已经打包进线上 JS 了），
// 所以在这里读出来不算泄密。**不要**往这个文件里加任何密钥。

function env(): { url: string; key: string } {
  const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  const get = (name: string): string => {
    const m = raw.match(new RegExp(`^${name}=(.*)$`, 'm'))
    return m ? m[1]!.trim() : ''
  }
  const url = get('VITE_SUPABASE_URL')
  const key = get('VITE_SUPABASE_ANON_KEY')
  if (!url || !key) {
    console.error('✗ .env.local 里缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
    process.exit(1)
  }
  return { url, key }
}

const { url, key } = env()
const FUNCTION_NAME = 'ai-analysis'

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

const NOW = new Date()
const page = process.argv[2] === 'analysis' ? 'analysis' : 'dashboard'

const ctx =
  page === 'analysis'
    ? (() => {
        const rows = buildDemoSessions(NOW)
        const report = buildTrendReport(rows, { days: 30, now: NOW })
        return buildTrendContext(report, {
          window: report.windowLabel,
          demo: true,
          summary: summarize(rows),
        })
      })()
    : buildInsightContext(
        buildInsight(buildDemoSessions(NOW), buildDemoAlerts(NOW), NOW),
        { window: '本周', demo: true },
      )

console.log(`页面：${page}    窗口：${ctx.window}`)
console.log(`上下文：${JSON.stringify(ctx).length} 字符，${ctx.facts.length} 条事实`)
console.log(`允许集：${allowedNumbers(ctx).size} 个数字`)
console.log()

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

console.log('① 取访客 token（和浏览器里访客模式走同一条路）…')
const signup = await fetch(`${url}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: { role: 'patient' }, gotrue_meta_security: {} }),
})
const session = (await signup.json()) as { access_token?: string }
if (!session.access_token) {
  console.error('✗ 没拿到 token：', JSON.stringify(session).slice(0, 300))
  process.exit(1)
}
console.log('  ✓ 拿到')

console.log(`② 调 ${FUNCTION_NAME}…`)
const t0 = Date.now()
const resp = await fetch(`${url}/functions/v1/${FUNCTION_NAME}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    apikey: key,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ context: ctx }),
})
const elapsed = Date.now() - t0
const body = (await resp.json()) as Record<string, unknown>

console.log(`  耗时 ${elapsed} ms，HTTP ${resp.status}`)

if (!resp.ok || typeof body.text !== 'string') {
  console.error('✗ 函数返回了错误：')
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log(`  模型 ${body.model}｜finishReason ${body.finishReason}`)
const usage = body.usage as Record<string, unknown> | null
if (usage) console.log(`  usage ${JSON.stringify(usage)}`)
console.log()

// ---------------------------------------------------------------------------
// 过闸门
// ---------------------------------------------------------------------------

console.log('③ 过闸门')
const r = parseAiReply(body.text, ctx)

console.log(`  丢掉 ${r.dropped} 条${r.reason ? `｜整篇失败：${r.reason}` : ''}`)
// ★ 逐条打原因。只给一个数字的话，「模型变差了」和「闸门写严了」分不出来，
//   而这两件事的修法完全相反
for (const why of r.droppedReasons) console.log(`    ✗ ${why}`)
console.log()

if (!r.analysis) {
  console.error('✗ 一条都没通过。模型这次返回的原文：')
  console.error(String(body.text).slice(0, 2000))
  console.error()
  console.error('  常见原因：')
  console.error('   · 没照提示词报 cites → 每条都缺引用（检查 prompt 里那两条）')
  console.error('   · 报了不存在的编号 → 事实清单没传进函数？')
  console.error('   · 引用了范围外的数字 → cites 报少了，或提示词该收紧')
  process.exit(1)
}

if (r.analysis.summary) console.log(`摘要：${r.analysis.summary}`)
console.log()
for (const p of r.analysis.points) {
  console.log(`[${p.band}] ${p.text}`)
  console.log(`     依据（${p.cites.join(',')}）：${p.basis}`)
  console.log(`     动作：${p.action}`)
}
if (r.analysis.caveat) console.log(`\n局限：${r.analysis.caveat}`)

console.log()
if (r.dropped === 0) {
  console.log('✓ 零误杀。')
} else {
  console.log(`⚠️ 有 ${r.dropped} 条没过 —— 看上面那些"未通过校验"的日志找原因。`)
}

// ---------------------------------------------------------------------------
// 存成 fixture（--save <名字>）
// ---------------------------------------------------------------------------
// 存的是**上下文 + 回复原文**两份，所以回放时不需要联网、也不受运行日期影响
// —— 演示数据是按当天生成的，只存回复的话，第二天回放用的就是另一份上下文，
// 数字全对不上，用例会莫名其妙地红。
//
// 存下来的东西进了仓库，就成了 check-ai.ts 里那一组的基线：
// **以后再收紧闸门，把手写用例放过去、却把真实回复拒掉，那里会红。**

const saveIdx = process.argv.indexOf('--save')
if (saveIdx >= 0) {
  const name = process.argv[saveIdx + 1] ?? `${page}-${Date.now()}`
  const file = new URL(`./fixtures/ai-replies/${name}.json`, import.meta.url)
  writeFileSync(
    file,
    JSON.stringify(
      {
        name,
        note: `${new Date().toISOString().slice(0, 10)} 打的真实调用（${page}）`,
        context: ctx,
        text: body.text,
        meta: {
          model: body.model,
          elapsedMs: elapsed,
          usage: body.usage,
          droppedOnCapture: r.dropped,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`已存 fixture：scripts/fixtures/ai-replies/${name}.json`)
  console.log('  它现在会进 npm run check 的「真实回复回放」那一组。')
}
