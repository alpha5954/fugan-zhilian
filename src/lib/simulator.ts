// ============================================================================
// 传感器信号模拟器
// ============================================================================
// 硬件尚未接入，这一页用模拟信号驱动。目标是生成**物理上讲得通**的数据，
// 而不是随机数 —— 否则四个图表的联动关系（角度升高 → 应变分量升高 →
// 原始信号偏移；温度变化 → 温度分量漂移）演示不出来，评审一眼就能看出是假的。
//
// 信号链路的物理关系：
//
//   膝关节屈曲角度 ──映射──> 传感器伸长率 ──GF──> 应变分量 ΔR/R₀
//   局部温度 ────────────TCR────────────────> 温度分量 ΔR/R₀
//                                                    │
//                              原始信号 = 应变分量 + 温度分量 + 测量噪声
//
//   解耦做的事就是把最后这行反过来 —— 从叠加的原始信号里拆出两个分量。
//
// 参数取自项目计划书：
//   0–50% 应变区间 GF ≈ 5.68
//   20–90 °C 区间 TCR = −1.04 %·°C⁻¹
// ============================================================================

/** 监测场景 */
import type { Rng } from './rng.ts'

export type MonitorScenario = 'rehab' | 'hotpack'

/** 一个采样点 */
export interface Sample {
  /** 相对会话开始的毫秒偏移 */
  t: number
  /** 表面肌电信号，mV */
  emg: number
  /** 膝关节屈曲角度，度 */
  angle: number
  /** 局部皮肤温度，摄氏度 */
  temp: number
  /** 传感器原始电阻变化率 ΔR/R₀，% —— 应变与温度耦合的结果 */
  raw: number
  /** 解耦出的应变分量，% */
  strainPart: number
  /** 解耦出的温度分量，% */
  tempPart: number
  /**
   * 本次采样是否处于**信号丢失**状态。
   *
   * 为 true 时上面几个测量值都不代表真实读数 —— 调用方应当把它们当作
   * 空值处理（图表断线、状态栏显示"信号丢失"），而不是照常画出去。
   * 真实设备上这对应电极脱落、蓝牙断连、接触阻抗过大等情况。
   */
  lost: boolean
}

// ---------------------------------------------------------------------------
// 物理参数
// ---------------------------------------------------------------------------
const GAUGE_FACTOR = 5.68 // 0–50% 应变区间的灵敏度系数
const TCR = -1.04 // %·°C⁻¹，负温度系数
const TEMP_REFERENCE = 33.0 // 温度分量的参考点，°C

/** 膝关节屈曲角度的默认活动范围（度） */
const ANGLE_MIN = 5
const ANGLE_MAX = 95

/** 对应角度范围下传感器的伸长率（%） */
const STRAIN_AT_MIN = 2
const STRAIN_AT_MAX = 32

/** 一次动作循环的时长，毫秒 */
const REP_PERIOD_REHAB = 4000

/**
 * 动作档位：不同康复动作的关节活动范围与节奏差异很大。
 *
 * 静力动作（靠墙静蹲）几乎没有关节位移，只在目标角度附近小幅维持；
 * 屈膝滑动则是全幅度屈伸。用同一套参数会让所有会话的 ROM 完全一致，
 * 对比图和达标判定就失去意义了。
 */
export interface MotionProfile {
  angleMin: number
  angleMax: number
  /** 一次动作循环的时长，毫秒 */
  periodMs: number
}

const DEFAULT_PROFILE: MotionProfile = {
  angleMin: ANGLE_MIN,
  angleMax: ANGLE_MAX,
  periodMs: REP_PERIOD_REHAB,
}

/** 热敷袋温度与起始皮温。
 *  注意升温**没有固定时长** —— 是指数趋近，见 computeTemp */
const HOTPACK_TEMP_START = 40
const HOTPACK_TEMP_END = 50

/** 热敷安全阈值（计划书：皮肤接触 50°C 仅需 5 分钟即可造成不可逆损伤） */
export const TEMP_ALERT_THRESHOLD = 45

/** 基线噪声幅度，mV */
const EMG_BASELINE = 0.04

