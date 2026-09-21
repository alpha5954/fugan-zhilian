# 复感智联 · 智能评估系统

面向柔性多模态传感器的智能评估系统前端。配套项目为「复感智联」——基于仿鱼鳞仿生结构与 MWCNTs/GR/VO₂/SR 多元纳米复合材料的柔性应变-温度双模式传感器，本系统负责传感器数据的采集展示、康复运动识别结果呈现与评估报告生成。

## 技术栈

| 用途 | 选型 |
|---|---|
| 框架 | Vue 3（`<script setup>` SFC） |
| 语言 | TypeScript |
| 构建 | Vite |
| UI 组件 | Element Plus（**按需引入**，见下） |
| 图表 | ECharts |
| 路由 | Vue Router |
| 状态管理 | Pinia |
| 后端 / 数据库 | Supabase（Postgres + Auth + Data API） |

## 首屏体积

Element Plus **按需引入**，由 `vite.config.ts` 里两个 unplugin 插件完成：

| 插件 | 负责 |
|---|---|
| `unplugin-vue-components` | **模板里**用到的组件（`<el-table>` 之类） |
| `unplugin-element-plus` | **脚本里显式 import** 的服务式 API（`ElMessage` 等，它们不是组件，模板解析器管不到） |

两者缺一不可 —— 只用前者的话 `ElMessage`、`ElMessageBox`、`ElNotification` 会没有样式。

实测效果：

| | 改造前 | 改造后 |
|---|---|---|
| 首屏原始 | 1574 KB | **525 KB** |
| 首屏 gzip | 429 KB | **159 KB** |

### 两个必须知道的注意点

**① `src/components.d.ts` 要提交进仓库。** 它是插件生成的类型声明，让 `vue-tsc` 认识那些"凭空出现"的组件。`npm run build` 先跑 `vue-tsc` 再跑 `vite`，不提交的话 CI 上类型检查会失败。**新增组件后需要先跑一次 `npx vite build` 重新生成**，否则类型检查会报找不到组件。

**② 中文语言包改由 `<el-config-provider>` 提供。** 原先是在 `main.ts` 里 `app.use(ElementPlus, { locale: zhCn })`，按需引入后插件不再全局安装，改在 `App.vue` 里包一层。不改的话分页器、日期选择器、确认框的内置文案会退回英文。

> 顺带一提：改成按需引入后类型检查变严了，`el-table` 插槽的 `row` 从 `any` 变成了 `DefaultRow`，暴露出 `Devices.vue` 里三处未经验证的类型断言。这是好事，已用 `asDevice()` 显式收窄。

## 图标与品牌

浏览器标签页、iOS 主屏图标都由项目 logo 生成：

```
design/logo-source.jpg    原始图（不参与构建，仅作再生成的源）
scripts/make-icons.py     生成脚本
public/                   生成结果，会被打进产物
├── favicon.ico           16/32/48 打包，老浏览器与 Windows 用
├── favicon-16.png
├── favicon-32.png
├── apple-touch-icon.png  180×180，白底（iOS 不接受透明图标）
└── logo.png              512×512，顶栏也用这张
```

**重新生成**（改了 logo 或要加尺寸时）：

```bash
python scripts/make-icons.py
```

脚本里有两处不显然的处理：

**① 抠背景不能用洪水填充。** 第一版从四角填充识别圆外白底，结果填充率 62.9%（理论应约 34%）——填充顺着圆形边缘渗进了鱼鳞之间的白色缝隙，圆内 38.4% 变成透明，logo 在深色背景上会镂空。改成**几何方式**：非白像素的包围盒就是圆的直径，只抠这个圆之外。圆内的白色负空间是设计的一部分，必须保留。

**② `ImageDraw.floodfill` 在二值 `L` 图上不生效。** 实测填充 0 个像素；对 RGB 图填充才正常。这条留作记录，免得以后有人再踩。

## 环境要求

- Node.js 20+（当前开发环境为 v24.18.0）
- npm 10+

## 本地开发

```bash
npm install          # 安装依赖
cp .env.example .env.local   # 首次运行：配置环境变量，见下
npm run dev          # 启动开发服务器
```

