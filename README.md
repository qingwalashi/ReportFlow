<div align="center">

<img src="assets/brand/logo.svg" alt="ReportFlow" width="96" height="96" />

# ReportFlow

**把一段大白话，变成一份能直接交付的工作汇报。**

[![Static](https://img.shields.io/badge/Static-100%25-2d5cf6?style=flat-square)]()
[![No Build](https://img.shields.io/badge/No%20Build-zero%20npm-5b8dff?style=flat-square)]()
[![Offline](https://img.shields.io/badge/Offline-ready-22c55e?style=flat-square)]()
[![Templates](https://img.shields.io/badge/Templates-3%20built--in-f59e0b?style=flat-square)]()
[![Export](https://img.shields.io/badge/Export-ZIP%20%7C%20PDF%20%7C%20HTML%20%7C%20PNG-8b5cf6?style=flat-square)]()

</div>

---

## 这是什么

**ReportFlow 是一个浏览器里的智能汇报工作台。**

打开它，把你随手写的文字（季度小结、周报、述职、调研纪要……）粘进左边输入框，点一下「解析」——大模型就会帮你抽出标题、时间、KPI、章节、表格、图表，生成一份结构化的报告。中间是**可视化的结构编辑器**，右边是**实时预览**，顶部一个下拉菜单**随时切换模板**，最后一键导出成 ZIP / PDF / HTML / PNG。

不需要后端、不需要数据库、不需要 `npm install`。**整个系统就是一个 `index.html`** —— 你甚至可以把它发到 U 盘里离线使用。

---

## 三栏工作流

```
┌────────────────────┬────────────────────┬────────────────────┐
│   ① 自然语言录入    │   ② 结构化编辑      │   ③ 实时预览        │
│                    │                    │                    │
│  粘贴一段大白话      │  标题 / KPI / 章节   │  当前模板效果       │
│  ↓ 点「解析」       │  字段级所见即所得    │  滚动联动 / 高亮联动 │
│  调用 LLM 提取结构   │  改一个字 → 右边变  │  顶部切换模板       │
│                    │                    │  底部一键导出        │
│  也能选中片段 →     │  支持图片、表格、   │  ZIP / PDF /        │
│  「AI 改写选区」    │  Pie / Bar / Line  │  HTML / PNG         │
└────────────────────┴────────────────────┴────────────────────┘
```

> 你写的是想法，系统给你的是结构。**改结构、不改文字**——所有美化都交给模板。

---

## ✨ 核心特性

| 特性 | 说明 |
|---|---|
| 🚀 **零部署** | 双击 `index.html` 即用；推荐 `python3 -m http.server` 启一个静态服务 |
| 🤖 **多模型适配** | OpenAI 兼容协议，预设 DeepSeek / Moonshot / 智谱 GLM / 本地 Ollama |
| 🎨 **三套内置模板** | 公务正式（深蓝宋体）/ 极简商务（灰白衬线）/ 科技简约（深色青绿） |
| 🧩 **模板插件化** | 新增模板 = 一个文件夹 + 一行 `<script>`，**核心代码零改动** |
| ✏️ **AI 改写选区** | 在原文里框选一段，让模型只改这一段，其余原样保留 |
| 📊 **图表内联** | ECharts 渲染为内联 SVG，离线打开也不丢 |
| 💾 **本地持久化** | 配置 / 草稿 / 历史走 `localStorage`；图片走 `IndexedDB`，**永远不上传** |
| 📦 **四种导出** | ZIP（HTML+图片）/ PDF（打印就绪）/ HTML（单文件）/ PNG（整页长图） |
| 🔒 **隐私优先** | 没有任何统计、埋点、远程请求——除了你自己配置的 LLM 接口 |

---

## 🚀 五分钟上手

### 1. 启动

```bash
cd ReportFlow
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 也可以直接双击 `index.html`，但 `file://` 协议在不同浏览器下的限制不同，**推荐 Chrome / Edge**。

### 2. 配置大模型

点击右上角 **⚙ 设置** → 选预设（默认 **DeepSeek**） → 填 API Key → 点「测试连接」。

> 第一次不想配 Key？也行：直接点左下角「**载入示例**」，整个流程跑一遍，三套模板和四种导出都能体验，无需 LLM。

### 3. 走一遍流程

```
   写一段                 解析                  调样式                 拿走
   ─────                 ────                 ────                   ────
   ┌─────────┐  ⚡       ┌─────────┐  🎨      ┌─────────┐  📦📄🌐🖼  ┌─────────┐
   │ 自然语言 │ ───────▶ │ 结构化   │ ───────▶ │ 模板预览 │ ───────▶  │ 交付物   │
   └─────────┘          └─────────┘          └─────────┘            └─────────┘
   (任意排版)            (字段级编辑)         (顶部下拉切换)          (4 种格式)
```

---

## 🎨 内置模板

| ID | 名称 | 风格 | 适合场景 |
|---|---|---|---|
| `formal-gov` | **公务正式** | 深蓝主色 + 宋体衬线 | 述职报告、公文风工作汇报 |
| `minimal-business` | **极简商务** | 灰白衬线 + 大留白 | 阶段总结、简洁商务汇报 |
| `tech-minimal` | **科技简约** | 深色背景 + 青绿强调 + 等宽数字 | 数据驱动的技术汇报 |

> 顶部下拉随时切换，**内容不丢**——三套模板共用同一份结构化数据。

---

## 📦 导出

预览面板底部四个按钮，对应四种交付形态：

| 按钮 | 产物 | 用途 |
|---|---|---|
| 📦 **ZIP** | `report.html + assets/` | 带图片的完整离线包，发给同事解压双击就能看 |
| 📄 **PDF** | `report.pdf` | 打印就绪，A4 分页（`pdfSafe` 模板效果最佳） |
| 🌐 **HTML** | 单个 `.html` | 图片以 base64 内嵌，方便邮件附件 |
| 🖼 **PNG** | 整页长图 | 适合贴到聊天工具、社交平台 |

---

## 🤖 大模型与 CORS

浏览器直连 LLM API 受同源策略限制，各家差异如下：

| 供应商 | 浏览器直连 | 备注 |
|---|:---:|---|
| **DeepSeek** | ✅ | 推荐首选，国内访问稳定 |
| **Moonshot Kimi** | ✅ | 月之暗面，CORS 友好 |
| **智谱 GLM** | ✅ | 兼容模式 |
| **本地 Ollama** | ✅ | 启动时设 `OLLAMA_ORIGINS=*`，完全离线 |
| **OpenAI** | ❌ | 通常被 CORS 拦截，需自建代理 |
| **通义千问 / 文心一言** | ❌ | 同上 |

> 若必须走代理，在设置里填「CORS 代理 URL」字段（形如 `https://your-proxy.example.com/?url=`）。
> ⚠️ **切勿把真实 API Key 发给来历不明的公共代理。**

---

## 🔒 隐私

所有数据 —— **API Key、草稿、历史快照、图片** —— 只存在你本机的浏览器里。本项目不发任何统计请求、不留后门。源码全部明文可读。

---

## 🧩 想加自己的模板？

新增模板就是丢一个文件夹 + 在 `index.html` 加一行 `<script>`，**不需要改核心代码**。详细规范见 👉 [docs/TEMPLATE_DEV_GUIDE.md](docs/TEMPLATE_DEV_GUIDE.md)，数据契约见 👉 [docs/DATA_SCHEMA.md](docs/DATA_SCHEMA.md)。

---

## 📁 目录结构（速览）

```
ReportFlow/
├── index.html              # 唯一入口
├── assets/brand/           # LOGO / favicon
├── assets/samples/         # 示例输入与示例报告
├── css/                    # 应用外壳样式
├── js/
│   ├── core/               # event-bus / state / storage / asset-store / bootstrap
│   └── modules/            # config / llm / parser / editor / preview / exporter-* / history / ui
├── templates/              # 模板插件，每套一个文件夹
│   ├── formal-gov/
│   ├── minimal-business/
│   └── tech-minimal/
├── libs/                   # 全部 vendored：echarts / jszip / html2pdf / marked
└── docs/                   # TEMPLATE_DEV_GUIDE / DATA_SCHEMA
```

---

## 🛠 调试小抄

打开浏览器控制台：

```js
RF.state.get("report")   // 查看当前报告 JSON
RF.storage.usage()       // 查看 localStorage 占用
RF.assets.list()         // 列出 IndexedDB 中所有图片
RF.templates.list()      // 列出已注册模板
```

---

<div align="center">

**ReportFlow** · 让汇报回到内容本身

<sub>把模板留给系统，把时间留给思考。</sub>

</div>
