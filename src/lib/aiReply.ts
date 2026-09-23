// ============================================================================
// AI 回复的解析与校验
// ============================================================================
// 【这个模块是什么】
// 模型返回一段 JSON 文本。这个模块负责把它变成**能上屏的东西**，或者明确
// 地拒绝它。中间没有任何"先显示出来再说"的余地。
//
// ============================================================================
// 【三道闸门，任何一道不过就不上屏】
// ============================================================================
//   ① 形状   —— 逐字段类型、长度上限、band 必须是三值之一
//   ② 数值   —— 正文里的每个数字都必须出现在发过去的上下文里
//   ③ 合规   —— 疾病名 / 诊断动作 / 治疗方案 / 主语是患者本人
//
// 设计方向是 **fail-closed**：拿不准就别显示。宁可这次没有 AI 解读，
// 也不能把一个编出来的"达标率 87.3%"放到家属面前。
//
// ============================================================================
// 【为什么按"条"拒，而不是整篇拒】
// ============================================================================
// 整篇拒的代价太大了：一条结论里有一个对不上的数字，整段 AI 解读就没了，
// 界面上退回"AI 暂时不可用"。而按条拒在安全性上**完全等价** —— 编造的
// 数字一样到不了屏幕 —— 却能在个别条目不合格时保住其余的。
//
// 被丢掉的条数会如实告诉界面（`dropped`），界面上要能说"有 N 条未通过
// 校验，已省略"。**不要静默丢弃** —— 那等于悄悄换了一份数据给用户看。
//
// ============================================================================
// ⚠️ 数值闸门是「一致性」检查，不是「归属」检查，更不是「正确性」检查
// ============================================================================
// 它能挡住的：
//   ✓ 凭空编出来的测量值（角度、温度、百分比、次数）
//
// 它挡不住的（**必须如实写在 README 里，不许 overclaim**）：
//   ✗ 张冠李戴 —— 上下文里同时有 rom_deg 86.5 和 temp_c 33.1，模型写
//                「皮温 86.5 °C」照样通过。它只问"这个数字出现过吗"，
//                不问"它是不是这个量的"
//   ✗ 整句不带数字的定性断言
//   ✗ 方向词写反（数据回落却写"进步"）
//   ✗ 中文数词编造（「连续七天」里没有阿拉伯数字，正则看不见）
//   ✗ 上下文根本没包含的指标
//
// 所以**界面上只能写「由 AI 生成」**，绝不能写「数据已核对」或「已合规
// 校验」。那是把一个尽力而为的过滤器说成了保证。
// ============================================================================

import { complianceIssue } from './compliance.ts'
import type { AiContext } from './aiContext.ts'
import type { RiskBand } from './insight.ts'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一条 AI 结论。
 *
 * 形状**刻意贴着 `Finding`**（label / evidence / action / band）—— 这样
 * 能用同一套组件和视觉语言渲染，不必新做一个"看起来像外来控件"的卡片。
 *
 * 区别只有一个：`Finding.evidence` 是我们自己算的依据，而 `basis` 是
 * **AI 声称**的依据。所以字段名也不同，不混用 —— 界面上要能一眼看出
 * 哪句是系统算的、哪句是模型说的。
 */
export interface AiPoint {
  /** 结论。主语应当是「数据/训练」，不是「患者」 */
  text: string
  /** AI 声称的依据。必须含具体数值，且那些数值必须来自上下文 */
  basis: string
  /** 该做什么 */
  action: string
  band: RiskBand
}

export interface AiAnalysis {
  /** 一段话总述。可能为空串（它自己没过闸门） */
  summary: string
  points: AiPoint[]
  /** 模型自己写的局限说明 */
  caveat: string
}

export interface AiParseResult {
  /** 通过校验的内容。全部被拒时为 null */
  analysis: AiAnalysis | null
  /** 被丢掉的条目数（含 summary）。界面要如实显示 */
  dropped: number
  /** 整篇失败时的中文原因。部分成功时为 null */
  reason: string | null
}

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------
// 上限同时起两个作用：挡住模型失控输出超长文本，以及给提示词里那句
// 「最多 3 条」一个可执行的兜底（模型偶尔会多给一条）。