开发服务器地址：<http://localhost:5173/fugan-zhilian/>

> 注意地址里带 `/fugan-zhilian/` 前缀，这是 `vite.config.ts` 里 `base` 配置导致的，不是写错了。

## 环境变量

首次拉取代码后，复制 `.env.example` 为 `.env.local` 并填入 Supabase 项目的真实值：

```
VITE_SUPABASE_URL=https://<你的项目ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key 或 anon key>
```

取值位置：Supabase 控制台 → 选择项目 → Settings → API。

`.env.local` 已在 `.gitignore` 中排除，不会进版本库。**切勿把 SECRET / `service_role` key 填进去**——那个密钥会绕过全部 RLS 行级安全策略，只能存在于服务端。

## 构建与部署

```bash
npm run build     # 类型检查 + 生产构建，输出到 dist/
npm run preview   # 本地预览构建产物
```

### 线上地址

<https://alpha5954.github.io/fugan-zhilian/>

推送到 `main` 即自动部署（`.github/workflows/deploy.yml`）。站点位于仓库名子路径下，因此 `vite.config.ts` 的 `base` 必须与此一致，**更换仓库名时需同步修改**，否则线上静态资源会全部 404。

### 首次部署需要三步手动配置

**1. 添加仓库 Secrets**（Settings → Secrets and variables → Actions）

| Secret | 值 |
|---|---|
| `VITE_SUPABASE_URL` | `https://<项目ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | publishable key 或 anon key |

> Vite 在**构建时**把 `import.meta.env.VITE_*` 替换成字面量，不是运行时读取。所以这两个值必须在构建步骤就以环境变量形式存在，产物里才带得上。缺了它们构建**不会报错**，但线上会白屏——工作流里加了一步翻产物确认地址真的打进去了。

**2. 启用 GitHub Pages**（Settings → Pages → Source 选 **GitHub Actions**）

不要选 "Deploy from a branch"，那个模式不会执行 `deploy.yml`。

**3. 配置邮件回跳白名单**（Supabase 控制台 → Authentication → URL Configuration）

Redirect URLs 加上线上地址与本地开发地址，Site URL 指向线上地址。**不配的话找回密码和注册确认邮件的链接都会跳到别处，而且不报错**——详见上面「找回密码」一节。

### 关于 404.html

GitHub Pages 是静态托管，**不支持 SPA 回退**：直接访问 `/fugan-zhilian/analysis` 或在深链接上刷新，会因为找不到同名文件而返回 404。

构建流程里加了一步把 `index.html` 复制成 `404.html`。Pages 遇到未知路径时会用这个页面兜底，应用照常启动，vue-router 按 `location.pathname` 解析出正确路由。

> 副作用：深链接返回的 HTTP 状态码是 404 而非 200。对演示无影响，但如果将来要做 SEO，需要改用 hash 路由或换支持 SPA 回退的托管（Vercel / Netlify）。

## 逻辑自检

```bash
npm run check              # 全部（139 项）
npm run check:simulator    # 信号模拟器的物理关系与信号丢失（17 项）
npm run check:assessment   # 康复评估的指标计算与入库数据（52 项）
npm run check:analysis     # 数据分析的聚合逻辑（28 项）
npm run check:alerts       # 实时监测的预警判据（16 项）
npm run check:auth         # 认证回调识别与错误码翻译（26 项）
```

五个脚本都用 `node` 直接执行 `.ts`，靠的是 Node 22.6+ 的类型剥离，不需要额外装测试框架。

### 认证相关的界面验证

上面那些是纯逻辑断言，跑不到"用户点完邮件到底落在哪个页面"这种问题上。那部分由 `supabase/dev/e2e_auth_ui.mjs` 用 Playwright 驱动真实浏览器验证（22 项）：

```bash
npm run dev                                     # 另开一个终端
node supabase/dev/e2e_auth_ui.mjs               # 默认打 :4173 的 preview
node supabase/dev/e2e_auth_ui.mjs http://localhost:5173/fugan-zhilian
```

需要 Playwright 与 Chromium（`npm i -D playwright && npx playwright install chromium`），因此**没有并入 `npm run check`** —— 其余自检脚本刻意做到零额外依赖。

它验的是几件读代码读不准的事：恢复模式的"锁"有没有生效、三种失败情况是否各说各话、以及 `type` 不是 `recovery` 时会不会被误伤。

### 自检脚本本身也会出错

写这些断言时踩过三次「断言错了而不是代码错了」，都值得记下来：

1. **用四舍五入后的值比唯一性**：直腿抬高和靠墙静蹲设计上都是小 ROM，随机波动下会撞到同一个整数
2. **上界卡在设计值上**：屈膝滑动设计范围 5–100°，叠加 ±6% 会话波动后最大到 100.6°，卡 100 会偶发误报
3. **概率算错量级**：信号丢失的概率是对**每个采样点**生效的，不是对"每次丢失事件"——少乘了一个量级，导致断言阈值定低了 16 倍

第一条跑 8 次才复现 1 次，第三条跑 20 次失败 11 次。**如果只跑一遍就交付，这些 flaky 断言会在某次演示前突然变红。** 自检脚本改完要连跑 20–30 次确认稳定。

### 信号模拟器

实时监测页的数据由 `src/lib/simulator.ts` 生成（硬件尚未接入）。模拟器不是随机数发生器——它按传感器实际参数复现信号链路：

```
关节角度 ──映射──> 伸长率 ──GF──> 应变分量 ┐
                                          ├─> 原始信号（两者耦合）
