// 验证康复评估的指标计算与入库数据是否合理。
// 直接跑：node scripts/check-assessment.ts
//
// 重点验两类东西：
//   1. 数学上必须成立的（置信度和为 1、ROM ≥ 0、轮次数与输入一致）
//   2. 会写进数据库的（波形体积、数组等长、数值范围）—— 这类出问题
//      不会在界面上报错，而是保存时才失败或存进脏数据
import {
  REHAB_EXERCISES,
  generateSession,
  metricFor,
  metricLabel,
  targetFor,
  type SessionResult,
} from '../src/lib/assessment.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

const summarize = (r: SessionResult) =>
  `判定「${r.recognized}」 ${(r.topConfidence * 100).toFixed(1)}% · ` +
  `ROM ${r.romMax.toFixed(1)}° · RMS ${r.rmsAvg.toFixed(3)} mV · ` +
  `${r.reps.length} 轮 · 波形 ${r.waveform.t_ms.length} 点`

// ---------------------------------------------------------------- 四类动作
console.log('='.repeat(70))
console.log('1. 四类动作各自生成一次')
console.log('='.repeat(70))

const sessions: SessionResult[] = []
for (const exercise of REHAB_EXERCISES) {
  const r = generateSession(exercise, 8)
  sessions.push(r)
  console.log(`  ${exercise}：${summarize(r)}`)
}

check('四类动作都能生成结果', sessions.length === 4 && sessions.every((s) => s.reps.length > 0))
check('模型判定的动作与所选动作一致（模拟数据应自洽）',
  sessions.every((s) => s.recognized === s.performed))

// ---------------------------------------------------------------- 置信度
console.log()
console.log('='.repeat(70))
console.log('2. 置信度（softmax 结构）')
console.log('='.repeat(70))

for (const s of sessions) {
  const sum = Object.values(s.confidence).reduce((a, b) => a + b, 0)
  const entries = Object.entries(s.confidence).sort((a, b) => b[1] - a[1])
  console.log(`  ${s.performed}：` + entries.map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join('  '))
}

check('四类置信度之和为 1',
  sessions.every((s) => Math.abs(Object.values(s.confidence).reduce((a, b) => a + b, 0) - 1) < 1e-9))
check('置信度均为正数',
  sessions.every((s) => Object.values(s.confidence).every((v) => v > 0)))
check('判定动作的置信度在 0.88–0.96 之间',
  sessions.every((s) => s.topConfidence >= 0.88 && s.topConfidence <= 0.96),
  sessions.map((s) => s.topConfidence.toFixed(3)).join(', '))
check('置信度分布随机（两次生成不完全相同）',
  JSON.stringify(generateSession('直腿抬高', 8).confidence) !==
  JSON.stringify(generateSession('直腿抬高', 8).confidence))

// ---------------------------------------------------------------- 指标
console.log()
console.log('='.repeat(70))
console.log('3. 生理指标范围')
console.log('='.repeat(70))

check('ROM 为正且不超过膝关节生理上限',
  sessions.every((s) => s.romMax > 0 && s.romMax <= 100),
  sessions.map((s) => s.romMax.toFixed(1)).join(', '))

// ---- 分动作档位：不同动作的活动度必须真的不同 ----
const romByExercise = sessions.map((s) => Math.round(s.romMax))
check('四个动作的 ROM 各不相同（不再是一个恒定值）',
  new Set(romByExercise).size === 4, romByExercise.join(', '))
// 注意不能拿"靠墙静蹲 vs 其余动作最小值"来比 —— 直腿抬高同样是小 ROM
// 动作（膝关节保持伸直），两个小 ROM 动作之间比不出大小。
// 换成绝对判断：静力动作的 ROM 本就应该很小。
check('静力动作（靠墙静蹲）ROM 很小（静力维持，非关节屈伸）',
  sessions[3].romMax < 15, `${sessions[3].romMax.toFixed(1)}°`)
check('直腿抬高的 ROM 很小（膝关节本就保持伸直）',
  sessions[0].romMax < 20, `${sessions[0].romMax.toFixed(1)}°`)
check('坐位伸膝与屈膝滑动是全幅度屈伸',
  sessions[1].romMax > 60 && sessions[2].romMax > 60,
  `${sessions[1].romMax.toFixed(1)}° / ${sessions[2].romMax.toFixed(1)}°`)

// ---- 会话间波动：同一个动作多跑几次，ROM 不应完全相同 ----
const repeats = Array.from({ length: 8 }, () => generateSession('坐位伸膝', 6).romMax)
const spread = Math.max(...repeats) - Math.min(...repeats)
check('同一动作多次评估的 ROM 有波动（对比图才有意义）',
  spread > 1, `${Math.min(...repeats).toFixed(1)}° ~ ${Math.max(...repeats).toFixed(1)}°（跨度 ${spread.toFixed(1)}°）`)

// ---- 达标判定按动作区分 ----
const targets = REHAB_EXERCISES.map((e) => targetFor(e))
check('各动作的目标值各不相同', new Set(targets).size === 4, targets.join(', '))
check('判定结果里的 target / metric 与查表值一致',
  sessions.every(
    (s, i) =>
      s.target === targetFor(REHAB_EXERCISES[i]) &&
      s.metric === metricFor(REHAB_EXERCISES[i]),
  ))

// ---- 核心：判定指标类型必须与动作匹配 ----
check('动态屈伸类动作按「关节活动度」判定',
  sessions.slice(0, 3).every((s) => s.metric === 'rom'))
check('静力动作按「保持角度」判定',
  sessions[3].metric === 'hold',
  `靠墙静蹲 metric = ${sessions[3].metric}`)