const MAX_SUMMARY_CHARS = 300
const MAX_POINT_TEXT_CHARS = 120
const MAX_BASIS_CHARS = 200
const MAX_ACTION_CHARS = 120
const MAX_CAVEAT_CHARS = 200
/** 提示词要求最多 3 条，这里留一条余量 */
const MAX_POINTS = 4

const BANDS: readonly RiskBand[] = ['green', 'yellow', 'red']

// ---------------------------------------------------------------------------
// 数字的规范化与提取
// ---------------------------------------------------------------------------

/**
 * 把各种"看起来像数字但正则不认"的写法统一成 ASCII。
 *
 * ⚠️ 这几条每一条都对应一个真实的误杀来源：
 *   · 全角数字与全角百分号 —— 中文输入法下模型偶尔会输出全角
 *   · **真减号 `−`(U+2212)** —— 界面自己就用它排版负数
 *     （见 Dashboard.vue 的 signed()），模型跟着学会写它，而正则里的
 *     `-` 是 ASCII 的，对不上 → 所有负数被拒
 *   · 千分位逗号 —— 「1,234」会被切成 1 和 234 两个数
 */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−–—]/g, '-')
    .replace(/，/g, ',')
    .replace(/％/g, '%')
    // 千分位：把 1,234 这样的逗号去掉。只在数字之间存在时才消，
    // 否则会把「8 次，共 3 天」这类正常标点也吃掉
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
}

interface Num {
  value: number
  /** 这个数写出来有几位小数。容差按它算，见 numbersMatch */
  decimals: number
}

/** 抽出一个字符串里所有的数字 */
function extract(text: string): Num[] {
  const out: Num[] = []
  const re = /-?\d+(?:\.\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(normalize(text))) !== null) {
    const value = Number(m[0])
    if (!Number.isFinite(value)) continue
    const dot = m[0].indexOf('.')
    out.push({ value, decimals: dot < 0 ? 0 : m[0].length - dot - 1 })
  }
  return out
}

/**
 * 建立「允许出现的数字」集合。
 *
 * 三个来源：
 *   ① 上下文里所有的数值字段
 *   ② **字符串字段里的数字** —— 这一步不能省。规则层算好的 evidence
 *      文案（「实测 78.4°，目标 90°，差 11.6°」）里全是数字，而它们正是
 *      AI 最该引用的那一批。只遍历数值字段会把它们全漏掉。
 *   ③ **0~1 之间的小数额外放行它的百分数形式**（0.615 → 61.5）
 *
 * ⚠️ 第 ③ 条是**单向**的：只把小数放大成百分数，绝不反过来把 90 缩小成
 *    0.9，也不做 90 → 9000 这种放大。单向展开覆盖了真实场景（上下文存
 *    比率、模型写百分比），同时不会把允许集撑到形同虚设。
 */
export function allowedNumbers(ctx: AiContext): Set<number> {
  const allowed = new Set<number>()

  const add = (v: number) => {
    if (!Number.isFinite(v)) return
    allowed.add(v)
    // 小数 → 百分数形式。只在这一侧展开，理由见函数头
    if (v > 0 && v < 1) allowed.add(Number((v * 100).toFixed(1)))
  }

  const walk = (v: unknown): void => {
    if (typeof v === 'number') add(v)
    else if (typeof v === 'string') for (const n of extract(v)) add(n.value)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }

  walk(ctx)
  return allowed
}

/**
 * 两个数算不算"同一个数"。
 *
 * 容差按**写出来的那个数**的小数位算：写 `78.4` 时容差 0.05，写 `78` 时
 * 容差 0.5。这样：
 *   · 上下文 78.44、模型写 78.4 → 差 0.04 ≤ 0.05，算同一个数（是四舍五入）
 *   · 上下文 78.44、模型写 23   → 差得远，拒
 *
 * 不做浮点近似之外的任何猜测 —— 这一步的职责是"这两个数是不是一回事"，
 * 不是"这个数合不合理"。
 */
function numbersMatch(a: Num, allowed: Set<number>): boolean {
  const tol = 0.5 * 10 ** -a.decimals
  for (const b of allowed) {
    if (Math.abs(a.value - b) <= tol) return true
  }
  return false
}

/**
 * 检查一段文本里的数字是不是全部来自上下文。
 *
 * @returns 有问题时返回第一个对不上的数字，全部对得上返回 null
 */
