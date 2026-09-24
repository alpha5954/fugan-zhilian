<script setup lang="ts">
// ============================================================================
// AI 深度分析面板
// ============================================================================
// 概览页与数据分析页共用。放在规则结论**旁边**，不混进去。
//
// 【为什么强调"不混进去"】
// 规则结论是这个系统的立身之本 —— 每一条都能展开讲清依据、答辩时经得起
// 追问。AI 那段话是**另一回事**：它能说出规则层没说的东西，但那种话的
// 依据是模型生成的，不能和可核对的结论长成一个样子。
//
// 所以：共用 FindingCard 的视觉语言（不新做一套，免得同一个东西在两处
// 看起来是两个等级），但**外壳、来源标签、标题全部区分开**。用户要能一眼
// 看出"这块是模型说的"。
//
// ============================================================================
// 【按需触发，不在挂载时自动调用】
// ============================================================================
// 一次调用 5~20 秒而且按量计费。挂载就跑的话，每次打开页面都要等、都要花钱，
// 而多数时候用户并不想看这段。所以是一个按钮。
//
// ============================================================================
// ⚠️ 打印规则必须写在这个组件自己的 scoped style 里
// ============================================================================
// 分析页的 `.no-print` 定义在 Analysis.vue 的 <style scoped> 里，编译出来是
// `.no-print[data-v-父]`。**子组件模板里的元素拿不到父组件的 data-v**，
// 所以那条规则对这里面的元素根本不匹配 —— AI 内容会直接印进导出的 PDF。
//
// 靠给组件写 class 让它透传到根节点能侥幸生效，但多根节点或 inheritAttrs
// 一改就静默失效，而且只有打开打印预览才看得见。所以自带一份。
//
// 顺带一个决定：**v1 的 AI 内容不进 PDF**。那份 PDF 是要递出去的，把未经
// 核验的模型输出印在一份给临床医生看的报告里，正是 lib/findings.ts 那段
// 合规边界存在的理由。
// ============================================================================
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Info, Lock, RefreshCw, Sparkles } from 'lucide-vue-next'

import FindingCard from './FindingCard.vue'
import { useAiStore } from '@/stores/ai'
import type { AiContext } from '@/lib/aiContext'
import { BASIS_SEPARATOR, MAX_QUESTION_CHARS } from '@/lib/aiReply'
import type { FindingLike } from '@/lib/findings'

const props = defineProps<{
  /** 页面正在显示的那份数据构造出来的上下文。数据还没到位时为 null */
  context: AiContext | null
}>()

const ai = useAiStore()

/**
 * 展开状态。**默认展开**，用户点了才收起来。
 *
 * ⚠️ 这里原来有一个 `defaultOpen` 属性，概览页传 false（默认折叠），
 *    理由是"避免误触计费"。**那个理由站不住**：展开只是把按钮显示出来，
 *    分析仍然是点了才跑 —— 展开不发请求、不花钱（挂载时的 `ai.restore`
 *    只读本地缓存）。当时把"展开"和"触发"混为一谈了。
 *
 *    折叠真正的代价是功能藏在一个要点的箭头后面，而**没有人会去点一个
 *    自己不知道存在的按钮**。
 *
 *    属性一并删掉了 —— 两个页面都要展开，留着一个没人传的开关只会让
 *    下一个读代码的人以为它有用途。
 */
const open = ref(true)

// ---------------------------------------------------------------------------
// 等待秒数
// ---------------------------------------------------------------------------
// 10~20 秒没有任何反馈的按钮，用户会读成"坏了"，然后反复点。
// 所以把已经等了几秒显示出来 —— 这个项目的品味是"不做流光扫过"（那类动画
// 在医疗界面上显得轻浮），显示一个诚实的秒数更合适。
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

watch(
  () => ai.loading,
  (busy) => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (!busy) return
    elapsed.value = 0
    timer = setInterval(() => (elapsed.value += 1), 1000)
  },
)

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  // 刻意**不**取消请求：请求归 store 所有，已经发出去了、钱已经花了。
  // 取消只会让人回来时白等一次
})

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 当前上下文对应的 key。
 *
 * 与 store 里的算法保持一致（JSON 字符串就是 key）。用来判断"现在展示的
 * 结果是不是这一份数据的" —— 换了筛选窗口之后，上一份结果不能继续挂在
 * 下面冒充当前窗口的结论。
 */
