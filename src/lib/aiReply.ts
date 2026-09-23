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
// ⚠️ 数值闸门挡得住什么、挡不住什么
// ============================================================================
// 【结论条目：归属检查】（2026-09-24 起）
// 每条结论必须报出它引用的是哪几条事实（`cites`），数值只在**那几条**里查。
// 所以这两类都挡得住：
//   ✓ 凭空编出来的测量值（角度、温度、百分比、次数）
//   ✓ **张冠李戴** —— 引用一条讲角度的事实、正文里却写皮温，当场被拒
//
// 【摘要：仍是全局一致性检查】
// 摘要是跨事实的总述，没法绑到某一条引用上，所以它比对的是整个上下文。
// 于是**摘要里的张冠李戴仍然可能**（这是本模块剩下最主要的缺口）。
//
// 【两类都挡不住的】
//   ✗ 整句不带数字的定性断言
//   ✗ 方向词写反（数据回落却写"进步"）
//   ✗ 中文数词编造（「连续七天」里没有阿拉伯数字，正则看不见）
//   ✗ 上下文根本没包含的指标
//
// 所以**界面上只能写「由 AI 生成」**，绝不能写「数据已核对」或「已合规
// 校验」。那是把一个尽力而为的过滤器说成了保证。
// ============================================================================

import { complianceIssue } from './compliance.ts'
import type { AiContext, AiFact } from './aiContext.ts'
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
 * ⚠️ 但 `basis` 和 `Finding.evidence` 有一处**本质**区别，别把它们当成
 *    一回事：`evidence` 是系统算出来的，而 `basis` 是**由被引用的事实
 *    拼出来的**（模型只报了编号，正文不是它写的）。所以 `basis` 里的数字
 *    一定出自我们自己的计算 —— 这正是事实编号制要买到的东西。
 */