/**
 * 信号丢失的模拟参数。
 *
 * 真实设备上电极脱落、蓝牙断连、接触阻抗过大都会导致信号中断。
 * 这里按每个采样点的概率触发，持续一段随机时长后自动恢复。
 *
 * ⚠️ 概率是对**每个采样点**生效的，不是对"每次丢失事件"—— 每个 tick
 *    都是一次机会。0.002 × 3000 点（5 分钟）≈ 6 次丢失，对应约 3% 的
 *    采样点被标记为丢失。实测中位数就在 2% 附近。
 *    想调稀疏些就调小这个值，注意别只看它本身、忘了乘采样点数。
 */
const DROPOUT_PROBABILITY = 0.002
const DROPOUT_MIN_MS = 600
const DROPOUT_MAX_MS = 1500

/**
 * 一次动作里关节角度随时间的归一化轨迹（0~1）。
 *
 * 刻意**不是余弦**。余弦有两个一眼能看出来的毛病：
 *
 *   1. 上升段和下降段完全对称 —— 真实动作里主动屈曲和回落的速度不一样
 *   2. 两端只停留一瞬 —— 真实的康复动作在最大屈曲位会**保持一下**
 *      （治疗师通常会要求"到顶停两秒"），起始位也有个换气的间隙
 *
 * 现在是：较快地屈曲 → 短暂保持 → 较慢地回落。
 * 这个不对称也正是相位分析能看出东西的前提。
 */
const RISE_END = 0.4
const HOLD_END = 0.52

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function motionShape(phase: number): number {
  if (phase < RISE_END) return smoothstep(phase / RISE_END)
  if (phase < HOLD_END) return 1
  return 1 - smoothstep((phase - HOLD_END) / (1 - HOLD_END))
}

/** 热敷升温的时间常数（毫秒）。见 computeTemp 的说明 */
const HOTPACK_TAU_MS = 28_000

/** 康复训练皮温趋近平衡点的时间常数（毫秒） */
const REHAB_TAU_MS = 90_000

// ---------------------------------------------------------------------------

export class SignalSimulator {
  scenario: MonitorScenario

  /** 当前动作档位，决定关节活动范围与节奏 */
  private profile: MotionProfile

  private t = 0
  /** 温度随机游走的累积量，带回归项避免无限漂移 */
  private tempNoise = 0
  /** sEMG 载波相位 */
  private emgPhase = 0
  /** 校准时的温度基线，calibrate() 会重设 */
  private tempBaseline = TEMP_REFERENCE
  /** 当前这次信号丢失还剩多少毫秒；> 0 表示正在丢失 */
  private dropRemaining = 0

  // --- 当前这一轮动作的参数。每轮重抽，见 computeMotion ---
  private repStartT = 0
  private repEndT = 0
  /** 本轮周期（毫秒）。在标称值上抖动 */
  private repPeriod = 0
  /** 本轮的幅度系数。只往下抖，见 computeMotion 的说明 */
  private repAmp = 1

  /**
   * 随机源。
   *
   * 默认 Math.random（实时监测就该每次不一样）；演示数据会传一个
   * 固定种子的进来，让同一份演示每次刷新都一致。见 lib/rng.ts。
   */
  private rng: Rng

  constructor(
    scenario: MonitorScenario = 'rehab',
    profile: Partial<MotionProfile> = {},
    rng: Rng = Math.random,
  ) {
    this.scenario = scenario
    this.profile = { ...DEFAULT_PROFILE, ...profile }
    this.rng = rng
  }

  /** 切换场景并重置状态 */
  setScenario(scenario: MonitorScenario): void {
    if (this.scenario === scenario) return
    this.scenario = scenario
    this.reset()
  }

  reset(): void {
    this.t = 0
    this.tempNoise = 0
    this.emgPhase = 0
    this.tempBaseline = TEMP_REFERENCE
    this.dropRemaining = 0
    // 归零，让下一轮重新抽参数（-1 表示"还没有当前轮"）
    this.repStartT = 0
    this.repEndT = -1
    this.repPeriod = this.profile.periodMs
    this.repAmp = 1
  }

