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
 *  注意升温**没有固定时长** —— 是指数趋近，见 computeTemp
 *
 *  目标取 45°C：计划书说「热敷温度通常为 40-50℃」，45 落在治疗区间中部。
 *
 *  ⚠️ 这个值必须**低于** TEMP_ALERT_THRESHOLD，正常热敷才不会被判成异常。
 *     原先两者是反的（目标 50、阈值 45），后果实测过：一次 20 分钟的热敷
 *     会话里，温度在 **19.3 秒**就越过阈值，然后**有 19.7 分钟处于报警状态**
 *     —— 98.5% 的时间都在报警。一个一直亮着的安全告警不携带任何信息，
 *     等于没有告警；而计划书把「独居老人热敷预警」当作核心场景。 */
const HOTPACK_TEMP_START = 40
const HOTPACK_TEMP_END = 45

/**
 * 过热事件：热敷袋加热过久，袋温明显高于治疗区间。
 *
 * 【为什么需要它】
 * 把正常热敷的目标降到 45 之后，正常会话再也不会触发预警 —— 这是对的，
 * 但预警功能就再也没机会出现了。而计划书把「热敷操作不当」列为主要致伤
 * 原因、把热敷预警当作核心场景，所以**必须有一种真的会越界的会话**。
 *
 * 形态选「加热过久」而不是「忘记取出」：忘记取出是**时间**维度的问题
 * （计划书：接触 44℃ 持续 6 小时也有害），而温度通道测不出时间；
 * 加热过久则是实打实的**温度**越界，温度传感器能直接看见。
 *
 * 概率按**每个采样点**算（和信号丢失同一个模式）。
 *
 * ⚠️ 下面的数是**照着"演示时看得到"调的，不是照着真实发生率调的** ——
 *    真实里"加热过久"应该是偶尔一次，而模拟器没有"第几次热敷"这个概念，
 *    只能给一个平均频率。取这个值的结果是：大约每 5 分钟来一次、每次持续
 *    1~2 分钟，也就是**两成左右的时间处于告警状态**。
 *
 *    调这个的时候注意两头：调太低演示时干等看不到，调太高就变成"一直在报警"
 *    —— 那正是这次要修掉的毛病（原先 98.5% 的时间都在报警）。
 *    实测对照表见 git 提交信息。
 */
const OVERHEAT_TEMP = 55
const OVERHEAT_PROBABILITY = 0.0003
const OVERHEAT_MIN_MS = 60_000
const OVERHEAT_MAX_MS = 120_000

/**
 * 第一段过热的开始时刻（进入热敷场景后的毫秒数）。
 *
 * ⚠️ **这一条是刻意的演示编排，不是物理建模。**
 * 纯按概率来的话首次过热平均要等 5 分半，实测有个种子等到了 23 分钟 ——
 * 演示时干等着看不到预警，而"过热预警"恰恰是计划书里的核心场景。
 * 所以进入热敷场景后，第一段过热保证在 25~55 秒内出现一次。
 *
 * 之后的过热仍然按 OVERHEAT_PROBABILITY 随机来 —— 也就是说：
 * **每个热敷会话一开始都会演示一次预警，之后的节奏才是"偶尔"。**
 * 答辩被问到"多久过热一次"时，要按 OVERHEAT_PROBABILITY 那个频率回答，
 * 不要把这一段当成真实发生率。
 */
const FIRST_OVERHEAT_MIN_MS = 25_000
const FIRST_OVERHEAT_MAX_MS = 55_000

/**
 * 热敷安全阈值。
 *
 * 计划书原文（出现两处，措辞一致）：「临床研究表明，皮肤接触 44℃ 热源持续
 * 6 小时、或接触 50℃ 仅需 5 分钟，即可造成不可逆的低温烫伤。」
 *
 * 取 **50** —— 就是计划书点名的那个温度，**不留余量**。因为计划书同时说
 * 「治疗温度通常为 40-50℃」，治疗区间的上限本来就是 50；再往下压（比如
 * 45）会把正常热敷判成异常，实测那样每次会话 98.5% 的时间都在报警。
 */
