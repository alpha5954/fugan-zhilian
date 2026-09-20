// 验证实时监测的预警判据。
// 直接跑：node scripts/check-alerts.ts
//
// 迟滞逻辑的边界靠肉眼看代码是审不出来的，而写错的后果很具体：
//   - 迟滞区间太小 → 温度在阈值上下抖动时弹窗刷屏
//   - 未重新武装   → 温度回落再升高时不再告警（漏报）
//   - 丢失期间照常判温度 → 报出"设备都掉线了还有温度读数"的荒唐告警
import {
  createAlertState,
  evaluateSample,
  type AlertEvent,
} from '../src/lib/alertRules.ts'
import type { Sample } from '../src/lib/simulator.ts'

const results: [string, boolean, string][] = []
function check(label: string, ok: boolean, detail = '') {
  results.push([label, ok, detail])
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ->  ${detail}` : ''}`)
}

const THRESHOLD = 45
const HYSTERESIS = 1

function sample(over: Partial<Sample> = {}): Sample {
  return {
    t: 0,
    emg: 0.1,
    angle: 30,
    temp: 33,
    raw: 50,
    strainPart: 45,
    tempPart: 5,
    lost: false,
    ...over,
  }
}

/** 把一串温度值喂进去，返回全部事件 */
function feed(temps: number[], threshold = THRESHOLD) {
  const state = createAlertState()
  const events: { temp: number; ev: AlertEvent[] }[] = []
  temps.forEach((t, i) => {
    const ev = evaluateSample(state, sample({ t: i * 100, temp: t }), threshold, HYSTERESIS)
    if (ev.length) events.push({ temp: t, ev })
  })
  return { state, events }
}

const brief = (events: { temp: number; ev: AlertEvent[] }[]) =>
  events.map((e) => `${e.temp}°C→${e.ev.map((x) => x.phase).join('/')}`).join('  ')

// ---------------------------------------------------------------- 基本触发
console.log('='.repeat(70))
console.log('1. 基本触发与解除')
console.log('='.repeat(70))

const a = feed([33, 35, 40, 44, 44.9, 45, 46, 48])
console.log(`  ${brief(a.events)}`)
check('阈值以下不触发', a.events.length === 1, `共 ${a.events.length} 次事件`)
check('达到阈值触发一次 enter',
  a.events[0]?.ev[0].phase === 'enter' && a.events[0].temp === 45)
check('触发后状态为越阈', a.state.tempOver === true)

// ---------------------------------------------------------------- 不刷屏
console.log()
console.log('='.repeat(70))
console.log('2. 持续越阈不重复触发（防弹窗刷屏）')
console.log('='.repeat(70))

const b = feed([44, 45, 46, 47, 48, 49, 50, 51, 52])
console.log(`  连续 7 个越阈采样，产生 ${b.events.length} 次事件：${brief(b.events)}`)
check('持续越阈只触发一次', b.events.length === 1, `${b.events.length} 次`)

// ---------------------------------------------------------------- 迟滞
console.log()
console.log('='.repeat(70))
console.log('3. 迟滞区间（阈值附近抖动不能反复触发）')
console.log('='.repeat(70))

// 45 触发后回落到 44.5 —— 未跌破 45-1=44，不应解除
const c = feed([45, 44.5, 44.8, 44.2, 44.6, 45.1, 44.9, 44.4])
console.log(`  阈值上下抖动：${brief(c.events)}`)
check('回落到迟滞区间内不解除（避免抖动刷屏）',
  c.events.length === 1, `${c.events.length} 次事件`)
check('抖动期间仍保持越阈状态', c.state.tempOver === true)

// 真正跌破了迟滞线才解除
const d = feed([45, 46, 44, 43.5, 43])
console.log(`  回落到迟滞线以下：${brief(d.events)}`)
check('跌破迟滞线后解除一次', d.events.length === 2 && d.events[1].ev[0].phase === 'clear',
  brief(d.events))
check('解除后状态恢复', d.state.tempOver === false)

// ---------------------------------------------------------------- 重新武装
console.log()
console.log('='.repeat(70))
console.log('4. 解除后重新武装（否则会漏报第二次）')
console.log('='.repeat(70))

const e = feed([45, 43, 46, 43, 47])
console.log(`  两次升温：${brief(e.events)}`)
const enters = e.events.filter((x) => x.ev[0].phase === 'enter').length
check('每次升温都重新触发（不是只报第一次）', enters === 3, `触发 ${enters} 次`)

// ---------------------------------------------------------------- 信号丢失
console.log()
console.log('='.repeat(70))
console.log('5. 信号丢失与恢复')
console.log('='.repeat(70))

{
  const state = createAlertState()
  const evs: string[] = []
  const seq: Sample[] = [
    sample({ t: 0, lost: false }),
    sample({ t: 100, lost: true }),
    sample({ t: 200, lost: true }),
    sample({ t: 300, lost: true }),
    sample({ t: 400, lost: false }),
    sample({ t: 500, lost: false }),
  ]
  for (const s of seq) {
    for (const ev of evaluateSample(state, s, THRESHOLD, HYSTERESIS)) {
      evs.push(`${s.t}ms:${ev.kind}/${ev.phase}`)
    }
  }
  console.log(`  ${evs.join('  ')}`)
  check('丢失开始触发一次', evs.filter((x) => x.includes('device_offline/enter')).length === 1)
  check('丢失持续期间不重复触发', evs.length === 2, `${evs.length} 次事件`)
  check('恢复时触发一次 clear', evs.some((x) => x.includes('device_offline/clear')))
  check('恢复后状态复位', state.signalLost === false)
}

// ---------------------------------------------------------------- 关键正确性
console.log()
console.log('='.repeat(70))
console.log('6. 信号丢失期间不评估温度（关键）')
console.log('='.repeat(70))

{
  const state = createAlertState()
  const evs: AlertEvent[] = []
  // 丢失期间温度"看着"已经超标了 —— 但那是模拟器内部状态的延续值，
  // 不代表真实读数，绝不能据此告警
  for (let i = 0; i < 6; i++) {
    evs.push(...evaluateSample(state, sample({ t: i * 100, temp: 50, lost: true }), THRESHOLD, HYSTERESIS))
  }
  const tempEvents = evs.filter((e) => e.kind === 'temp_high')
  check('丢失期间即使温度值超标也不报温度告警',
    tempEvents.length === 0,
    `产生 ${tempEvents.length} 次温度事件（应当为 0）`)
  check('但信号丢失本身有报', evs.some((e) => e.kind === 'device_offline' && e.phase === 'enter'))
}

// 恢复后若温度确实超标，应当立即告警
{
  const state = createAlertState()
  evaluateSample(state, sample({ t: 0, temp: 50, lost: true }), THRESHOLD, HYSTERESIS)
  const after = evaluateSample(state, sample({ t: 100, temp: 50, lost: false }), THRESHOLD, HYSTERESIS)
  check('信号恢复后温度确实超标则立即告警',
    after.some((e) => e.kind === 'temp_high' && e.phase === 'enter'),
    after.map((e) => `${e.kind}/${e.phase}`).join(', '))
}

// ---------------------------------------------------------------- 汇总
console.log()
console.log('='.repeat(70))
const passed = results.filter(([, ok]) => ok).length
console.log(`结果：${passed}/${results.length} 项通过`)
for (const [label, ok] of results) if (!ok) console.log(`  未通过：${label}`)
console.log('='.repeat(70))