export interface AiPoint {
  /** 结论。主语应当是「数据/训练」，不是「患者」 */
  text: string
  /**
   * 依据。**由 `cites` 指向的事实文本拼成，不是模型写的。**
   *
   * 模型返回的原始回复里没有这个字段 —— 只有 `cites`。
   */
  basis: string
  /**
   * 这条结论引用了哪几条事实（`F1`、`F3`…）。
   *
   * 保留下来是为了**可追溯**：出问题时能一眼看出它指的是哪几条计算项。
   * 界面不显示编号（家属读着是噪音），但数据里留着。
   */
  cites: string[]
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

/**
 * 一次追问的回答。
 *
 * ============================================================================
 * 【为什么 decline 是一等公民，而不是"失败"】
 * ============================================================================
 * 家属会问「我妈是不是得了关节炎」。这时候**正确的行为是拒答**，而不是
 * 让合规闸门把它当垃圾丢掉 —— 后者在界面上表现成"AI 出错了"，用户会
 * 换个说法再问一遍。
 *
 * 所以「答不了」有它自己的字段和它自己的界面样式（一句中性说明，不是红色
 * 报错）。于是它成了**可以断言的行为**：
 *
 *   喂一个问题要求诊断 → answer 必须是空、decline 必须非空
 *
 * 而不是一句写在提示词里、没人验的君子协定。
 * ============================================================================
 */
export interface AiAnswer {
  /** 用户问的原话 */
  question: string
  /** 回答正文。**答不了时是空串** */
  answer: string
  /** 答不了时的一句说明（为什么答不了）。**答得了时是空串** */
  decline: string
  /** 回答里用到的数字来自哪几条事实 */
  cites: string[]
  /**
   * 依据。和 `AiPoint.basis` 一样，**由 `cites` 指向的事实原文拼成**，
   * 模型碰不到。拒答时为空串（没有依据可给）。
   */
  basis: string
  /** 模型自述的局限 */
  caveat: string
}

export interface AiAskResult {
  /** 校验通过的回答。没通过时为 null */
  answer: AiAnswer | null
  /** 没通过时的中文原因 */
  reason: string | null
}

export interface AiParseResult {
  /** 通过校验的内容。全部被拒时为 null */
  analysis: AiAnalysis | null
  /** 被丢掉的条目数（含 summary）。界面要如实显示 */
  dropped: number
  /**
   * 每一条被丢掉的原因。
   *
   * ⚠️ **排查时全靠它。** 只给一个数字的话，「模型变差了」和「闸门写严了」
   *    这两件事分不出来 —— 而它们的修法完全相反：前者要改提示词，后者
   *    要改闸门。scripts/try-ai.ts 打真实调用时会把它逐条打出来。
   *
   * 界面**不显示**这个（家属读"引用了上下文里没有的数值 87.3"没有意义），
   * 只显示条数。
   */
  droppedReasons: string[]
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
const MAX_ACTION_CHARS = 120
const MAX_CAVEAT_CHARS = 200
/** 提示词要求最多 3 条，这里留一条余量 */
const MAX_POINTS = 4

/**
 * 一条结论最多能引用几条事实。
 *
 * 上限管两件事：界面上的「依据」那一行不能长到读不下去
 * （4 条 × 约 45 字 ≈ 180 字），以及提示词里那句"不超过 4 条"有个可执行的兜底。
 *
 * ⚠️ 从 3 提到 4 是**实测之后**改的。原来定 3，而 demo 数据里那条
 *    「安全事件导致评分下调」同时用到了评分、事件、下调幅度三处信息，
 *    模型报了 3 条却漏了装 78 分的那条 → 被闸门拒。
 *    上限太紧的代价不是"少写点"，是**整条结论作废**。
 */
const MAX_CITES = 4

const BANDS: readonly RiskBand[] = ['green', 'yellow', 'red']

// ---------------------------------------------------------------------------
// 追问的上下限
// ---------------------------------------------------------------------------

/** 问题长度上限。**这个是给输入框用的**，界面要按它做 maxlength */
export const MAX_QUESTION_CHARS = 200

/** 回答正文上限 */
const MAX_ANSWER_CHARS = 400

/** 拒答说明上限。短，因为它就是一句话 */
const MAX_DECLINE_CHARS = 120

/**
 * 带几轮历史。
 *
 * ⚠️ 每一轮都要重发**全部**历史（和整份上下文），所以它直接乘在 token 成本上。
 *    3 轮 ≈ 多 600~900 token。再多就该考虑把历史压缩成摘要了 —— 但现在
 *    "家长里短问两句"也就两三轮，不值得为它引入一个摘要步骤。
 */
export const MAX_HISTORY_TURNS = 3

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
/** 把一处内容里的数字都收进集合。两处调用（全局、按引用）共用同一套规则 */
function collect(v: unknown, into: Set<number>): void {
  const add = (n: number) => {
    if (!Number.isFinite(n)) return
    into.add(n)
    // 小数 → 百分数形式。只在这一侧展开，理由见 allowedNumbers 的注释
    if (n > 0 && n < 1) into.add(Number((n * 100).toFixed(1)))
  }

  const walk = (x: unknown): void => {
    if (typeof x === 'number') add(x)
    else if (typeof x === 'string') for (const n of extract(x)) add(n.value)
    else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }

  walk(v)
}

export function allowedNumbers(ctx: AiContext): Set<number> {
  const allowed = new Set<number>()
  collect(ctx, allowed)
  return allowed
}

/**
 * **只看被引用的那几条事实**能出现的数字。
 *
 * ============================================================================
 * 【这条函数就是「事实编号制」的全部意义】
 * ============================================================================
 * 原来一条结论的数值闸门是拿**整个上下文**比对的：只要这个数在上下文里
 * 任何地方出现过就放行。于是下面的情况会漏过去 ——
 *
 *   上下文里同时有 `坐位伸膝 实测 80.4°` 和 `坐位伸膝 实测 72.2`，
 *   模型写「皮温 80.4 °C」，闸门**放行**，因为 80.4 确实出现过。
 *
 * 现在模型必须报出它引用的是哪几条事实（`cites`），我们就只拿那几条里的
 * 数字跟它的正文比。上面那个例子会当场被拒 —— 引用的是一条讲角度的事实，
 * 而 80.4 不在那条里。
 *
 * 也就是说：闸门从**一致性检查**（这个数出现过吗）升级成了**归属检查**
 * （这个数属于你引用的这件事吗）。这是原来文档里明写"挡不住"的第一条。
 * ============================================================================
 */
export function allowedNumbersForFacts(
  ctx: AiContext,
  ids: readonly string[],
): Set<number> {
  const byId = new Map(ctx.facts.map((f) => [f.id, f]))
  const allowed = new Set<number>()
  for (const id of ids) {
    const fact = byId.get(id)
    if (fact) collect(fact.text, allowed)
  }
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
  const fail = (reason: string): AiParseResult => ({
    analysis: null,
    dropped: 0,
    droppedReasons: [],
    reason,
  })

  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return fail('AI 没有返回内容')

  // ---- 闸门 ①：形状 ----
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    // 截断的 JSON 也走这一支。区分"截断"和"格式错"是 Edge Function 的活
    // （它拿得到 finishReason），这里只看结果
    return fail('AI 返回的不是合法 JSON')
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail('AI 返回的不是一个对象')
  }