const currentKey = computed(() => (props.context ? JSON.stringify(props.context) : null))

const showResult = computed(
  () => !!ai.result && ai.resultKey === currentKey.value && !!ai.analysis,
)

/** 结果里的条目换到 FindingCard 认识的字段名 */
const points = computed<FindingLike[]>(() =>
  (ai.analysis?.points ?? []).map((p) => ({
    label: p.text,
    band: p.band,
    // ⚠️ 这里是从 basis 换名过来的 —— 它是 **AI 声称的**依据，
    //    不是系统算出来的 evidence。字段名刻意不同，就是为了不让人
    //    在代码里把两者当成一回事
    evidence: p.basis,
    action: p.action,
  })),
)

const canRun = computed(() => !!props.context && ai.access.allowed)

function run(): void {
  if (!props.context || ai.loading) return
  void ai.analyze(props.context)
}

/**
 * 「重新生成」。
 *
 * ⚠️ 必须 `refresh: true` 绕过缓存 —— 否则用户点了"重新生成"却拿回
 *    一模一样的那段话，只会以为按钮坏了。**刷新一次就是一次计费**，
 *    所以这一下要真的是新的一次请求。
 */
function regenerate(): void {
  if (!props.context || ai.loading) return
  void ai.analyze(props.context, { refresh: true })
}

// ---------------------------------------------------------------------------
// 恢复上次的结果
// ---------------------------------------------------------------------------
// ⚠️ 这**不是**自动调用（自动调用每次打开页面都要等 2.5 秒、还要计费），
//    而是"只查缓存"：命中就把上次算好的直接摆出来，不命中什么都不做。
//    结果是第一次 2.5 秒，之后打开页面**立刻就有**。
//
// 换了窗口 / 换了查看对象时，restore 会把上一份结果清掉 —— 不清的话
// 下面挂着的就是另一段时间、另一个人的解读。见 stores/ai.ts 的注释。
onMounted(() => ai.restore(props.context))

watch(
  () => currentKey.value,
  () => {
    // 请求正在飞的时候不要清 —— 那个结果马上就到了
    if (!ai.loading) ai.restore(props.context)
  },
)

// ---------------------------------------------------------------------------
// 追问
// ---------------------------------------------------------------------------

const draft = ref('')
const canAsk = computed(
  () =>
    !!props.context &&
    showResult.value &&
    !ai.asking &&
    draft.value.trim().length > 0,
)

/**
 * 依据拆成逐条。理由同 FindingCard —— 拼成一整行读不下去。
 * 分隔符用的是 aiReply 里那个常量，两边不会漂。
 */
function basisParts(basis: string): string[] {
  return basis ? basis.split(BASIS_SEPARATOR).filter(Boolean) : []
}

async function send(): Promise<void> {
  if (!props.context || !canAsk.value) return

  const q = draft.value.trim()
  const before = ai.turns.length

  // 先清空输入框是聊天的常规手感。失败了再放回去 ——
  // 让用户重打一遍自己刚写的问题是最没必要的一种刁难
  draft.value = ''
  await ai.ask(props.context, q)
  if (ai.turns.length === before) draft.value = q
}
</script>

