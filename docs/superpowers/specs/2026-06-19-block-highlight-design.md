# 第二列 ↔ 第三列 块级双向高亮 — 设计

**日期**: 2026-06-19
**范围**: 在中间结构化编辑列(`.rf-blk`)与右侧实时预览列(iframe 内 `.rf-block`)之间,实现"点击块 → 双侧对应块同时高亮"的双向联动。

## 目标

让用户在两列间快速建立对应关系:点哪边的块,两边都立即标出。视觉锚点持续保留,直到用户切到别的块。

## 选型决策(已与用户确认)

| 维度 | 选择 |
|------|------|
| 高亮粒度 | **块级(block)** |
| 持续时间 | **持久,切换式**(同块再点 = 取消;点别的块 = 转移) |
| 内层控件处理 | **排除 INPUT/TEXTAREA/BUTTON/SELECT/A**,这些点击不触发高亮 |
| 自动滚动 | **仅当对方对应块完全不在视口时才滚到视野** |
| 视觉样式 | **左侧 3px 主题色竖条 + 浅底色**(两列同款) |

## 模块划分

### 新增 `js/modules/block-highlight.js`
独立模块,与 [scroll-sync.js](../../../js/modules/scroll-sync.js) 平级。职责:
- 监听两列的 `click`(以 capture 在合适根上,而非每个块单独绑)
- 维护 `selected = { secIdx, blkIdx } | null`
- 应用/移除 `--selected` class
- 在重渲染后重新涂样式

### 修改 `js/modules/scroll-sync.js`
暴露 `acquireLock(side)` 方法供本模块调用,防止 scrollIntoView 引发滚动联动回环。

### 修改 `js/modules/editor.js`
在 `render()` 末尾发出 `editor:rendered` 事件(1 行),为本模块提供"DOM 已重建"信号。

### 新增 CSS 规则(追加到 `css/components.css`)
两条 `--selected` 类样式。

### 不改 `preview.js`
利用已有的 `preview:rendered` 事件即可。

## DOM 锚点 / 索引对齐

| 列 | 章节元素 | 块元素 |
|---|---|---|
| 编辑列(左) | `#rf-editor-root > .rf-sec` | 章节 `.rf-sec__body` 下的 `.rf-blk`(注意排除尾部 `.rf-row` 工具行) |
| 预览列(右,iframe 内) | `#root > section.rf-section` | `section.rf-section > .rf-block` |

**索引对齐**:`(secIdx, blkIdx)` —— 双侧均按 DOM 顺序与 `report.sections[i].blocks[j]` 一一对应。不动 schema,不加 `data-*` 属性。

## 选中状态

```js
selected = { secIdx: number, blkIdx: number } | null;
```

只存逻辑坐标。每次点击重算;清除时设为 null。DOM 重建后查一次 DOM 即可恢复样式 —— 不保存元素引用。

## 数据流

```
用户点击 .rf-blk 或 .rf-block 内任一处
    ↓
event.target.closest("input,textarea,button,select,a") → 命中 → return
    ↓
event.target.closest(".rf-blk | .rf-block") → 拿到块元素
    ↓
计算 (secIdx, blkIdx):
  - 沿父链找到所属 section
  - section 在其父中的索引 = secIdx
  - block 在所属 section 的同类块集合中的索引 = blkIdx
    ↓
若与 selected 同 → selected = null(切换关闭)
否则 → selected = { secIdx, blkIdx }
    ↓
applyHighlight():
  1. 清除两列里所有 .rf-blk--selected / .rf-block--selected
  2. 若 selected:
     - 编辑列定位第 (secIdx, blkIdx) 个 .rf-blk → 加 class
     - 预览列定位第 (secIdx, blkIdx) 个 .rf-block → 加 class
     - 对方块完全不在视口? 是 → 调用 RF_ScrollSync.acquireLock(对方) 后
       el.scrollIntoView({ block: 'nearest' })
```

## 与滚动联动的协作

新增 `RF_ScrollSync.acquireLock(side)` 公开接口(已有内部同名函数,只需改名导出):

```js
window.RF_ScrollSync = { init: init, acquireLock: acquireLock };
```

block-highlight 在 `scrollIntoView` 之前调用,150ms 内对方的 scroll 事件被忽略,避免回环。

## DOM 重建后的恢复

两个时机:

1. **编辑列重建** —— editor.js 的 `render()` 在末尾 `bus.emit("editor:rendered")`(新加 1 行)。
2. **预览列重建** —— preview.js 已有的 `bus.emit("preview:rendered", ...)`,无需改动。

block-highlight 订阅这两个事件,触发 `applyHighlight()` 复用同一份逻辑。