  const o = obj as Record<string, unknown>

  if (!Array.isArray(o.points)) return fail('AI 返回里没有 points 数组')

  const allowed = allowedNumbers(ctx)
  const droppedReasons: string[] = []

  // ---- summary：单独一条，可以单独被拒 ----
  let summary = ''
  {
    const rawSummary = asString(o.summary)
    // summary 里可以有数字（它通常就是引用了几个关键值），一样要过闸门
    const why = checkText(rawSummary, allowed, MAX_SUMMARY_CHARS, true)
    if (why) droppedReasons.push(`摘要：${why}`)
    else summary = rawSummary.trim()
  }

  // ---- points：逐条过闸门，坏的丢掉，好的留下 ----
  const factById = new Map(ctx.facts.map((f) => [f.id, f]))
  const points: AiPoint[] = []

  for (const item of o.points) {
    if (points.length >= MAX_POINTS) break

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      droppedReasons.push('有一条不是一个对象')
      continue
    }
    const p = item as Record<string, unknown>
    // 用正文开头当标签 —— 排查时"是哪一条"比"第几条"有用得多
    const tag = asString(p.text).slice(0, 18) || '（无正文）'

    const band = asString(p.band)
    if (!BANDS.includes(band as RiskBand)) {
      droppedReasons.push(`「${tag}」band 非法：${band || '缺'}`)
      continue
    }

    // ★ 引用。模型只能报编号，依据那一行它碰不到
    const cites = Array.isArray(p.cites)
      ? p.cites
          .filter((c): c is string => typeof c === 'string')
          .slice(0, MAX_CITES)
      : []

    if (!cites.length) {
      // 一条结论必须能指到具体的事实上。指不到就不该出现 ——
      // 与规则层的 Finding 同一个要求（"展开不了依据的结论出不来"）
      droppedReasons.push(`「${tag}」没有报 cites`)
      continue
    }

    const cited: AiFact[] = []
    for (const id of cites) {
      const fact = factById.get(id)
      if (fact) cited.push(fact)
    }
    if (cited.length !== cites.length) {
      // 报了一个不存在的编号 —— 这是编造，不是疏忽。整条丢掉
      droppedReasons.push(`「${tag}」引用了不存在的事实：${cites.join(',')}`)
      continue
    }

    // ★ 依据由**我们**渲染。模型的原始文本进不了这一行。
    //
    // ⚠️ 分隔符不能用「；」—— 事实文本自己就含分号（规则层的 evidence 里
    //    那种「直腿抬高 9.3° → 11.4°；坐位伸膝 60.4° → 72.9°」），
    //    拼起来分不清哪里是一条事实的结尾。用全角竖线当中缝。
    const basis = cited.map((f) => f.text).join(' ｜ ')

    // ★ 数值闸门收紧到「你引用的那几条事实里」。理由见 allowedNumbersForFacts
    const scoped = allowedNumbersForFacts(ctx, cited.map((f) => f.id))

    const t = asString(p.text)
    const action = asString(p.action)

    const why =
      checkText(t, scoped, MAX_POINT_TEXT_CHARS, true) ??
      checkText(action, scoped, MAX_ACTION_CHARS, true)

    if (why) {
      droppedReasons.push(`「${tag}」${why}（引用了 ${cites.join(',')}）`)
      continue
    }

    points.push({
      text: t.trim(),
      basis,
      cites: cited.map((f) => f.id),
      action: action.trim(),
      band: band as RiskBand,
    })
  }

