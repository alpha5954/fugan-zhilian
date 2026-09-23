// ============================================================================
// AI 结果的本地缓存
// ============================================================================
// 【为什么需要它】
// 一次分析 2~3 秒、而且**按量计费**。而这一页的结果在数据没变时是**确定**的
// —— 同一份上下文算两次，得到的解读本来就该一样。所以刷新一次就重算一次
// 是纯浪费，两页之间各算各的也是。
//
// 存进 localStorage 之后：第一次 2.5 秒，之后**零等待、零成本**。
//
// ============================================================================
// 【为什么键是「上下文全文」而不是哈希】
// ============================================================================
// 上下文本身就是一份规范化排序的 JSON，`JSON.stringify(ctx)` **就是**最准的
// 内容指纹 —— 数据变了它一定变，数据没变它一定不变。
//
// 有人会想存一个短哈希省地方，那要引入一个纯模块依赖、或者用异步的
// `crypto.subtle`。更麻烦的是**碰撞**：撞了就会把另一份数据的 AI 解读
// 显示给当前这份，而且完全看不出来。省几十个字节换这个风险不值得。
//
// 所以 `key` 存全文，读取时**精确比对**。
//
// ============================================================================
// 【为什么这些函数是纯的】
// ============================================================================
// 收发 localStorage 的那两行留在 store 里，这里只做「一段字符串进、一段
// 字符串出」。于是这几条最容易出错的逻辑（格式错、过期、超量）能在 node
// 里直接断言 —— 见 scripts/check-ai.ts 的第 9 节。
//
// 容错方向一律是**当作没有缓存**：读不出来就重算一次，代价是 2.5 秒；
// 而读错了一份缓存的代价是把别人的解读显示出来。
// ============================================================================

import type { AiParseResult } from './aiReply.ts'

/** localStorage 的键。带版本号 —— 改结构时直接换一个，老的自动变成孤儿被清掉 */
export const AI_CACHE_STORAGE_KEY = 'fugan.ai.v1'

/**
 * 最多存几条。
 *
 * 两条 = 概览页 + 数据分析页各一条。再多没有意义：用户的注意力就在这两页，
 * 而每一条都是几 KB 的文本。**必须有上限** —— lib/errorHandlers.ts 里那个
 * 去重 Map 就是因为无界增长出过事，专门写了一个清理循环。
 */
const MAX_ENTRIES = 2

/**
 * 有效期，7 天。
 *
 * ⚠️ 它**不是**用来判断"数据变没变"的 —— 那件事由 `key` 精确负责。
 *    它只负责别让 localStorage 里留着去年的东西。
 *    所以定得宽松没关系，定得太短反而会让用户白等。
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

interface Entry {
  /** 上下文全文（`JSON.stringify(ctx)`） */
  k: string
  value: AiParseResult
  /** 写入时刻，毫秒 */
  at: number
}

/** 把一段字符串解析成条目数组。任何异常都返回空数组 */
function parse(raw: string | null): Entry[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(
      (e): e is Entry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as Entry).k === 'string' &&
        typeof (e as Entry).at === 'number' &&
        !!(e as Entry).value,
    )
  } catch {
    return []
  }
}

/**
 * 取缓存。
 *
 * @param raw         localStorage 里的原始字符串，读不到传 null
 * @param contextKey  当前上下文的全文
 * @returns 命中且未过期时返回解析结果，否则 null
 */
export function readCache(
  raw: string | null,
  contextKey: string,
  now: number = Date.now(),
): AiParseResult | null {
  for (const e of parse(raw)) {
    if (e.k !== contextKey) continue
    if (now - e.at > TTL_MS) return null
    // ⚠️ 只认成功的结果。理论上传不进失败的（写入侧就拦了），但这是
    //    缓存，是**不可信输入** —— 老版本写进来的、或者手改过的都算
    return e.value.analysis ? e.value : null
  }
  return null
}

/**
 * 写缓存，返回**新的**原始字符串（调用方负责 setItem）。
 *
 * 过期的和超量的都在这里清掉，所以存储不会无限增长。
 */
export function writeCache(
  raw: string | null,
  contextKey: string,
  value: AiParseResult,
  now: number = Date.now(),
): string {
  // ★ 失败的结果**绝不入库**。
  //   这是 user.ts 那个 guestPromise 教训的同一件事：一次网络抖动被存下来，
  //   之后每次都会直接命中那个失败，用户再也没有重试的机会。
  //   丢掉的条数不影响 —— 部分成功的解读是有效的，照存
  if (!value.analysis) return raw ?? '[]'

  const kept = parse(raw).filter(
    (e) => e.k !== contextKey && now - e.at <= TTL_MS,
  )

  const next: Entry[] = [{ k: contextKey, value, at: now }, ...kept].slice(
    0,
    MAX_ENTRIES,
  )

  return JSON.stringify(next)
}
