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

## 目录结构

```
src/
├── main.ts              # 应用入口
├── App.vue              # 根组件
├── style.css            # 全局样式
├── assets/              # 图片等资源
│   ├── hero.png
│   ├── vite.svg
│   └── vue.svg
└── components/          # 组件
    └── HelloWorld.vue   # 脚手架默认页，后续会替换

public/                  # 原样拷贝到构建产物根目录
├── favicon.svg
└── icons.svg
```

`@` 别名指向 `src/`，配置同时存在于 `vite.config.ts`（构建期）与 `tsconfig.app.json`（类型检查），修改时需保持两处一致。

## 开发状态

项目骨架阶段。路由、状态管理、Supabase 客户端接入尚未配置。
