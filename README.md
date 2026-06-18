# ReportFlow

> 通用智能汇报报告系统 · 纯静态前端 · 零部署 · 离线可用

把一段自然语言写的工作汇报，**粘进去 → 解析 → 编辑 → 切换模板 → 一键导出 ZIP / PDF**，全程在浏览器里跑，不需要任何后端、不需要 npm install。

---

## ✨ 特性

- **零部署**：双击 `index.html` 即用，没有构建步骤、没有服务器、没有依赖安装。
- **三套内置模板**：公务正式 / 极简商务 / 科技简约，一键切换不丢内容。
- **可扩展模板**：模板插件化，新增模板 = 丢一个文件夹 + 在 `index.html` 加一行 `<script>`，**核心代码零改动**。
- **多 LLM 适配**：OpenAI 兼容协议，预设 DeepSeek / Moonshot / 智谱 / 本地 Ollama 等。
- **本地持久化**：配置、草稿、历史快照存 `localStorage`；图片走 `IndexedDB`，**永远不上传**。
- **离线导出**：ZIP 导出后解压双击就能看，HTML 用相对路径引用图片，图表是内联 SVG。

---

## 🚀 使用

### 推荐：本地静态服务

```bash
cd ReportFlow
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

### 或：直接双击

也可以直接双击 `index.html`，但不同浏览器对 `file://` 的限制不同，**Chrome 推荐**。

### 配置大模型

1. 右上角 ⚙ 设置 → 选预设（默认 **DeepSeek**） → 填 API Key → 「测试连接」。
2. 第一次没 Key？也可以直接点左下「载入示例」，无需 LLM 就能预览全部三套模板。

---

## ⚠ CORS 现实

浏览器调用 LLM API 受同源策略限制。各家差异：

| 供应商 | 浏览器直连 | 备注 |
|---|:---:|---|
| **DeepSeek** | ✅ | 推荐首选，国内访问稳定 |
| **Moonshot Kimi** | ✅ | 月之暗面，CORS 友好 |
| **智谱 GLM** | ✅ | 兼容模式 |
| **本地 Ollama** | ✅ | 启动时设 `OLLAMA_ORIGINS=*`，完全离线 |
| **OpenAI** | ❌ | 通常被 CORS 拦截，需自建代理 |
| **通义千问** | ❌ | 同上 |
| **文心一言** | ❌ | 同上 |

需要走代理时，在设置里填「CORS 代理 URL」字段（格式形如 `https://your-proxy.example.com/?url=`）。**切勿把真实 API Key 发给来历不明的公共代理。**

---

## 🧩 新增模板（开发者）

详见 [docs/TEMPLATE_DEV_GUIDE.md](docs/TEMPLATE_DEV_GUIDE.md)。简版：

1. 在 `templates/` 下新建文件夹 `my-template/`，放 `template.json` + `style.css` + `render.js`。
2. 在 `index.html` 末尾的「Templates」区块追加一行：
   ```html
   <script defer src="templates/my-template/render.js"></script>
   ```
3. 刷新浏览器，模板下拉里就有它了。

---

## 📁 目录

```
ReportFlow/
├── index.html              # 唯一入口
├── css/                    # 应用外壳样式
├── js/
│   ├── core/               # event-bus / state / storage / asset-store / schema / logger / bootstrap
│   └── modules/            # config / llm / parser / editor / preview / exporter / history / ui
├── templates/              # 模板插件，每套一个文件夹
├── libs/                   # 全部 vendored：echarts / jszip / html2pdf / marked
├── assets/samples/         # sample-input.txt + sample-report.json
└── docs/                   # TEMPLATE_DEV_GUIDE / DATA_SCHEMA
```

---

## 🔒 隐私

所有数据（API Key / 草稿 / 图片）只在你的本地浏览器。本项目不发任何统计请求、不留后门。源码全部明文可读。

---

## 🛠 调试

打开浏览器控制台，键入：
```js
RF.state.get("report")     // 当前报告 JSON
RF.storage.usage()          // localStorage 占用
RF.assets.list()            // IndexedDB 中所有图片
RF.templates.list()         // 已注册模板
```
