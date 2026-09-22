<script setup lang="ts">
// ============================================================================
// 移动端底部导航
// ============================================================================
// 家属大概率用手机看，而顶部那行导航在手机上是要命的：
// 八个项挤在一行里横向滚动，「关于」直接在屏幕外，没人会想到去横滑顶栏。
//
// 底下放最常用的三个 + 一个「更多」，其余收进抽屉。
//
// 【为什么是这三个】
//   概览   —— 打开就想知道"恢复得怎么样"
//   监测   —— 第二个位置，家属最容易在训练时点进去
//   预警   —— 安全相关，且要能看到未处理的角标
// 康复评估、数据分析、设备、监护、关于都放抽屉里 —— 它们不是"每次打开都要看"的。
//
// 只在窄屏显示。宽屏用顶部那行，横向空间够，没必要占一条底边。
// ============================================================================
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { useAlertStore } from '@/stores/alert'
import { useCareStore } from '@/stores/care'

const route = useRoute()
const router = useRouter()
const alerts = useAlertStore()
const care = useCareStore()

/**
 * 底部三个主 tab。
 *
 * icon 是 SVG 路径的 d 属性，几条子路径拼在一个字符串里 ——
 * 这样四个图标能走同一段模板，不用为每个写一份标记。
 */
const TABS = [
  { path: '/dashboard', label: '概览', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
  { path: '/monitor', label: '实时监测', icon: 'M2 12h4l3-7 3 14 3-7h5' },
  {
    path: '/alerts',
    label: '预警',
    icon: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0',
  },
] as const

/** 「更多」抽屉里的项 */
const MORE = [
  { path: '/assessment', label: '康复评估', desc: '记录一次训练并评估' },
  { path: '/analysis', label: '数据分析', desc: '活动度趋势与达标情况' },
  { path: '/devices', label: '我的设备', desc: '绑定传感器、查看状态' },
  { path: '/care', label: '监护管理', desc: '家属远程查看与邀请码' },
  { path: '/about', label: '关于', desc: '项目介绍与传感器参数' },
] as const

const moreOpen = ref(false)

/** 当前标签高亮。用前缀匹配，子路由也能点亮 */
function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`)
}

/**
 * 「更多」是否高亮。
 *
 * 当前页在抽屉里时也要亮 —— 否则用户在「康复评估」页上，
 * 底部四个 tab 一个都不亮，会以为自己不在导航体系里。
 */
const moreActive = computed(() => MORE.some((m) => isActive(m.path)))

const alertBadge = computed(() => alerts.unacknowledgedTotal)

function go(path: string) {
  moreOpen.value = false
  void router.push(path)
}
</script>

<template>
  <nav class="tabbar" aria-label="主导航">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.path"
      :to="tab.path"
      class="tabbar__item"
      :class="{ 'is-active': isActive(tab.path) }"
    >
      <span class="tabbar__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path :d="tab.icon" />
        </svg>
      </span>
      <span class="tabbar__label">{{ tab.label }}</span>
      <span v-if="tab.path === '/alerts' && alertBadge > 0" class="tabbar__badge">
        {{ alertBadge > 99 ? '99+' : alertBadge }}
      </span>
    </RouterLink>

    <button
      type="button"
      class="tabbar__item"
      :class="{ 'is-active': moreActive || moreOpen }"
      @click="moreOpen = true"
    >
      <span class="tabbar__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </span>
      <span class="tabbar__label">更多</span>
    </button>
  </nav>

  <!-- 抽屉从底部升起，不跳页。列表带一句说明 ——
       光看「监护管理」四个字，家属不知道那是干什么的 -->
  <el-drawer
    v-model="moreOpen"
    direction="btt"
    size="auto"
    :with-header="false"
    class="more-drawer"
  >
    <ul class="more">
      <li v-for="item in MORE" :key="item.path">
        <button type="button" class="more__item" @click="go(item.path)">
          <span class="more__text">
            <span class="more__label">{{ item.label }}</span>
            <span class="more__desc">{{ item.desc }}</span>
          </span>
          <span v-if="item.path === '/care' && care.pendingCount > 0" class="more__badge">
            {{ care.pendingCount }}
          </span>
          <span class="more__arrow" aria-hidden="true">›</span>
        </button>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
/* 只在窄屏出现。宽屏横向空间够，顶部那行更好用，
   没必要再占一条底边 */
.tabbar {
  display: none;
}

@media (max-width: 768px) {
  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 200;
    display: flex;
    background: var(--surface);
    border-top: 1px solid var(--line);
    /* iPhone 底部那条横杠的区域要留出来，否则最后一行会被挡住 */
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .tabbar__item {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    /* 触控目标。底部导航是手机上的主要入口，做小了会频繁点错 */
    min-height: 56px;
    padding: 6px 0;
    border: none;
    background: transparent;
    font-family: inherit;
    color: var(--ink-400);
    text-decoration: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .tabbar__item:hover {
    text-decoration: none;
  }

  .tabbar__item.is-active {
    color: var(--brand-700);
  }

  .tabbar__icon {
    display: block;
    width: 22px;
    height: 22px;
  }

  .tabbar__icon svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .tabbar__label {
    font-size: var(--fs-micro);
    line-height: 1.2;
  }

  .tabbar__item.is-active .tabbar__label {
    font-weight: var(--fw-medium);
  }

  /* 未处理预警的角标。绝对定位在图标右上角，不参与文字排版 */
  .tabbar__badge {
    position: absolute;
    top: 4px;
    left: 50%;
    margin-left: 4px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: var(--r-full);
    background: var(--danger);
    color: #fff;
    font-size: var(--fs-micro);
    line-height: 16px;
    font-weight: var(--fw-medium);
    text-align: center;
  }
}

/* ---------- 更多抽屉 ---------- */
.more {
  margin: 0;
  padding: var(--sp-2) 0;
  list-style: none;
}

.more__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 56px;
  padding: var(--sp-3) var(--sp-2);
  border: none;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.more__item:hover {
  background: var(--surface-sunken);
}

.more__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.more__label {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--ink-800);
}

.more__desc {
  font-size: var(--fs-xs);
  color: var(--ink-400);
}

.more__badge {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-micro);
  line-height: 18px;
  font-weight: var(--fw-medium);
  text-align: center;
}

.more__arrow {
  flex-shrink: 0;
  color: var(--ink-200);
  font-size: var(--fs-lg);
  line-height: 1;
}
</style>

<!-- ============================================================================
     下面这个 style 块**刻意不加 scoped**，不要给它加上去。
     ============================================================================
     el-drawer 把自己收到的 class 透传到**内部渲染出来的**那个 div 上，
     而不是组件根元素（根元素是外面的 overlay/transition 包装）。Vue 只会给
     子组件的**根元素**附加父组件的 data-v 属性，所以 .more-drawer 上根本没有
     scope 属性，:deep() 也选不中 —— 实测过，规则静默失效，抽屉底部保留了
     Element Plus 默认的固定 20px。

     后果不是"不好看"，是 iPhone 上最后一项压在 Home 指示条的区域里。

     选择器带 .more-drawer 前缀，只命中这一个抽屉，不会外泄到别处。
     ============================================================================ -->
<style>
.more-drawer .el-drawer__body {
  padding: 0 var(--sp-4);
  padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom, 0px));
}
</style>