若 `selected` 在新 DOM 中**越界**(用户删除了该块):定位失败 → `selected = null`,不残留高亮。

## 视觉样式

```css
.rf-blk--selected {
  position: relative;
  background: rgba(70, 110, 220, 0.06);
}
.rf-blk--selected::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: var(--rf-accent, #3a6df0);
  border-top-left-radius: inherit; border-bottom-left-radius: inherit;
}

.rf-block--selected {
  position: relative;
  background: rgba(70, 110, 220, 0.06);
  padding-left: 12px;
  margin-left: -12px;
  border-left: 3px solid var(--rf-accent, #3a6df0);
}
```

实际颜色优先复用 [css/base.css](../../../css/base.css) 已有的 `--rf-*` 主题 token。两侧表现一致(左竖条 + 浅底色)。

预览列规则要写到 iframe 内的样式上下文,这里通过 **预览模板自身的 CSS 文件**或**preview.js 的 baseDoc 内联样式**注入二选一。选 baseDoc 内联,理由:模板可有多套(三个模板各一套 CSS),写在每个模板里就要改 3 个文件;baseDoc 一处加完毕全模板生效。

> **修订**:baseDoc 是 preview.js 内部字符串,改它等于改 preview.js。可以接受 —— preview.js 的 baseDoc 函数本就是为 iframe 提供基础样式而存在,加一段块高亮样式属于其职责范畴。

## 边界情况

| 情形 | 处理 |
|------|------|
| 点击空章节(只有 "+ 文本"工具行) | `.rf-blk`.closest 找不到 → return |
| iframe 未 ready | 预览侧 query 返回 0 → 编辑列照常,等 `preview:rendered` 重涂 |
| 用户删除当前选中块 | 重渲染时定位失败 → `selected = null` |
| 模板切换 | iframe 重建 → `preview:rendered` 触发 → 重涂(若坐标仍有效) |
| 预览中点 `<a>` 链接 | closest 命中 a → return,链接照常工作 |
| 编辑列点 `↑↓ 移动 / 删除` 按钮 | closest 命中 button → return,块操作照常 |
| 用户在文本框中输入 | INPUT/TEXTAREA 排除 → 不触发高亮 |
| 块内含 echarts canvas 点击 | canvas 不在排除列表中 → 触发选中(期望行为,canvas 自身无点击交互) |

## 不做的事(YAGNI)

- 不做键盘导航(↑/↓ 选块)。
- 不在 state 里持久化 selected。会话内有效。
- 不做"块外点击 = 取消选中"。"再点同一块" 已能取消;空白处不响应。
- 不做章节级高亮 —— 已有滚动联动负责章节定位。
- 不做选中后的额外面板/工具栏 —— 仅视觉锚点。

## 接口

```js
window.RF_BlockHighlight = {
  init: function () {},
};
```

无对外可调用方法。所有交互通过事件被动驱动。

```js
window.RF_ScrollSync = {
  init: function () {},
  acquireLock: function (side) {},  // 新增,供 block-highlight 使用
};
```

## 测试要点(手工)

- 载入示例,在编辑列点击某文本块 → 编辑列该块和预览列对应块同时亮。
- 反向:在预览列点击某图表块 → 预览块和编辑块同时亮。
- 同块再点 → 两侧高亮都消失。
- 点别的块 → 高亮转移,不残留。
- 编辑列文本框获焦输入字符 → 不触发高亮(高亮保持当前状态)。
- 编辑列点 ↑↓ 删除按钮 → 块照常移动/删除,不触发高亮。
- 当前选中块滚出视口后,在另一侧再次点击该块 → 不滚动(因为另一侧本来在视口内);若另一侧也不在视口,则滚到视野。
- 编辑列点击块 A,然后切换模板 → iframe 重建后,预览列对应块仍亮(假设模板渲染产生同序块)。
- 删除当前选中块 → 高亮消失,无残留 class。
- 点击预览中的 `<a>` 或编辑里的按钮 → 控件正常工作,不触发高亮。

## 文件清单

| 路径 | 变更 |
|------|------|
| `js/modules/block-highlight.js` | 新增 |
| `js/modules/scroll-sync.js` | `acquireLock` 改为暴露在 `window.RF_ScrollSync` |
| `js/modules/editor.js` | `render()` 末尾 `bus.emit("editor:rendered")` |
| `js/modules/preview.js` | `baseDoc()` 内联追加 `.rf-block--selected` 样式 |
| `css/components.css` | 追加 `.rf-blk--selected` 样式 |
| `index.html` | 追加 `<script defer src="js/modules/block-highlight.js">` |
| `js/core/bootstrap.js` | 调用 `RF_BlockHighlight.init()` |
