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
}

// ---------------------------------------------------------------------------
// 物理参数
// ---------------------------------------------------------------------------
const GAUGE_FACTOR = 5.68 // 0–50% 应变区间的灵敏度系数
const TCR = -1.04 // %·°C⁻¹，负温度系数
const TEMP_REFERENCE = 33.0 // 温度分量的参考点，°C

/** 膝关节屈曲角度的活动范围（度） */
const ANGLE_MIN = 5
const ANGLE_MAX = 95

/** 对应角度范围下传感器的伸长率（%） */
const STRAIN_AT_MIN = 2
const STRAIN_AT_MAX = 32

/** 一次动作循环的时长，毫秒 */
const REP_PERIOD_REHAB = 4000

/** 热敷升温的总时长与温度区间 */
const HOTPACK_RAMP_MS = 90_000
const HOTPACK_TEMP_START = 40
const HOTPACK_TEMP_END = 50

/** 热敷安全阈值（计划书：皮肤接触 50°C 仅需 5 分钟即可造成不可逆损伤） */
export const TEMP_ALERT_THRESHOLD = 45

/** 基线噪声幅度，mV */
const EMG_BASELINE = 0.04

// ---------------------------------------------------------------------------

export class SignalSimulator {
  scenario: MonitorScenario

  private t = 0
  /** 温度随机游走的累积量，带回归项避免无限漂移 */
  private tempNoise = 0
  /** sEMG 载波相位 */
  private emgPhase = 0
  /** 校准时的温度基线，calibrate() 会重设 */
  private tempBaseline = TEMP_REFERENCE

  constructor(scenario: MonitorScenario = 'rehab') {
    this.scenario = scenario
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

    const temp = this.computeTemp()
    const { angle, envelope } = this.computeMotion()

    // ---- sEMG ----
    // 真实肌电是杂乱的高频噪声，其**包络**随肌肉激活程度变化。
    // 这里用载波 + 随机噪声混合，视觉上接近真实 sEMG 而非平滑正弦。
    this.emgPhase += (dt / 1000) * 2 * Math.PI * 7
    const carrier = Math.sin(this.emgPhase)
    const noise = Math.random() * 2 - 1
    const emg = envelope * (0.45 * carrier + 0.85 * noise)

    // ---- 解耦 ----
    // 角度 → 伸长率 → 应变分量
    const strainPct =
      STRAIN_AT_MIN +
      ((angle - ANGLE_MIN) / (ANGLE_MAX - ANGLE_MIN)) *
        (STRAIN_AT_MAX - STRAIN_AT_MIN)
    const strainPart = GAUGE_FACTOR * strainPct

    // 温度 → 温度分量（以校准基线为参考点，负温度系数）
    const tempPart = TCR * (temp - this.tempBaseline)

    // ---- 原始信号：两个分量叠加，再加测量噪声 ----
    // 这一行就是"耦合"本身，解耦算法的目标就是从它里面还原出上面两个分量
    const raw = strainPart + tempPart + (Math.random() - 0.5) * 1.6

    return { t: this.t, emg, angle, temp, raw, strainPart, tempPart }
  }

  /** 局部温度 */
  private computeTemp(): number {
    if (this.scenario === 'hotpack') {
      // 热敷：从 40°C 线性升到 50°C
      const progress = Math.min(1, this.t / HOTPACK_RAMP_MS)
      this.tempNoise += (Math.random() - 0.5) * 0.02
      this.tempNoise *= 0.97
      return HOTPACK_TEMP_START +
        (HOTPACK_TEMP_END - HOTPACK_TEMP_START) * progress +
        this.tempNoise
    }

    // 康复训练：皮肤温度随运动缓慢上升，从 33°C 到约 35.5°C
    const target = 33.0 + 2.5 * Math.min(1, this.t / 180_000)
    this.tempNoise += (Math.random() - 0.5) * 0.012
    this.tempNoise *= 0.98
    return target + this.tempNoise
  }

  /** 关节角度与肌电包络 */
  private computeMotion(): { angle: number; envelope: number } {
    if (this.scenario === 'hotpack') {
      // 热敷时肢体静止，只有极小的姿势抖动
      return {
        angle: 4 + (Math.random() - 0.5) * 0.6,
        envelope: EMG_BASELINE,
      }
    }

    const phase = (this.t % REP_PERIOD_REHAB) / REP_PERIOD_REHAB

    // 用余弦保证起止平滑，无突变
    const angle =
      ANGLE_MIN + ((ANGLE_MAX - ANGLE_MIN) * (1 - Math.cos(2 * Math.PI * phase))) / 2

    // 肌电包络集中在向心收缩期（phase ≈ 0.25），离心期明显减弱 ——
    // 这与真实膝关节康复动作的肌电模式一致
    const concentric = Math.exp(-(((phase - 0.25) / 0.12) ** 2) / 2)
    const eccentric = 0.28 * Math.exp(-(((phase - 0.72) / 0.16) ** 2) / 2)
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
    detail: '膝关节屈伸动作，4 秒一个循环；肌电在向心收缩期出现爆发',
  },
  hotpack: {
    label: '热敷监测',
    detail: `肢体静止，局部温度 90 秒内由 40 °C 升至 50 °C，跨越 ${TEMP_ALERT_THRESHOLD} °C 预警阈值`,
  },
}