  // ---- 全都没了：整篇降级 ----
  if (!points.length && !summary) {
    return {
      analysis: null,
      dropped: droppedReasons.length,
      droppedReasons,
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
    dropped: droppedReasons.length,
    droppedReasons,
    reason: null,
  }
}

// ---------------------------------------------------------------------------
// 追问（多轮）
// ---------------------------------------------------------------------------
//
// 与上面那次分析共用同一份 facts 和三道闸门，只有两点不同：
//
//   ① 多了一个 `decline` 出口 —— **答不了是一等公民，不是失败**（见 AiAnswer）
//   ② 校验的对象是「回答」，不是「结论」—— 它不需要 band，也不需要 action
//
// ⚠️ **用户的问题本身不过合规闸门。** 「我妈是不是得了关节炎」这句里带病名，
//    但那是用户说的，不是我们说的 —— 拦下来才是错的（拦下来家属只会换个
//    说法再问一遍）。正确的处理是**让它答**，然后由回答里的 decline 出口
//    拒掉。所以问题只限长度，不限内容。

/**
 * 解析并校验一次追问的回答。
 *
 * @param raw      模型返回的文本（应当是 JSON）
 * @param ctx      与那次分析**同一份**上下文。事实清单必须一致，
 *                 否则模型报的编号对不上
 * @param question 用户问的原话（会被裁到 MAX_QUESTION_CHARS）
 */
export function parseAiAsk(
  raw: unknown,
  ctx: AiContext,
  question: string,
): AiAskResult {
  const fail = (reason: string): AiAskResult => ({ answer: null, reason })

  const q = question.trim().slice(0, MAX_QUESTION_CHARS)
  if (!q) return fail('问题为空')

  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return fail('AI 没有返回内容')

  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return fail('AI 返回的不是合法 JSON')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail('AI 返回的不是一个对象')
  }

  const o = obj as Record<string, unknown>
  const rawAnswer = asString(o.answer).trim()
  const decline = asString(o.decline).trim()

  // 两个都空说明它什么也没给 —— 这不是"拒答"，是没答
  if (!rawAnswer && !decline) return fail('AI 既没有回答也没有说明')

  // ---- 出口①：拒答 ----
  //
  // 两个字段都填了的话按**保守**的那边读：它说答不了，那就是答不了
  if (decline) {
    if (decline.length > MAX_DECLINE_CHARS) return fail('拒答说明过长')

    // ⚠️ 拒答说明**照样过合规闸门**，但用 `inDecline` 那一档：
    //    禁病名，**放行治疗方案的类别词**。
    //
    //    这个区分是打真实接口试出来的 —— 模型正确拒答时写的是
    //    「用药问题需要由医生判断」，而一刀切的禁词表把「用药」拦下来，
    //    于是**一次正确的拒答被丢掉**，界面上表现成"AI 出错了"。
    //    拒答本身是安全动作，丢掉它比放过一个类别词糟得多。
    //    但「不能判断是不是关节炎」仍然要拦 —— 那是具体病名。
    const why = complianceIssue(decline, { inDecline: true })
    if (why) return fail(`拒答说明本身越界：${why}`)

    return {
      answer: { question: q, answer: '', decline, cites: [], basis: '', caveat: '' },
      reason: null,
    }
  }

  // ---- 出口②：回答 ----
  const cites = Array.isArray(o.cites)
    ? o.cites
        .filter((c): c is string => typeof c === 'string')
        .slice(0, MAX_CITES)
    : []
  if (!cites.length) return fail('回答没有报 cites —— 说不出依据的答案不该显示')

  const factById = new Map(ctx.facts.map((f) => [f.id, f]))
  const cited: AiFact[] = []
  for (const id of cites) {
    const fact = factById.get(id)
    if (fact) cited.push(fact)
  }
  if (cited.length !== cites.length) {
    return fail(`引用了不存在的事实：${cites.join(',')}`)
  }

  // 数值闸门同样收紧到「你引用的那几条」。追问这条路径和结论那条一样严。
  //
  // ⚠️ 失败原因里要**带上它引用的是哪几条** —— 不带的话只知道"某个数字
  //    不对"，不知道是"数字编的"还是"引用漏了一条"。这两种的修法完全相反：
  //    前者要改提示词，后者要补引用。结论那条路径也是这么做的。
  const scoped = allowedNumbersForFacts(ctx, cited.map((f) => f.id))
  const why = checkText(rawAnswer, scoped, MAX_ANSWER_CHARS, true)
  if (why) return fail(`回答${why}（引用了 ${cites.join(',')}）`)

  let caveat = ''
  {
    const c = asString(o.caveat).trim()
    if (c && c.length <= MAX_CAVEAT_CHARS && !complianceIssue(c)) caveat = c
  }

  return {
    answer: {
      question: q,
      answer: rawAnswer,
      decline: '',
      cites: cited.map((f) => f.id),
      basis: cited.map((f) => f.text).join(' ｜ '),
      caveat,
    },
    reason: null,
  }
}