  /**
   * 校准：把当前温度记为新基线。
   *
   * 相当于临床上"贴合后静置 30 秒取基线"这一步 —— 传感器刚贴到皮肤上时
   * 温度还没稳定，用出厂参考点算出的温度分量会有一个固定偏差。
   */
  calibrate(): void {
    const current = this.computeTemp()
    this.tempBaseline = current
    this.tempNoise = 0
  }

  /** 当前温度基线（校准后的参考点） */
  get baseline(): number {
    return this.tempBaseline
  }

  /**
   * 推进 dt 毫秒，产出一个采样点。
   */
  next(dt: number): Sample {
    this.t += dt

    // ---- 信号丢失 ----
    // 注意：丢失期间**照常推进内部状态**（温度随机游走、动作周期），
    // 只是把 lost 标记为 true 交给调用方决定怎么显示。若在这里冻结状态，
    // 恢复时温度会从断点接续，看起来像"信号丢失期间温度被冻住了"。
    if (this.dropRemaining > 0) {
      this.dropRemaining -= dt
    } else if (this.rng() < DROPOUT_PROBABILITY) {
      this.dropRemaining =
        DROPOUT_MIN_MS + this.rng() * (DROPOUT_MAX_MS - DROPOUT_MIN_MS)
    }
    const lost = this.dropRemaining > 0

    const temp = this.computeTemp()
    const { angle, envelope } = this.computeMotion()

    // ---- sEMG ----
    // 真实肌电是杂乱的高频噪声，其**包络**随肌肉激活程度变化。
    // 这里用载波 + 随机噪声混合，视觉上接近真实 sEMG 而非平滑正弦。
    this.emgPhase += (dt / 1000) * 2 * Math.PI * 7
    const carrier = Math.sin(this.emgPhase)
    const noise = this.rng() * 2 - 1
    const emg = envelope * (0.45 * carrier + 0.85 * noise)

    // ---- 解耦 ----
    // 角度 → 伸长率 → 应变分量
    //
    // 应变与角度**不是线性关系**。真实柔性传感器的导电网络在拉伸过程中
    // 会重排，灵敏度随应变量变化 —— 计划书里的 GF = 5.68 是「0–50% 应变
    // 区间」的**平均**灵敏度，这句话本身就意味着各区间灵敏度不同。
    //
    // 这里用一条温和的幂曲线：低应变区变化慢、高应变区变化快。
    // 单调，所以"应变与角度高度正相关"那条断言仍然成立。
    // ⚠️ 必须钳到 [0,1]。幂运算对负底数是 NaN —— 而角度小于 ANGLE_MIN
    //    是**常态**不是异常：热敷场景的肢体静止角约 4°、直腿抬高的
    //    angleMin 是 2°，两者都低于这里的 5°。不钳的话应变分量直接变
    //    NaN，解耦图整条画不出来。自检脚本抓到了这个（"应变分量 NaN%"）。
    const x = Math.min(
      1,
      Math.max(0, (angle - ANGLE_MIN) / (ANGLE_MAX - ANGLE_MIN)),
    )
    const strainPct =
      STRAIN_AT_MIN + (STRAIN_AT_MAX - STRAIN_AT_MIN) * x ** 1.35
    const strainPart = GAUGE_FACTOR * strainPct

    // 温度 → 温度分量（以校准基线为参考点，负温度系数）
    const tempPart = TCR * (temp - this.tempBaseline)

    // ---- 原始信号：两个分量叠加，再加测量噪声 ----
    // 这一行就是"耦合"本身，解耦算法的目标就是从它里面还原出上面两个分量
    const raw = strainPart + tempPart + (this.rng() - 0.5) * 1.6

    return { t: this.t, emg, angle, temp, raw, strainPart, tempPart, lost }
  }

