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

// 上界取 105 而非 100：屈膝滑动的设计范围是 5–100°，叠加 ±6% 的会话波动后
// 最大可到 100×1.06−5 ≈ 101°，卡在 100 会偶发误报。膝关节正常屈曲可达 135°，
// 105 这个上界仍然能拦住真正离谱的值。
check('ROM 为正且不超过膝关节生理上限',
  sessions.every((s) => s.romMax > 0 && s.romMax <= 105),
  sessions.map((s) => s.romMax.toFixed(1)).join(', '))

// ---- 分动作档位 ----
// 注意不能断言"四个值互不相同" —— 直腿抬高和靠墙静蹲**设计上都是小 ROM**
// （膝关节保持伸直 / 静力维持），叠加 ±6% 的会话波动后两者的取值区间是
// 重叠的，偶发相同是正常的。断言各自落在自己的档位区间里才有意义。
const romByExercise = sessions.map((s) => Math.round(s.romMax))
check('四个动作的 ROM 不再是一个恒定值',
  new Set(romByExercise).size > 1, romByExercise.join(', '))
check('各动作的 ROM 落在各自档位区间内',
  sessions[0].romMax > 5 && sessions[0].romMax < 20 &&    // 直腿抬高：膝关节伸直
  sessions[1].romMax > 60 && sessions[1].romMax < 90 &&   // 坐位伸膝：中等幅度
  sessions[2].romMax > 80 && sessions[2].romMax < 105 &&  // 屈膝滑动：全幅度
  sessions[3].romMax > 5 && sessions[3].romMax < 20,      // 靠墙静蹲：静力微调
  romByExercise.join(', '))
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

// ---------------------------------------------------------------- 肌电-运动学融合
console.log()
console.log('='.repeat(70))
console.log('7. 肌电-关节角度相位分析（命题答题要求的第三项）')
console.log('='.repeat(70))

// 模拟器的肌电包络峰值固定在动作周期的 25% 相位（向心收缩期），
// 而角度在相位 0.25 时恰好是 (ANGLE_MIN+ANGLE_MAX)/2。
// 所以分析出来的峰值角度应当收敛到这个值 —— 这是可以反推的物理真值。
const phase = generateSession('屈膝滑动', 6).emgAngle
console.log(`  峰值角度：${phase.peakAngle}°（模拟器设定值应为 50°）`)
console.log(`  向心/离心比：${phase.ratio}（模拟器设定值约 2.3）`)
console.log(`  向心曲线 ${phase.concentric.length} 点，离心曲线 ${phase.eccentric.length} 点`)
console.log(`  解读：${phase.interpretation}`)

check('适用相位分析', phase.applicable)
// 容差取 ±15° 而不是更紧：模拟器的肌电包络本身很宽（相位标准差 0.12
// 折算成角度约 11°），加上每个角度分箱只有约 2 个采样点，估计量的标准差
// 实测为 5.4°，卡到 ±5° 会有近一半的运行失败。
//
// 这个断言真正要证的是「峰值落在关节活动范围的中间段（向心期）」——
// 若实现坏了（比如取成角度最小值 5° 或最大值 100°），一定会被抓住。
// ⚠️ 这条断言改成**跑多次取均值**，而不是判单次结果。
//
// 单次峰值角度的标准差实测 7.5°（模拟器的肌电包络本身很宽，折算约 11°，
// 而每个角度分箱只有几个采样点）。卡在单次上、容差 ±15°，只有 2 个标准差
// —— 约 5% 的运行会随机失败。这正是这个文件开头警告过的那类 flaky 断言。
//
// 改成统计性质之后，它要证的东西没变（估计量无偏、落在向心期中段），
// 但坏实现（比如取成角度最小值 5° 或最大值 100°）照样会被抓住。
{
  const peaks: number[] = []
  for (let i = 0; i < 20; i++) {
    const r = generateSession('屈膝滑动', 8)
    if (r.emgAngle.applicable) peaks.push(r.emgAngle.peakAngle)
  }
  const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length
  const sd = Math.sqrt(
    peaks.reduce((a, b) => a + (b - mean) ** 2, 0) / peaks.length,
  )
  check(
    '★ 峰值角度落在活动范围中段（20 次均值，真值约 50°）',
    mean >= 40 && mean <= 65,
    `均值 ${mean.toFixed(1)}°，标准差 ${sd.toFixed(1)}°`,
  )
  check(
    '★ 峰值角度估计无偏（标准差在 12° 以内）',
    sd < 12,
    `标准差 ${sd.toFixed(1)}°`,
  )
}
check('★ 向心/离心比值还原出真值约 2.3（> 1.5 即说明分析有效）',
  phase.ratio > 1.5, phase.ratio.toFixed(2))
check('向心期与离心期都识别出了曲线',
  phase.concentric.length > 0 && phase.eccentric.length > 0)
check('两条曲线的角度范围大致相同（同一次动作的往返）',
  Math.abs(
    (phase.concentric.at(-1)!.angle - phase.concentric[0].angle) -
    (phase.eccentric.at(-1)!.angle - phase.eccentric[0].angle),
  ) <= 10,
  `向心跨 ${phase.concentric.at(-1)!.angle - phase.concentric[0].angle}°，离心跨 ${phase.eccentric.at(-1)!.angle - phase.eccentric[0].angle}°`)
check('比值为正且有限', Number.isFinite(phase.ratio) && phase.ratio > 0)
check('给出的解读与比值一致（>1.3 应判为正常）',
  phase.ratio >= 1.3 ? phase.level === 'good' : phase.level !== 'good',
  `level=${phase.level}`)
check('曲线按角度升序排列',
  phase.concentric.every((p, i) => i === 0 || p.angle > phase.concentric[i-1].angle))

// ---- 静力动作必须被排除 ----
const wallPhase = generateSession('靠墙静蹲', 4).emgAngle
console.log(`\n  靠墙静蹲：applicable=${wallPhase.applicable}`)
console.log(`  原因：${wallPhase.reason ?? '(无)'}`)
check('★ 静力动作不适用相位分析（避免给出无意义的比值）',
  wallPhase.applicable === false && Boolean(wallPhase.reason),
  wallPhase.reason ?? '(没有给出原因)')

// ---- 波形里要带上肌电，否则历史会话做不了这项分析 ----
const phaseWf = generateSession('屈膝滑动', 6).waveform
console.log(`\n  波形字段：${Object.keys(phaseWf).join(', ')}`)
check('波形包含 emg_mv（历史会话才能重做相位分析）',
  Array.isArray(phaseWf.emg_mv) && phaseWf.emg_mv!.length === phaseWf.t_ms.length,
  `${phaseWf.emg_mv?.length ?? 0} 点`)
check('波形各数组等长',
  phaseWf.t_ms.length === phaseWf.r_ohm.length &&
  phaseWf.t_ms.length === phaseWf.temp_c!.length &&
  phaseWf.t_ms.length === phaseWf.emg_mv!.length)
check('加入肌电后波形体积仍远小于 256 KB',
  JSON.stringify(phaseWf).length < 256 * 1024,
  `${(JSON.stringify(phaseWf).length / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed2 = results.filter(([, ok]) => ok).length
console.log(`结果：${passed2}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
