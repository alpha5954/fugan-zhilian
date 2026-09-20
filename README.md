# 复感智联 · 智能评估系统

面向柔性多模态传感器的智能评估系统前端。配套项目为「复感智联」——基于仿鱼鳞仿生结构与 MWCNTs/GR/VO₂/SR 多元纳米复合材料的柔性应变-温度双模式传感器，本系统负责传感器数据的采集展示、康复运动识别结果呈现与评估报告生成。

## 技术栈

| 用途 | 选型 |
|---|---|
| 框架 | Vue 3（`<script setup>` SFC） |
| 语言 | TypeScript |
| 构建 | Vite |
| UI 组件 | Element Plus |
| 图表 | ECharts |
| 路由 | Vue Router |
| 状态管理 | Pinia |
| 后端 / 数据库 | Supabase（Postgres + Auth + Data API） |

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

部署目标是 GitHub Pages，站点位于 `https://<用户名>.github.io/fugan-zhilian/` 的子路径下。因此 `vite.config.ts` 中的 `base` 必须与此路径一致，**更换仓库名时需同步修改**，否则线上静态资源会全部 404。

## 逻辑自检

```bash
npm run check              # 全部
npm run check:simulator    # 信号模拟器的物理关系（13 项）
npm run check:assessment   # 康复评估的指标计算与入库数据（39 项）
```

两个脚本都用 `node` 直接执行 `.ts`，靠的是 Node 22.6+ 的类型剥离，不需要额外装测试框架。

### 信号模拟器

实时监测页的数据由 `src/lib/simulator.ts` 生成（硬件尚未接入）。模拟器不是随机数发生器——它按传感器实际参数复现信号链路：

```
关节角度 ──映射──> 伸长率 ──GF──> 应变分量 ┐
                                          ├─> 原始信号（两者耦合）
局部温度 ────────────TCR──────> 温度分量 ┘
```

自检脚本验证这些物理关系确实成立，比如 `原始 = 应变 + 温度` 的残差仅为噪声、温度分量与温度呈完全负相关、肌电在向心收缩期强于离心期。改模拟器的常数后跑一下，能立刻发现有没有把关系改坏。

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
│   ├── errors.ts        PostgREST 错误对象转可读文案
│   ├── format.ts        时间戳与数值格式化
│   ├── simulator.ts     传感器信号模拟器
│   └── assessment.ts    康复评估：会话生成与指标计算
├── stores/              Pinia：user / device / session / alert
├── composables/
│   └── useMonitor.ts    实时监测的采样循环与滚动窗口
├── constants/project.ts 项目元信息与性能指标
├── layouts/             页面布局
├── components/          SignalChart / BarChart / PagePlaceholder
└── views/               七个页面

scripts/                 自检脚本（node 直接运行 .ts）
supabase/
├── migrations/          数据库迁移
├── dev/                 本地验证环境与端到端测试
└── verify_*.sql         线上核对脚本
```

`@` 别名指向 `src/`，配置同时存在于 `vite.config.ts`（构建期）与 `tsconfig.app.json`（类型检查），修改时需保持两处一致。

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
| 5.4+ | 数据分析、设备管理、关于 | 待开发 |

硬件尚未接入，监测与评估的数据由 `src/lib/simulator.ts` 按传感器实际参数模拟生成，界面全程标注「模拟数据」。接入硬件后替换数据源即可，指标算法与图表逻辑无需改动。

## 运维：Supabase 保活

Supabase 免费版项目连续 **7 天无活动会被自动暂停**，恢复需人工操作。`.github/workflows/keepalive.yml` 每天调用一次数据库里的 `ping_keepalive()` 维持活跃。

首次使用需在仓库中添加两个 secret（Settings → Secrets and variables → Actions）：

| Secret | 值 |
|---|---|
| `SUPABASE_URL` | `https://<项目ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | publishable key 或 anon key |

加完在 Actions 页面手动跑一次验证。两个 secret 缺任意一个，工作流会明确报错而不是静默失败。

⚠️ **GitHub 会在仓库连续 60 天无活动后停用定时工作流。** 开发期间有提交所以不受影响，但项目如果长期搁置需要留意——届时去 Actions 页面手动重新启用即可。