export function unmatchedNumber(text: string, allowed: Set<number>): number | null {
  for (const n of extract(text)) {
    if (!numbersMatch(n, allowed)) return n.value
  }
  return null
}

// ---------------------------------------------------------------------------
// 单条校验
// ---------------------------------------------------------------------------

/** 一条内容被拒的中文原因。null 表示通过 */
type Reject = string | null

function checkText(
  text: string,
  allowed: Set<number>,
  maxChars: number,
  /** 这一条要不要查数值。caveat 是模型自述局限，不该有数字 */
  checkNumbers: boolean,
): Reject {
  if (typeof text !== 'string' || !text.trim()) return '内容为空'
  if (text.length > maxChars) return `超过 ${maxChars} 字`

  const compliance = complianceIssue(text)
  if (compliance) return compliance

  if (checkNumbers) {
    const bad = unmatchedNumber(text, allowed)
    if (bad !== null) return `引用了上下文里没有的数值 ${bad}`
  }

  return null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析并校验模型返回的 JSON 文本。
 *
 * @param raw Edge Function 返回的 assistant 文本（应当是 JSON）
 * @param ctx 发过去的上下文。数值闸门的允许集由它算出来
 */
export function parseAiReply(raw: unknown, ctx: AiContext): AiParseResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) {
    return { analysis: null, dropped: 0, reason: 'AI 没有返回内容' }
  }

  // ---- 闸门 ①：形状 ----
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    // 截断的 JSON 也走这一支。区分"截断"和"格式错"是 Edge Function 的活
    // （它拿得到 finishReason），这里只看结果
    return { analysis: null, dropped: 0, reason: 'AI 返回的不是合法 JSON' }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { analysis: null, dropped: 0, reason: 'AI 返回的不是一个对象' }
  }

  const o = obj as Record<string, unknown>

  if (!Array.isArray(o.points)) {
    return { analysis: null, dropped: 0, reason: 'AI 返回里没有 points 数组' }
  }

  const allowed = allowedNumbers(ctx)
  let dropped = 0

  // ---- summary：单独一条，可以单独被拒 ----
  let summary = ''
  {
    const rawSummary = asString(o.summary)
    // summary 里可以有数字（它通常就是引用了几个关键值），一样要过闸门
    const why = checkText(rawSummary, allowed, MAX_SUMMARY_CHARS, true)
    if (why) dropped++
    else summary = rawSummary.trim()
  }

  // ---- points：逐条过闸门，坏的丢掉，好的留下 ----
  const points: AiPoint[] = []

  for (const item of o.points) {
    if (points.length >= MAX_POINTS) break

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped++
      continue
    }
    const p = item as Record<string, unknown>

    const band = asString(p.band)
    if (!BANDS.includes(band as RiskBand)) {
      dropped++
      continue
    }

    const t = asString(p.text)
    const basis = asString(p.basis)
    const action = asString(p.action)

    // basis 是 AI 声称的依据 —— 没有它这条结论就不该出现（"展开不了依据
    // 的结论出不来"，与规则层的 Finding 同一个要求）
    const why =
      checkText(t, allowed, MAX_POINT_TEXT_CHARS, true) ??
      checkText(basis, allowed, MAX_BASIS_CHARS, true) ??
      checkText(action, allowed, MAX_ACTION_CHARS, true)

    if (why) {
      dropped++
      continue
    }

    points.push({
      text: t.trim(),
      basis: basis.trim(),
      action: action.trim(),
      band: band as RiskBand,
    })
  }

  if (dropped > 0) {
    // 被丢掉的条数必须让界面上能说出来。这里只打日志，界面读 dropped
    console.warn(`[ai] ${dropped} 条未通过校验，已省略`)
  }

  // ---- 全都没了：整篇降级 ----
  if (!points.length && !summary) {
    return {
      analysis: null,
      dropped,
      reason: 'AI 这次给出的内容没有通过校验，已全部丢弃',
    }
  }

  // ---- caveat：模型自述的局限。不查数值（它是元说明，本来就不该带数字）----
  let caveat = ''
  {
    const rawCaveat = asString(o.caveat).trim()
    if (rawCaveat && rawCaveat.length <= MAX_CAVEAT_CHARS) {
      const why = complianceIssue(rawCaveat)
      if (!why) caveat = rawCaveat
    }
  }

  return {
    analysis: { summary, points, caveat },
    dropped,
    reason: null,
  }
}