<template>
  <section class="ai" :class="{ 'ai--open': open }">
    <header class="ai__head">
      <button
        type="button"
        class="ai__toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        <Sparkles class="ai__icon" aria-hidden="true" />
        <span class="ai__title">AI 深度分析</span>
        <span class="ai__tag">AI 生成</span>
        <span class="ai__chev">{{ open ? '收起' : '展开' }}</span>
      </button>
      <span class="ai__window">
        {{ context ? `${context.window} · 由模型解读，非系统结论` : '数据加载中' }}
      </span>
    </header>

    <template v-if="open">
      <!-- ============ 还没开放（将来收费后的状态） ============
           这一态现在就写。等上线付费再补的话，界面会先经历一段
           "点了没反应"的时间，而那时候已经不能改了 -->
      <div v-if="!ai.access.allowed" class="ai__upsell">
        <Lock class="ai__upsell-icon" aria-hidden="true" />
        <p class="ai__upsell-text">{{ ai.access.reason }}</p>
      </div>

      <!-- ============ 未触发 / 加载中 ============ -->
      <div v-else-if="!showResult" class="ai__actions">
        <el-button
          type="primary"
          :loading="ai.loading"
          :disabled="!canRun"
          @click="run"
        >
          {{ ai.loading ? `正在分析…已等待 ${elapsed} 秒` : '用 AI 深入分析' }}
        </el-button>

        <p class="ai__hint">
          <Info class="ai__hint-icon" aria-hidden="true" />
          系统会把聚合后的训练指标发送给 AI 服务用于本次分析。约需 5~10 秒。
        </p>
      </div>

      <!-- ============ 失败 ============ -->
      <div v-if="ai.error && !ai.loading" class="ai__error">
        <p class="ai__error-text">{{ ai.error }}</p>
        <el-button size="small" @click="run">
          <RefreshCw class="ai__btn-icon" aria-hidden="true" />
          重试
        </el-button>
        <p class="ai__hint">
          这一块不影响上面的评估结论 —— 那些由系统按规则算出，始终可用。
        </p>
      </div>

      <!-- ============ 结果 ============ -->
      <div v-if="showResult" class="ai__body">
        <p v-if="ai.analysis?.summary" class="ai__summary">
          {{ ai.analysis.summary }}
        </p>

        <div v-if="points.length" class="ai__points">
          <!-- source="ai" → 左条画成点状，和规则结论区分开。
               理由见 FindingCard 里 .finding--ai 那段 -->
          <FindingCard v-for="(p, i) in points" :key="i" :finding="p" source="ai" />
        </div>

        <!-- 被闸门丢掉的条数要如实说。静默丢弃等于悄悄换了一份数据给用户看 -->
        <p v-if="ai.dropped > 0" class="ai__hint">
          <Info class="ai__hint-icon" aria-hidden="true" />
          另有 {{ ai.dropped }} 条未通过数值与措辞校验，已省略。
        </p>

        <p v-if="ai.analysis?.caveat" class="ai__caveat">{{ ai.analysis.caveat }}</p>

        <div class="ai__foot">
          <p class="ai__source">
            以上由 AI 依据系统已算出的指标生成，<strong>不是</strong>系统的评估结论
            —— 它未经临床核验，请以规则结论与治疗师意见为准。
          </p>
          <!-- 演示数据要**双重**标注：数据本身是模拟的，解读又是模型生成的 -->
          <p v-if="context?.demo" class="ai__demo">
            本次分析所用的数据为演示数据。
          </p>
          <!-- 重新生成 = 再花一次钱。所以它绕开缓存，见 regenerate 的注释 -->
          <el-button size="small" text @click="regenerate">重新生成</el-button>
        </div>
      </div>

      <!-- ============ 追问 ============ -->
      <!-- 只在**已经有分析结果**之后才出现。没有事实清单就没有可追问的依据，
           问了也只能得到模型凭常识编的东西 -->
      <div v-if="showResult" class="ask">
        <ul v-if="ai.turns.length" class="asklist">
          <li v-for="(t, i) in ai.turns" :key="i" class="asklist__item">
            <p class="asklist__q">{{ t.question }}</p>

            <p v-if="t.answer" class="asklist__a">{{ t.answer }}</p>

            <!-- ⚠️ 拒答**不是错误样式**。它是这套东西刻意设计的一个出口 ——
                 涉及疾病判断的问题就该明说答不了，而不是绕着答。
                 用红色报错的样子显示它，用户会以为系统坏了、然后换个说法再问 -->
            <p v-else class="asklist__decline">
              <Info class="asklist__icon" aria-hidden="true" />
              {{ t.decline }}
            </p>

            <div v-if="t.basis" class="asklist__basis">
              <span class="asklist__basis-label">依据</span>
              <ul class="asklist__basis-list">
                <li v-for="(line, j) in basisParts(t.basis)" :key="j">{{ line }}</li>
              </ul>
            </div>
          </li>
        </ul>

        <div class="askbar">
          <el-input
            v-model="draft"
            :maxlength="MAX_QUESTION_CHARS"
            placeholder="就这份数据问一句，例如「下周该加量吗」"
            :disabled="ai.asking"
            @keyup.enter="send"
          />
          <el-button
            type="primary"
            :loading="ai.asking"
            :disabled="!canAsk"
            @click="send"
          >
            追问
          </el-button>
        </div>

        <p v-if="ai.askError" class="ask__error">{{ ai.askError }}</p>

        <p class="ai__hint">
          <Info class="ai__hint-icon" aria-hidden="true" />
          只依据上面这份数据回答。涉及疾病判断、用药、手术的问题它会明说答不了
          —— 那是设计如此，不是出错。
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ai {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
  /* 比规则结论的面板淡一档 —— 视觉上它就不是主角 */
  background: var(--surface-sunken);
}

