// ============================================================================
// 演示数据
// ============================================================================
// 给"还没有任何训练记录"的访客用。
//
// 【为什么需要它】
// 健康摘要页的整个价值建立在**历史**上 —— 没有历史就没有进步度、
// 没有基线、没有趋势，页面只会显示一片"还没有记录"。
// 而第一次打开链接的人（评审、家属、队友）恰恰一定没有历史。
// 让他们看到的是一个空页面，等于这套东西没做。
//
// 【它做什么、不做什么】
// 只在**前端内存里**算出一份摘要用于展示，**绝不写数据库**。
// 所以不会污染任何真实数据，退出即消失，不会被误当成真的训练记录。
//
// 数据本身走的是与真实评估完全相同的链路（generateSession），
// 也就是说页面上的每一个数字都是这套系统的算法产出的，不是手编的。
//
// 【界面上的义务】
// 用了这份数据就必须**明确标出来**。项目的一条底线是"不把模拟数据
// 说成实测数据"（见 README「数据来源」一节），演示数据同样适用。
// ============================================================================

import { generateSession } from './assessment.ts'
import { DEMO_SEED, makeRng, type Rng } from './rng.ts'
import type { ExerciseName } from './assessment.ts'
import type { Alert, RehabSession, Waveform } from '@/types'

/** 演示数据的窗口长度，要盖住 insight.ts 里的"本周 + 14 天基线" */
const DEMO_DAYS = 21

const DAY_MS = 86_400_000

/**
 * 按顺序轮换的动作。
 *
 * 与 REHAB_EXERCISES 的顺序一致，但这里显式列出来：
 * 演示数据需要一个**固定的训练安排**（今天练这个、明天练那个），
 * 而不是每天随机抽一个动作 —— 随机的话对比图里每个动作都稀稀拉拉，
 * 趋势完全看不出来。
 */
const ROTATION: ExerciseName[] = ['坐位伸膝', '屈膝滑动', '直腿抬高', '靠墙静蹲']

/**
 * 第 n 天前的一次训练。
 *
 * `progress` 是 0~1 的康复进程，用来制造一条**肉眼可见的进步曲线**：
 * 越接近现在，完成度越高。没有这条曲线，趋势图和"比上周提升 X%"
 * 都无从体现。
 */
function makeSession(
  exercise: ExerciseName,
  daysAgo: number,
  progress: number,
  now: Date,
  seq: number,
  rng: Rng,
): RehabSession {
  const result = generateSession(exercise, 8, rng)

  // 把本次的指标按康复进程缩放。真实康复中的进步就是这么来的 ——
  // 幅度一点点变大，其余特征不变
  const scale = 0.72 + progress * 0.3
  const started = new Date(now.getTime() - daysAgo * DAY_MS)
  started.setHours(9 + (seq % 3) * 4, (seq * 7) % 60, 0, 0)

  return {
    id: `demo-${seq}`,
    patient_id: 'demo',
    device_id: null,
    joint: 'knee',
    exercise,
    // 识别结果偶尔对不上。
    //
    // 恒定的 100% 反而不可信 —— "动作标准度 100%" 摆在卡片上，
    // 家属和评审的第一反应是"这数据是编的"。而且真实的动作识别
    // 本来就会有误判，把这个如实体现出来才对。
    //
    // 取模 7 取 3 是调过的：命中的序数正好落在最近一周内，
    // 让本周的标准度在 86% 左右，而不是一个可疑的整百。
    recognized: seq % 7 === 3 ? ROTATION[(seq + 1) % ROTATION.length]! : exercise,
    started_at: started.toISOString(),
    ended_at: new Date(started.getTime() + result.durationS * 1000).toISOString(),
    duration_s: result.durationS,
    rep_count: 8,
    rom_deg: Number((result.romMax * scale).toFixed(2)),
    // 静力动作要存保持角度。与 rom_deg 一样跟着康复进程放大 ——
    // 静蹲的"进步"就体现在能保持在更大的屈曲角上
    hold_deg:
      result.metric === 'hold'
        ? Number((result.holdAngle * scale).toFixed(2))
        : null,
    temp_c: Number((result.tempMax + (progress - 0.5) * 1.5).toFixed(2)),
    rms_mv: Number(result.rmsAvg.toFixed(4)),
    confidence: Number((0.86 + progress * 0.1).toFixed(3)),
    // 波形不塞进来：演示数据没必要占内存，页面上也不用
    waveform: null as Waveform | null,
    notes: null,
    created_at: started.toISOString(),
  }
}

/**
 * 造一段 21 天的演示训练史。
 *
 * 安排上刻意留了两天空档：全勤的曲线不真实，而且"依从性"这一项
 * 永远是满分的话，看不出它在起什么作用。
 */
export function buildDemoSessions(now: Date = new Date()): RehabSession[] {
  // 固定种子 —— 同一份演示每次刷新都是同一组数据。
  // 不固定的话分数每次刷新都在变（实测出现过 81 / 77 / 80），
  // 排练时记住的数到台上就变了。见 lib/rng.ts。
  const rng = makeRng(DEMO_SEED)
  const out: RehabSession[] = []
  let seq = 0

  for (let d = DEMO_DAYS - 1; d >= 0; d--) {
    // 第 8 天和第 15 天休息，其余每天一次训练
    if (d === 8 || d === 15) continue

    // 进度：最久远的 0 → 今天的 1
    const progress = (DEMO_DAYS - 1 - d) / (DEMO_DAYS - 1)
    const exercise = ROTATION[(DEMO_DAYS - d) % ROTATION.length]!

    out.push(makeSession(exercise, d, progress, now, seq++, rng))
  }

  return out
}

/**
 * 演示用的预警记录。
 *
 * 只放一条**已处理**的一般预警，不放严重预警 ——
 * 演示的重点是"系统能发现问题并且问题已经被处理了"，
 * 而不是让刚打开页面的人以为出了大事。
 */
export function buildDemoAlerts(now: Date = new Date()): Alert[] {
  const at = new Date(now.getTime() - 4 * DAY_MS)
  at.setHours(15, 20, 0, 0)

  return [
    {
      id: 'demo-alert-1',
      patient_id: 'demo',
      device_id: null,
      session_id: null,
      kind: 'temp_high',
      severity: 'warning',
      message: null,
      value: 45.8,
      threshold: 45,
      occurred_at: at.toISOString(),
      // 已处理。未处理的话首页会一直挂着一条黄灯
      acknowledged_at: new Date(at.getTime() + 40 * 60 * 1000).toISOString(),
      acknowledged_by: 'demo',
      created_at: at.toISOString(),
    },
  ]
}