局部温度 ────────────TCR──────> 温度分量 ┘
```

自检脚本验证这些物理关系确实成立，比如 `原始 = 应变 + 温度` 的残差仅为噪声、温度分量与温度呈完全负相关、肌电在向心收缩期强于离心期。改模拟器的常数后跑一下，能立刻发现有没有把关系改坏。

### 肌电-运动学融合分析

命题答题要求点名了三项分析能力，第三项是「结合肌肉骨骼模型的运动学数据融合（如关节角度与肌电信号的关联性分析）」。实现在 `buildEmgAnglePhase()`。

**为什么不能只算一个相关系数**：一次屈伸动作里角度先升后降、肌电也先强后弱，两者都是非单调的，直接算 Pearson 相关系数会接近 0。有意义的是**分相位看**——把每个角度上的肌电按向心期（角度增大）和离心期（角度减小）分成两条曲线，画在同一张图上会形成一个闭合环路，两臂的高低差就是发力相位是否正确的直接证据。**肌电峰值若落在离心期，说明存在代偿。**

**一个踩过的坑**：峰值角度原本取"RMS 最高的那一箱"，实测**无偏但标准差高达 12°**——同一患者同一动作，连续两次评估可能显示"峰值 30°"和"峰值 75°"，治疗师会认为系统坏了。根因是肌电包络本身很宽（相位标准差 0.12 折合约 11°），加上每箱只有约 2 个采样点，argmax 极易被单箱噪声带偏。改用**强势区（≥80% 峰值）的加权质心**后标准差降到 5.4°。试过加大分箱宽度，没有帮助——剩下的波动由包络宽度决定。

**静力动作会被排除**：靠墙静蹲的角度只在十几度内微调，没有明确的向心/离心交替，硬做会得到两条几乎重合的曲线和一个没意义的比值。此时返回 `applicable: false` 并说明原因，而不是硬画一张图。

### 康复评估的达标判定

不同动作的达标指标**不是同一个量**，混用会得出错误结论：

| 动作类型 | 判定指标 | 例 |
|---|---|---|
| 动态屈伸（坐位伸膝、屈膝滑动、直腿抬高） | **关节活动范围**（行程） | 坐位伸膝要求达到 80° |
| 静力维持（靠墙静蹲） | **保持角度** | 靠墙静蹲要求保持在 55° |

靠墙静蹲是静力动作，活动范围本来就很小（只有姿势微调）。**拿它的活动范围去比 55° 的目标会得出「远未达标」的错误结论**——实际要看的是它保持在了多大角度。这两者在 `src/lib/assessment.ts` 里由 `AssessMetric` 区分，评估页会据此切换图表标签与目标线。

⚠️ 四个动作的名称与各自的达标值是按常见膝关节术后康复方案拟定的，计划书里只写了「四类典型膝关节康复运动」并未列出具体名称。**团队应按实际康复方案核定 `EXERCISE_PROFILE` 这张表。**

## 目录结构

```
src/
├── main.ts              应用入口
├── App.vue              根组件
├── style.css            全局样式
├── types/index.ts       领域类型 + Supabase Database 泛型
├── router/index.ts      路由表与导航守卫
├── lib/
│   ├── supabase.ts      客户端单例
│   ├── authRedirect.ts  邮件回跳地址 + 恢复链接识别（必须是 main.ts 的第一个 import）
│   ├── errors.ts        错误转可读中文（含认证错误码表）
│   ├── format.ts        时间戳与数值格式化
│   ├── simulator.ts     传感器信号模拟器
│   └── assessment.ts    康复评估：会话生成与指标计算
├── stores/              Pinia：user / device / session / alert / care
├── composables/
│   └── useMonitor.ts    实时监测的采样循环与滚动窗口
├── constants/project.ts 项目元信息与性能指标
├── layouts/             页面布局
├── components/          SignalChart / BarChart / PieChart / PhaseChart /
│                        AuthShell / ErrorBoundary / StateBlock …
├── styles/              tokens.css（设计令牌）+ element.css（组件库覆盖）
└── views/               十个页面