.ai__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ai__toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
}

.ai__icon {
  width: 15px;
  height: 15px;
  color: var(--brand-700);
}

.ai__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-800);
}

.ai__tag {
  padding: 1px 6px;
  border-radius: var(--r-full);
  background: var(--brand-50);
  border: 1px solid var(--brand-200);
  font-size: var(--fs-micro);
  color: var(--brand-700);
}

.ai__chev {
  font-size: 12px;
  color: var(--ink-300);
}

.ai__window {
  font-size: 12px;
  color: var(--ink-300);
}

.ai__actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.ai__hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-300);
}

.ai__hint-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-top: 2px;
}

.ai__btn-icon {
  width: 13px;
  height: 13px;
  margin-right: 4px;
}

.ai__error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.ai__error-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--danger);
}

.ai__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai__summary {
  margin: 0;
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  color: var(--ink-700);
}

.ai__points {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai__caveat {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-400);
}

.ai__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.ai__source {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--ink-300);
}

.ai__demo {
  margin: 0;
  font-size: 11px;
  color: var(--warn);
}

.ai__upsell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai__upsell-icon {
  width: 15px;
  height: 15px;
  color: var(--ink-400);
}

.ai__upsell-text {
  margin: 0;
  font-size: 13px;
  color: var(--ink-500);
}

/* ---- 追问 ---- */

.ask {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.asklist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.asklist__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.asklist__q {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--ink-700);
}

/* 前缀标出哪句是问的 —— 一问一答挨着放，不加标记容易读混 */
.asklist__q::before {
  content: '问 ';
  color: var(--ink-300);
}

.asklist__a {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  color: var(--ink-800);
}

/* ⚠️ 拒答用**中性**样式，不是报错的红色。理由见模板里那段注释 */
.asklist__decline {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: var(--fs-sm);
  line-height: var(--lh-base);
  color: var(--ink-500);
}

.asklist__icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-top: 3px;
}

.asklist__basis {
  display: flex;
  gap: 6px;
  margin: 3px 0 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--ink-400);
}

.asklist__basis-label {
  flex-shrink: 0;
  color: var(--ink-300);
}

.asklist__basis-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.asklist__basis-list li {
  position: relative;
  padding-left: 10px;
}

.asklist__basis-list li::before {
  content: '·';
  position: absolute;
  left: 0;
  color: var(--ink-300);
}

.askbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.askbar :deep(.el-input) {
  flex: 1;
}

.ask__error {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-base);
  color: var(--danger);
}

/* ============================================================================
   打印：整块不进报告
   ============================================================================
   ⚠️ 这条规则**必须**留在这个组件的 scoped style 里。分析页的 .no-print
      在父组件的 scoped CSS 里，编译成 .no-print[data-v-父]，对这里的元素
      不匹配 —— 靠 class 透传能侥幸生效，但一改根节点就静默失效。
      理由见文件头。 */
@media print {
  .ai {
    display: none !important;
  }
}
</style>
