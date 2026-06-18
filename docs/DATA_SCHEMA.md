# 报告 JSON Schema

ReportFlow 的核心数据契约。LLM 解析器输出、编辑器读写、模板渲染都围绕这个结构。

```jsonc
{
  "schemaVersion": 1,

  "meta": {
    "title":    "string",            // 必填；空时自动填占位
    "subtitle": "string",            // 可选
    "author":   "string",            // 可选
    "date":     "YYYY-MM-DD",        // 可选；缺失自动填今日
    "tags":     ["string", ...]      // 可选
  },

  "sections": [
    {
      "id":      "string",           // 唯一；缺失会自动生成
      "heading": "string",           // 章节标题，例如「一、季度概况」
      "level":   1 | 2 | 3,          // 标题层级
      "blocks":  [ /* 见下 */ ]
    }
  ]
}
```

## 块类型 (`blocks[i].type`)

### `text`

```jsonc
{
  "type":    "text",
  "format":  "markdown" | "plain",   // markdown 推荐
  "content": "支持 **加粗**、列表、`code` 等"
}
```

### `chart`

```jsonc
{
  "type":  "chart",
  "title": "图表标题",
  "spec": {
    "kind":       "pie" | "bar" | "line",
    "categories": ["华东", "华南", ...],
    "series":     [
      { "name": "营收", "data": [120, 80, 50] },
      { "name": "成本", "data": [60, 40, 30] }
    ],
    "unit":       "万元"             // 可选
  }
}
```

- `pie`：用 `series[0]` 作为唯一系列，`categories` 与 `series[0].data` 一一对应。
- `bar` / `line`：x 轴 = `categories`，y 轴 = 数值，可有多条系列。

### `image`

```jsonc
{
  "type":    "image",
  "assetId": "img-xxx",   // IndexedDB 中的资源 ID（推荐）
  "src":     null,         // 备选：外部 URL（注意离线性）
  "caption": "图片说明"
}
```

`assetId` 在编辑器上传图片后由系统分配；导出 ZIP 时会被打包到 `assets/` 并把 `<img src>` 重写为相对路径。

## 校验规则（`js/core/schema.js`）

`RF_Schema.validate(input)` 返回：
```js
{ ok: bool, errors: [{path, msg}], normalized: <fixed object> }
```

- 缺失字段 → 用安全默认值填充（`title` 占位、`tags` 空数组、`series` 至少一个）。
- 未知 chart `kind` → 回退为 `bar`。
- 未知 block `type` → 丢弃（错误数组中给出路径）。

校验是**容错优先**的：LLM 偶尔输出不完美的 JSON 不会让界面崩，但所有问题都会通过 `errors[]` 报告给用户，可以在 toast / 日志中提示。

## 版本兼容

`schemaVersion` 留作未来字段迁移使用。当前固定 `1`，新增字段优先选择「可选 + 默认值」以保证向前兼容。