scripts/                 自检脚本（node 直接运行 .ts）
supabase/
├── migrations/          数据库迁移
├── dev/                 本地验证环境与端到端测试
└── verify_*.sql         线上核对脚本
```

`@` 别名指向 `src/`，配置同时存在于 `vite.config.ts`（构建期）与 `tsconfig.app.json`（类型检查），修改时需保持两处一致。

### 数据库核对脚本

两个脚本都在 Supabase SQL Editor 里执行，用途不同：

| 文件 | 用途 |
|---|---|
| `supabase/verify_migrations.sql` | **精简版**，6 项。只回答"迁移都应用了没"，适合快速粘贴 |
| `supabase/verify_summary.sql` | **完整版**，18 项。含策略、触发器、列级授权等明细，迁移后完整核对用 |

> ⚠️ `verify_summary.sql` 有 222 行，粘贴时容易只选中一部分，导致 `syntax error at end of input`。日常检查用精简版。

## 开发状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 环境、仓库、Supabase 项目 | ✅ |
| 1 | Vite + Vue 3 + TS 骨架 | ✅ |
| 2 | 数据库表结构与 RLS | ✅ |
| 3 | 类型、Store、路由、布局 | ✅ |
| 4 | Supabase 认证与登录页 | ✅ |
| 5.1 | 首页概览 | ✅ |
| 5.2 | 实时监测 | ✅ |
| 5.3 | 康复评估 | ✅ |
| 5.4 | 数据分析 | ✅ |
| 5.5 | 设备管理 | ✅ |
| 5.6 | 关于页 | ✅ |
| 6 | 交互完善：预警通知、错误出口、防重复提交 | ✅ |
| 7 | 部署与保活 | ✅ |
| 8 | 测试与修复 | ✅ |
| 9 | 监护关系（家属远程查看） | ✅ |
| 10 | 登录/注册完善：找回密码、错误中文化、视觉对齐设计系统 | ✅ |

十个页面：概览、实时监测、**预警记录**、康复评估、数据分析、设备管理、监护管理、关于、登录、设置新密码。

### 预警记录

实时监测页在温度超标、信号中断时会往 `alerts` 表写记录，家属端收到的提醒也来自这张表。

这个页面补的是一个**功能缺口**：在此之前预警是"只写不读"的——首页只有个数字红点，点不进去，也没有列表页，`acknowledge()` 从未被任何界面调用，所以**红点只增不减**。低温烫伤预警是产品的安全核心卖点，看不到内容等于没做。

列表支持按「未处理 / 等级」筛选、单条与批量标记已读、删除。每条同时展示**实测值与阈值**（只显示"48.5"没有参照）和该类型预警的**处置建议**。

### 访客模式

**打开网站直接进入「实时监测」，不需要注册。** 落地页选它是因为四路曲线由模拟器驱动、不依赖任何历史数据，访客一进来就能看到东西在动。

访客首次进入时**静默建立一个匿名账号**（Supabase Anonymous Sign-in），此后所有功能与正式用户完全一致。

**为什么要建账号而不是直接放行**：`anon` 角色在业务表上没有任何授权（迁移 2 刻意 revoke 的），直接放行会让每个数据页面拿到 `42501 permission denied`。匿名账号拿到的是正常的 `authenticated` 角色，**既有 RLS 原样生效**，所以页面和数据层没有为"访客"写任何分支。

**注册 = 升级当前账号**（`updateUser`，不是 `signUp`）：uid 不变，**访客期间绑定的设备、保存的训练记录全部保留**。这条承诺由 `supabase/dev/e2e_guest_mode.mjs` 实测验证。

**访客点「登录」会二次确认**：Supabase 的登录是替换会话，用已有账号登录后匿名账号的数据不会跟随。想保留数据必须走「保存账号」。

⚠️ 控制台需开启 **Anonymous Sign-ins**（Authentication → Sign In / Providers）。未开启时守卫退回登录页兜底。

### 找回密码

流程：登录页点「忘记密码」→ 填邮箱 → 收到邮件 → 点链接 → 落在 `/<base>/reset-password` 设置新密码。

改密码成功后会自动 `signOut({ scope: 'others' })`，**把其它设备上的会话一并作废**。改密码通常是因为原密码可能已经泄露，不作废旧会话的话攻击者手里那个还能继续用，改了等于没改。当前这台不受影响。

⚠️ **必须先配 Redirect URLs，否则线上收不到邮件链接的效果。**

Supabase 控制台 → Authentication → URL Configuration → Redirect URLs 里加上：

```
http://localhost:5173/fugan-zhilian/**
http://localhost:4173/fugan-zhilian/**
https://alpha5954.github.io/fugan-zhilian/**
```

**配错的失败是无声的。** 实测过 GoTrue 对不在白名单里的 `redirectTo` **不报错**，而是静默丢弃、改用站点的 Site URL —— 接口返回成功，前端也没有任何异常，只有用户点的邮件链接会跳到一个陌生的地址。

（好在还有一层兜底：`authRedirect.ts` 认的是 URL 里的 hash，不管落在哪个路径上都能认出恢复链接并把人送去设置新密码页。所以只要**站点的 Site URL 本身指向本站**，即使白名单没配也能走通。但 Site URL 默认是 `http://localhost:3000`，用手机点邮件就废了——白名单还是要配。）