check('metricValue 与 metric 对应正确',
  sessions.every((s) =>
    s.metric === 'rom' ? s.metricValue === s.romMax : s.metricValue === s.holdAngle,
  ))
check('静力动作的保持角度远大于其活动范围（两者确实不是同一个量）',
  sessions[3].holdAngle > sessions[3].romMax * 3,
  `保持 ${sessions[3].holdAngle.toFixed(1)}° vs 活动范围 ${sessions[3].romMax.toFixed(1)}°`)
check('metricLabel 返回正确的中文名',
  metricLabel('rom') === '关节活动度' && metricLabel('hold') === '保持角度')
check('每轮 ROM 均 ≥ 0', sessions.every((s) => s.reps.every((r) => r.rom >= 0)))
check('每轮 RMS 为正',
  sessions.every((s) => s.reps.every((r) => r.rms > 0)),
  `全局平均 ${(sessions.reduce((a, s) => a + s.rmsAvg, 0) / 4).toFixed(3)} mV`)
check('温度区间在生理范围（32–37 °C）',
  sessions.every((s) => s.tempMin > 32 && s.tempMax < 37),
  `${sessions[0].tempMin.toFixed(2)} ~ ${sessions[0].tempMax.toFixed(2)} °C`)
check('角度最小值不超过最大值',
  sessions.every((s) => s.reps.every((r) => r.angleMin <= r.angleMax)))

// ---------------------------------------------------------------- 轮次切分
console.log()
console.log('='.repeat(70))
console.log('4. 轮次切分')
console.log('='.repeat(70))

for (const n of [1, 4, 8, 15, 30]) {
  const r = generateSession('直腿抬高', n)
  console.log(`  要求 ${String(n).padStart(2)} 次 → 实际切出 ${r.reps.length} 轮`)
}

check('轮次数与输入一致（含边界值 1 和 30）',
  [1, 4, 8, 15, 30].every((n) => generateSession('直腿抬高', n).reps.length === n))
check('轮次序号从 1 连续递增',
  generateSession('直腿抬高', 8).reps.every((r, i) => r.index === i + 1))

// ---------------------------------------------------------------- 入库数据
console.log()
console.log('='.repeat(70))
console.log('5. 写入 rehab_sessions 的数据')
console.log('='.repeat(70))

const sample = sessions[0]
const wf = sample.waveform
const jsonSize = JSON.stringify(wf).length

console.log(`  波形点数：${wf.t_ms.length}`)
console.log(`  JSON 体积：${(jsonSize / 1024).toFixed(1)} KB`)

check('三个数组长度一致（列式存储的下标必须对齐）',
  wf.t_ms.length === wf.r_ohm.length && wf.t_ms.length === wf.temp_c!.length,
  `${wf.t_ms.length} / ${wf.r_ohm.length} / ${wf.temp_c!.length}`)
check('波形点数在建议上限（1000）以内', wf.t_ms.length <= 1000, `${wf.t_ms.length} 点`)
check('波形 JSON 体积远小于 256 KB 的参考上限', jsonSize < 256 * 1024,
  `${(jsonSize / 1024).toFixed(1)} KB`)
check('时间轴严格递增',
  wf.t_ms.every((t, i) => i === 0 || t > wf.t_ms[i - 1]))
check('电阻值均为正数', wf.r_ohm.every((v) => v > 0),
  `${Math.min(...wf.r_ohm).toFixed(1)} ~ ${Math.max(...wf.r_ohm).toFixed(1)} Ω`)
check('温度值与 samples 中的一致',
  Math.abs(Math.max(...wf.temp_c!) - sample.tempMax) < 0.01)
check('confidence 在 [0,1] 区间（数据库有 check 约束）',
  sample.topConfidence >= 0 && sample.topConfidence <= 1)
check('rom_deg 保留两位小数后仍是有限数',
  Number.isFinite(Number(sample.romMax.toFixed(2))),
  `${Number(sample.romMax.toFixed(2))}°`)

// ---------------------------------------------------------------- 建议
console.log()
console.log('='.repeat(70))
console.log('6. 评估建议')
console.log('='.repeat(70))

for (const a of sample.advice) {
  console.log(`  [${a.level}] ${a.title}`)
  console.log(`        ${a.detail}`)
}

check('生成了建议条目', sample.advice.length >= 3, `${sample.advice.length} 条`)
check('建议包含动作规范性与活动度两类',
  sample.advice.some((a) => a.title.includes('动作')) &&
  sample.advice.some((a) => a.title.includes('活动度')))
check('每条建议都有标题和正文',
  sample.advice.every((a) => a.title.length > 0 && a.detail.length > 0))
// 达标结论必须与该动作自己的目标一致，而不是某个全局值
check('达标结论与「该动作的」目标一致',
  sample.metricValue >= sample.target
    ? sample.advice.some((a) => a.title.includes('达到目标'))
    : sample.advice.some((a) => a.title.includes('未达目标')),
  `本次 ${sample.metricValue.toFixed(1)}° vs 目标 ${sample.target}°`)

// 静力动作必须用「保持角度」判定，文案里也要出现这个词
const wallSit = generateSession('靠墙静蹲', 4)
const holdAdvice = wallSit.advice.find((a) => a.title.includes('保持角度'))
check('静力动作的判定文案用的是「保持角度」而非「关节活动度」',
  Boolean(holdAdvice), holdAdvice?.title ?? '(未生成)')
check('静力动作的判定不会拿活动范围去比目标值（那样会误报未达标）',
  wallSit.advice.every((a) => !a.title.includes('关节活动度')),
  `靠墙静蹲：保持 ${wallSit.holdAngle.toFixed(1)}° / 目标 ${wallSit.target}°，活动范围仅 ${wallSit.romMax.toFixed(1)}°`)

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