  /**
   * 局部温度。
   *
   * 【为什么是指数趋近而不是线性】
   * 改造前是 `线性升到目标后保持`。两个问题：
   *
   *   1. **形状不对**。皮肤被加热时温度向热源温度**渐近**逼近（牛顿加热），
   *      一开始升得快、后来越来越慢。线性升温在图上是一条笔直的斜线，
   *      一眼能看出是生成的。
   *   2. **到达那一刻斜率突变**，从斜线突然变成水平线 —— 真实的温度曲线
   *      不会有一个折角。
   *
   * 时间常数按"90 秒走完约 96% 的行程"选，与改造前的时长体感一致，
   * 但曲线形状完全不同。
   */
  private computeTemp(): number {
    if (this.scenario === 'hotpack') {
      this.tempNoise += (this.rng() - 0.5) * 0.02
      this.tempNoise *= 0.97
      // 向热敷袋温度（HOTPACK_TEMP_END）渐近逼近
      const span = HOTPACK_TEMP_END - HOTPACK_TEMP_START
      return (
        HOTPACK_TEMP_END -
        span * Math.exp(-this.t / HOTPACK_TAU_MS) +
        this.tempNoise
      )
    }

    // 康复训练：肌肉产热，皮温向新的平衡点（35.5°C）渐近逼近
    this.tempNoise += (this.rng() - 0.5) * 0.012
    this.tempNoise *= 0.98
    return 35.5 - 2.5 * Math.exp(-this.t / REHAB_TAU_MS) + this.tempNoise
  }

  /**
   * 关节角度与肌电包络。
   *
   * 【为什么要逐轮抖动】
   * 改造前是 `t % periodMs` 算相位、乘一条固定的余弦 —— 结果是**每一轮
   * 都一模一样**：同样的周期、同样的幅度，画在图上是一条完美的正弦。
   * 真实患者做不到：注意力、疲劳、关节僵硬都会让每一轮略有差别。
   *
   * 现在每轮重抽周期（±6%）和幅度。幅度是**只往下抖**的：
   *   1. 疲劳让活动范围变小，不会越做越大，物理上是单向的
   *   2. 上限必须卡住 —— 抽查脚本断言最大角度不超过 profile 的 angleMax，
   *      往上抖会直接让那条断言随机失败
   */
  private computeMotion(): { angle: number; envelope: number } {
    if (this.scenario === 'hotpack') {
      // 热敷时肢体静止，只有极小的姿势抖动
      return {
        angle: 4 + (this.rng() - 0.5) * 0.6,
        envelope: EMG_BASELINE,
      }
    }

    const { angleMin, angleMax, periodMs } = this.profile

    // 开始新的一轮
    if (this.t >= this.repEndT) {
      this.repStartT = this.t
      this.repPeriod = periodMs * (0.94 + this.rng() * 0.12)
      this.repAmp = 0.95 + this.rng() * 0.05
      this.repEndT = this.t + this.repPeriod
    }

    const phase = (this.t - this.repStartT) / this.repPeriod
    const angle =
      angleMin + (angleMax - angleMin) * this.repAmp * motionShape(phase)

    // 肌电包络集中在向心收缩期，离心期明显减弱 —— 与真实膝关节康复动作
    // 的肌电模式一致。峰值位置对着 motionShape 的屈曲段中点（约 0.20）
    // 和回落段中点（约 0.76），不是余弦时代那组数
    const concentric = Math.exp(-(((phase - 0.2) / 0.13) ** 2) / 2)
    const eccentric = 0.28 * Math.exp(-(((phase - 0.76) / 0.17) ** 2) / 2)
    const envelope = EMG_BASELINE + 0.85 * concentric + 0.85 * eccentric

    return { angle, envelope }
  }
}

/** 场景说明文案，界面和导出共用 */
export const SCENARIO_INFO: Record<
  MonitorScenario,
  { label: string; detail: string }
> = {
  rehab: {
    label: '康复训练',
    detail:
      '膝关节屈伸动作，约 4 秒一个循环 —— 较快地屈曲、在最大屈曲位保持一下、' +
      '再较慢地回落；肌电在向心收缩期出现爆发',
  },
  hotpack: {
    label: '热敷监测',
    detail:
      `肢体静止，局部皮温向热敷袋温度指数趋近（约 20 秒越过 ${TEMP_ALERT_THRESHOLD} °C 预警阈值）` +
      '—— 真实升温是先快后慢，不是匀速',
  },
}