实现上还有一个必须知道的坑，它决定了这个功能能不能工作：

**① 不能靠 `PASSWORD_RECOVERY` 事件，要从 URL 里同步读。**

Supabase 的恢复链接把令牌放在 hash 里（`#access_token=...&type=recovery`），SDK 解析完会把它清空。而 SDK 发出 `PASSWORD_RECOVERY` 事件用的是**一句裸的 `setTimeout(..., 0)`**，不进 initialize 的通知队列；`getSession()` 之后我们还跟着一次 `fetchProfile` 网络请求——等那之后再订阅，事件早发完了。用户会被当成普通登录送进首页，密码根本没改，而他以为自己改过了。

所以 `lib/authRedirect.ts` 里对 URL 的解析放在**模块求值阶段**，而它必须是 `main.ts` 的**第一个 import**——排在 SDK 后面加载就读不到了。这条顺序约束在那个文件的开头写着，改的时候别挪。

**② 守卫要把用户"锁"在设置新密码页上。**

点完邮件那一刻，用户手里是一个货真价实的登录会话。没有这道锁的话他会一路正常地进首页、逛各个页面，然后大概率再也想不起来自己是来改密码的。锁在 `router/index.ts` 的最前面，公开页面也不放行。

三种进不到表单的情况分开说，而不是统一一句"出错了"：**链接过期**（URL 带 `error_code`）、**令牌没换成会话**（可能被邮件客户端截断）、**直接敲地址**。前两种给出「重新申请一封」，第三种指回登录页。

**③ 错误提示要翻译。**

Supabase 的认证错误是英文的（`Invalid login credentials`），中文界面里只有报错冒英文，用户读不懂也不知道下一步干什么。`lib/errors.ts` 的 `authErrorInfo()` 按错误码翻成中文，并把码一起返回——因为 `email_not_confirmed` 需要界面额外给一个「重新发送确认邮件」的按钮，光提示"去验证邮箱"没有用。

