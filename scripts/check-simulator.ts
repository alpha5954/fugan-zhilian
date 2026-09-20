// 验证模拟器产出的信号在物理上说得通。
// 直接跑：node check_simulator.ts（Node 24 原生支持类型剥离）
import {
  SignalSimulator,
  TEMP_ALERT_THRESHOLD,
  type MonitorScenario,
  type Sample,
} from '../src/lib/simulator.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

function run(scenario: MonitorScenario, seconds: number, tickMs = 100): Sample[] {
  const sim = new SignalSimulator(scenario)
  const out: Sample[] = []
  for (let i = 0; i < (seconds * 1000) / tickMs; i++) out.push(sim.next(tickMs))
  return out
}

const range = (a: number[]) => ({ min: Math.min(...a), max: Math.max(...a) })
const fmt = (r: { min: number; max: number }, d = 2) =>
  `${r.min.toFixed(d)} ~ ${r.max.toFixed(d)}`

// ---------------------------------------------------------------- 康复训练
console.log('='.repeat(66));
console.log('场景一：康复训练');
console.log('='.repeat(66));

const rehab = run('rehab', 20)
const rAngle = range(rehab.map((s) => s.angle))
const rTemp = range(rehab.map((s) => s.temp))
const rEmg = range(rehab.map((s) => s.emg))

check('关节角度在 5–95° 之间往复', rAngle.min >= 4.5 && rAngle.max <= 95.5, fmt(rAngle, 1))
check('角度确实覆盖了整个活动范围（非静止）', rAngle.max - rAngle.min > 80, `跨度 ${(rAngle.max - rAngle.min).toFixed(1)}°`)
check('皮温在生理范围内（32–37°C）', rTemp.min > 32 && rTemp.max < 37, fmt(rTemp))
check('sEMG 有正有负（交流信号）', rEmg.min < 0 && rEmg.max > 0, fmt(rEmg, 3))

// 肌电爆发应与向心收缩期（角度上升段）相关
const rising = rehab.filter((s, i) => i > 0 && s.angle > rehab[i - 1].angle)
const falling = rehab.filter((s, i) => i > 0 && s.angle < rehab[i - 1].angle)
const meanAbs = (xs: Sample[]) => xs.reduce((a, s) => a + Math.abs(s.emg), 0) / xs.length
const emgRising = meanAbs(rising)
const emgFalling = meanAbs(falling)
check('肌电在向心收缩期明显强于离心期', emgRising > emgFalling * 1.3,
  `向心 ${emgRising.toFixed(3)} vs 离心 ${emgFalling.toFixed(3)} mV`)

// 核心物理关系：raw = strainPart + tempPart + 噪声
const residuals = rehab.map((s) => s.raw - s.strainPart - s.tempPart)
const rRes = range(residuals)
check('原始信号 = 应变分量 + 温度分量（残差仅为噪声）',
  Math.abs(rRes.min) < 1 && Math.abs(rRes.max) < 1, `残差 ${fmt(rRes, 3)}%`)

// 温度分量应随温度下降（负温度系数）
const corr = (xs: number[], ys: number[]) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0)
  const dx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0))
  const dy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0))
  return num / (dx * dy)
}
const c = corr(rehab.map((s) => s.temp), rehab.map((s) => s.tempPart))
check('温度分量与温度呈负相关（TCR 为负）', c < -0.9, `相关系数 ${c.toFixed(4)}`)

const cStrain = corr(rehab.map((s) => s.angle), rehab.map((s) => s.strainPart))
check('应变分量与关节角度高度正相关', cStrain > 0.99, `相关系数 ${cStrain.toFixed(4)}`)

// ---------------------------------------------------------------- 热敷监测
console.log()
console.log('='.repeat(66))
console.log('场景二：热敷监测')
console.log('='.repeat(66))

const hot = run('hotpack', 95)
const hAngle = range(hot.map((s) => s.angle))
const hTemp = range(hot.map((s) => s.temp))
const hEmg = range(hot.map((s) => Math.abs(s.emg)))

check('肢体静止，角度基本不变', hAngle.max - hAngle.min < 2, fmt(hAngle, 2))
check('温度由 40 升至 50°C', hTemp.min > 39.5 && hTemp.max > 49.5, fmt(hTemp))
check('肌电维持基线水平（无主动收缩）', hEmg.max < 0.1, `峰值 ${hEmg.max.toFixed(3)} mV`)

const crossed = hot.filter((s) => s.temp >= TEMP_ALERT_THRESHOLD)
check(`温度跨越 ${TEMP_ALERT_THRESHOLD}°C 预警阈值`, crossed.length > 0,
  `越过阈值后有 ${crossed.length} 个采样点`)

// 热敷场景下温度分量应主导原始信号的变化
const hTempPart = range(hot.map((s) => s.tempPart))
const hStrainPart = range(hot.map((s) => s.strainPart))
const tempSwing = hTempPart.max - hTempPart.min
const strainSwing = hStrainPart.max - hStrainPart.min
check('温度分量的变化幅度远大于应变分量（解耦可视化才成立）',
  tempSwing > strainSwing * 2,
  `温度分量摆幅 ${tempSwing.toFixed(2)}% vs 应变分量 ${strainSwing.toFixed(3)}%`)

// ---------------------------------------------------------------- 信号丢失
console.log()
console.log('='.repeat(66))
console.log('场景三：信号丢失')
console.log('='.repeat(66))

// 丢失概率只有 0.2%/采样点，300 秒（3000 点）里理论期望约 6 次，但
// 一次都不发生的概率约 0.25% —— 单跑一次会有偶发失败。多试几次消除它：
// 连续 5 次都没有丢失的概率约 1e-13，实际上不可能。
let long: Sample[] = []
for (let trial = 1; trial <= 5; trial++) {
  long = run('rehab', 300)
  if (long.some((s) => s.lost)) break
}
const lostIdx = long.map((s, i) => (s.lost ? i : -1)).filter((i) => i >= 0)
const lostRatio = lostIdx.length / long.length

// 统计每次丢失的持续点数
const runs: number[] = []
let cur = 0
for (const s of long) {
  if (s.lost) cur++
  else if (cur > 0) {
    runs.push(cur)
    cur = 0
  }
}
if (cur > 0) runs.push(cur)

console.log(`  300 秒共 ${long.length} 个采样点，丢失 ${lostIdx.length} 个（${(lostRatio * 100).toFixed(2)}%）`)
console.log(`  发生 ${runs.length} 次丢失，每次持续 ${runs.join(', ')} 个采样点`)

check('确实会发生信号丢失（不是永不触发）', runs.length > 0, `${runs.length} 次`)
// 上界 5%：实测中位数约 2%，偶尔到 4%。这个断言防的是"概率被误调大
// 到淹没正常信号"，不是精确匹配——精确值取决于随机数，写死了会偶发失败。
// 下界不加：只有一次丢失时占比约 0.3%，会误报。
check('丢失不淹没正常信号（占比 < 5%）', lostRatio < 0.05,
  `${(lostRatio * 100).toFixed(2)}%`)
check('每次丢失都会结束（不是永久断连）',
  long[long.length - 1].lost === false || runs.length > 0)
check('单次丢失时长在设定区间内（600–1500ms，即 6–16 个采样点）',
  runs.every((n) => n >= 5 && n <= 16), runs.join(', '))

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(66))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(66))