export const TEMP_ALERT_THRESHOLD = 50

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

  // --- 热敷：当前升温段 ---
  // 目标温度正常是 HOTPACK_TEMP_END，过热事件时切到 OVERHEAT_TEMP。
  // 换目标时把 tempFrom / tempPhaseStart 一起重置，曲线才连续（见 setHotpackTarget）
  private hotpackTarget = HOTPACK_TEMP_END
  private tempFrom = HOTPACK_TEMP_START
  private tempPhaseStart = 0
  /** 这次过热还剩多少毫秒；> 0 表示正在过热 */
  private overheatRemaining = 0
  /** 第一段过热排在什么时刻（毫秒）。0 = 已经发生过了 */
  private firstOverheatAt = 0

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
    // ⚠️ 构造函数**不会**调 reset()，所以要单独排一次 ——
    //    第一版漏了这里，结果 new SignalSimulator('hotpack') 建出来的实例
    //    firstOverheatAt 恒为 0，"开场过热"永远不触发（实测首次告警仍在
    //    363~1406 秒，等于白加）。
    this.scheduleFirstOverheat()
  }

  /** 排下一段"开场过热"。热敷场景才有，见 FIRST_OVERHEAT_* */
  private scheduleFirstOverheat(): void {
    this.firstOverheatAt =
      this.scenario === 'hotpack'
        ? FIRST_OVERHEAT_MIN_MS +
          this.rng() * (FIRST_OVERHEAT_MAX_MS - FIRST_OVERHEAT_MIN_MS)
        : 0
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
    this.hotpackTarget = HOTPACK_TEMP_END
    this.tempFrom = HOTPACK_TEMP_START
    this.tempPhaseStart = 0
    this.overheatRemaining = 0
    this.scheduleFirstOverheat()
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
   * 热敷过热事件的状态推进。每个采样点调一次，只在热敷场景。
   *
   * 和信号丢失用同一个模式（`overheatRemaining` 倒计时 + 每点判概率）：
   * 两者都是"持续一段时间的瞬时故障"，共用一套写法比各造一套好懂。
   */
  private advanceOverheat(dt: number): void {
    // 开场那一段：到点就触发，不看概率
    if (this.firstOverheatAt > 0 && this.t >= this.firstOverheatAt) {
      this.firstOverheatAt = 0
      this.startOverheat()
      return
    }

    if (this.overheatRemaining > 0) {
      this.overheatRemaining -= dt
      // 过热结束，袋温回落到正常档（曲线从当前温度平滑降下去）
      if (this.overheatRemaining <= 0) this.setHotpackTarget(HOTPACK_TEMP_END)
      return
    }
    if (this.rng() < OVERHEAT_PROBABILITY) this.startOverheat()
  }

  /** 开始一段过热，并抽定持续时长 */
  private startOverheat(): void {
    this.overheatRemaining =
      OVERHEAT_MIN_MS + this.rng() * (OVERHEAT_MAX_MS - OVERHEAT_MIN_MS)
    this.setHotpackTarget(OVERHEAT_TEMP)
  }

  /**
   * 切换热敷袋的目标温度。
   *
   * ⚠️ 必须**先取当前温度、再换目标**：把 tempFrom 设成"换目标那一刻的温度"，
   *    并把相位起点挪到当前时刻，曲线才是从当前值继续往新目标走。
   *    直接改目标的话，指数公式会按整段 `t` 重算，温度瞬间跳到新曲线上 ——
   *    图上就是一个垂直的突跳。
   */
  private setHotpackTarget(target: number): void {
    const now = this.computeTemp()
    this.tempFrom = now
    this.tempPhaseStart = this.t
    this.hotpackTarget = target
    this.tempNoise = 0
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

    // ---- 热敷过热 ----
    // 和信号丢失同一个模式：每个采样点判一次概率，触发后持续一段随机时长。
    // 只在热敷场景有意义 —— 康复训练里没有热源
    if (this.scenario === 'hotpack') this.advanceOverheat(dt)

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
      // 向**当前目标温度**渐近逼近。正常是 HOTPACK_TEMP_END，过热时是
      // OVERHEAT_TEMP —— 换目标时 setHotpackTarget 会以当时的温度为新起点，
      // 所以曲线连续、不会跳变
      const span = this.hotpackTarget - this.tempFrom
      return (
        this.hotpackTarget -
        span * Math.exp(-(this.t - this.tempPhaseStart) / HOTPACK_TAU_MS) +
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
      `肢体静止，局部皮温向热敷袋温度指数趋近（真实升温先快后慢，不是匀速）；` +
      `热敷袋加热过久时会冲到 55 °C 上下，越过 ${TEMP_ALERT_THRESHOLD} °C 触发预警`, 
  },
}