⚠️ 「如果该邮箱已注册，邮件已发出」——**措辞不能写成"邮件已发往 xxx"**。Supabase 对未注册的邮箱同样返回成功，这是刻意的反枚举设计，否则任何人都能拿这个接口试探哪些邮箱注册过。

### 监护关系（家属远程查看）

产品需求是"把康复数据同步到子女手机"，数据库层从阶段 2 起就按这个设计（`care_links` 表 + `is_caregiver_of` 等策略）。前端在阶段 9 补齐。

**建立关系的流程**：

1. 患者在自己的「监护管理」页看到一串 **6 位邀请码**
2. 把码发给家人（微信即可）—— 码去掉了 I/L/O/0/1 这些形近字符，方便念和手输
3. 家属在「监护管理」页输入码发起申请，状态为**待确认**
4. 患者在页面上确认后关系才生效

**为什么用邀请码而不是按邮箱查找**：`profiles` 表里没有 email（邮箱在 `auth.users`，不对外暴露）。就算加一列，RLS 也只允许读已建立关系的对方资料 —— 家属在建立关系**之前**恰恰看不到患者。而按邮箱查人会引入**邮箱枚举漏洞**：任何登录用户都能拿它试探哪些邮箱注册过。Supabase 的注册接口刻意对已存在的邮箱返回假用户就是为了堵这个口，不该在别处再开一个。

**权限边界**（都已在真实环境端到端验证）：

| 行为 | 是否允许 |
|---|---|
| 家属发起申请 | ✅ 但只能是 `pending` |
| 家属自己批准 | ❌ 触发器拦截，只有患者本人能改成 `active` |
| 家属读患者的训练/设备/预警 | ✅ 关系生效后 |
| 家属改患者资料 | ❌ RLS 静默过滤，值不变 |
| 家属改关系类型 | ❌ 列级授权只开放 `status` |
| 患者撤销后 | ✅ 立即失效 |
| 无关第三方 | ❌ 全程不可见 |

**家属查看多个对象时**：数据页面按"当前查看对象"过滤，顶部有常驻提示条说明正在看谁的数据。没有这条提示的话，两张长得一样的表很容易被当成自己的看。

### 数据来源

**如实标注，不把模拟数据说成实测数据**（答辩时经不起追问）：

| 环节 | 真实对接后端 | 模拟 |
|---|---|---|
| 账号注册与登录 | ✅ Supabase Auth | |
| 设备绑定 / 解绑 / 固件状态 | ✅ Supabase | |
| 训练记录保存（含 jsonb 波形） | ✅ Supabase | |
| 历史趋势与统计 | ✅ Supabase | |
| 实时信号（应变 / 温度 / sEMG） | | 🔶 内置模拟器 |
| 关节角度与动作识别 | | 🔶 内置模拟器 |
| 评估结论文本 | | 🔶 规则生成，非大模型 |

传感器硬件接入后替换数据源即可，指标算法与图表逻辑无需改动。

硬件尚未接入，监测与评估的数据由 `src/lib/simulator.ts` 按传感器实际参数模拟生成，界面全程标注「模拟数据」。接入硬件后替换数据源即可，指标算法与图表逻辑无需改动。

## 运维：Supabase 保活

Supabase 免费版项目连续 **7 天无活动会被自动暂停**，恢复需人工操作。`.github/workflows/keep-alive.yml` 每天调用一次数据库里的 `ping_keepalive()` 维持活跃。

首次使用需在仓库中添加两个 secret（Settings → Secrets and variables → Actions）：

| Secret | 值 |
|---|---|
| `SUPABASE_URL` | `https://<项目ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | publishable key 或 anon key |

加完在 Actions 页面手动跑一次验证。两个 secret 缺任意一个，工作流会明确报错而不是静默失败。

⚠️ **GitHub 会在仓库连续 60 天无活动后停用定时工作流。** 开发期间有提交所以不受影响，但项目如果长期搁置需要留意——届时去 Actions 页面手动重新启用即可。
