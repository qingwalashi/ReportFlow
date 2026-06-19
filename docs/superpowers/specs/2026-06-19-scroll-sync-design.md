# 编辑列与预览列联动滚动 — 设计

**日期**: 2026-06-19
**范围**: 中间结构化编辑列(`.rf-edit-scroll`)与右侧实时预览列(`#rf-preview-frame` 内 `#root`)的滚动联动。

## 目标

用户在中间编辑列滚动到某章节时,右侧预览自动滚到对应章节顶部;反之亦然。让"在哪里编辑 / 在哪里看"始终对齐,免去手动定位。

## 选型决策(已与用户确认)

| 维度 | 选择 |
|------|------|
| 对齐粒度 | **按章节(section)对齐** |
| 联动方向 | **双向**(编辑 ↔ 预览) |
| 对齐基准点 | **活跃章节判定 + 顶部对齐**(取与视口相交面积最大的章节) |
| 抑制时机 | 编辑列 input/textarea 聚焦时,**不**主动同步右侧 |
| 节流策略 | **requestAnimationFrame** 节流;互斥锁 ~150ms 防回环 |

## 模块划分

新增独立模块 `js/modules/scroll-sync.js`。**不**修改 [editor.js](../../../js/modules/editor.js) 和 [preview.js](../../../js/modules/preview.js) 的核心逻辑,只通过它们已有的 DOM 锚点接入。

- 在 [index.html](../../../index.html) 的 `<script defer>` 列表里追加,位置在 `editor.js` 之后、`bootstrap.js` 之前。
- 在 [bootstrap.js](../../../js/core/bootstrap.js) 中调用 `RF_ScrollSync.init()`,时机:`RF_Preview.init()` 之后。

## DOM 锚点

### 左侧(编辑列)
- 滚动容器:`.rf-edit-scroll`
- 章节元素:`#rf-editor-root > .rf-sec`(按 DOM 顺序即业务索引)

### 右侧(预览列,iframe 内)
- 滚动容器:`iframe.contentDocument.scrollingElement`(等价于 `documentElement` 或 `body`,以浏览器为准)
- 章节元素:`iframe.contentDocument.querySelectorAll('#root > section.rf-section')`

### 章节标识对齐
两侧均按 DOM 出现顺序索引(`index = 0..N-1`),不依赖 id 或新增字段。`report.sections` 是有序数组,左右两侧都按相同顺序渲染,索引天然对齐 —— 不侵入 schema。

## 核心数据流

```
scroll on side A
    ↓ rAF 节流(每帧最多一次)
若 lockSide === A,return(本次是被动滚)
    ↓
若 A 是编辑列且 activeElement 是其内部 input/textarea,return
    ↓
计算 A 中"活跃章节 index":遍历 A 的章节,取与 A 视口相交面积最大者
    ↓
读取 B 中第 index 个章节(夹取至 [0, B.count-1])
    ↓
计算其顶部相对 B 滚动容器的偏移 targetTop
    ↓
设置 lockSide = B,启动 150ms timeout 释放
B.scrollContainer.scrollTo({ top: targetTop, behavior: 'auto' })
```

## 抑制条件

任一满足,本次 scroll 不向对方传播:

1. `lockSide === thisSide` —— 对方刚同步过来,正在被动滚。
2. 仅"编辑列 → 预览列"方向:`document.activeElement` 是 `INPUT`/`TEXTAREA` 且位于 `.rf-edit-scroll` 子树。
3. 任一侧章节数为 0,或 A 的 `scrollHeight <= clientHeight`(没东西可滚)。

## 事件接入

- `.rf-edit-scroll` 上 `scroll` 监听(passive)。
- iframe `contentWindow` 上 `scroll` 监听(passive)。
- **iframe 重建后必须重绑**:监听 `bus.on("preview:rendered", ...)`,在每次预览渲染后:
  - 检查上次绑定的 `contentWindow` 是否仍是当前 iframe 的 `contentWindow`。
  - 不一致时,旧引用作废(随 iframe 销毁自然回收),重新在新 `contentWindow` 上绑定。

## 边界情况

| 情形 | 处理 |
|------|------|
| iframe 尚未 ready | 检查 `iframe.contentDocument`,无则跳过本次同步。 |
| 左右章节数不等(预览 debounce 150ms 中间态) | `Math.min(leftCount, rightCount)` 夹取 index。 |
| 极短报告(`scrollHeight <= clientHeight`) | 直接 return。 |
| 单章节 / 空章节 | 索引为 0 仍可工作;空报告 return。 |
| iframe 内 find-in-page 触发的 scroll | 与用户主动滚动同等处理(期望行为)。 |
| 模板切换 | iframe 重建 → 重新绑定监听(已覆盖)。 |

## 不做的事(YAGNI)

- 不做平滑动画 `behavior: 'smooth'` —— 双向联动时会与用户下一次拖动冲突,造成"滑过头"。
- 不持久化"是否启用"开关。
- 不做块级(block)对齐。后续可平滑演进:给 block 加 `data-block-index` 即可,不动现有索引计算。
- 不在编辑列加"当前章节"视觉高亮 —— 独立 feature。

## 接口

```js
window.RF_ScrollSync = {
  init: function () { /* 注册 scroll 监听、bus 订阅 */ },
};
```

无对外可调用方法。所有联动通过事件被动驱动。

## 测试要点(手工)

- 用"载入示例"装入多章节报告。
- 滚动编辑列向下,预览列跟随;停下时两侧顶部对齐到同一章节。
- 滚动预览列向下,编辑列跟随。
- 编辑列某章节标题输入框聚焦时,在编辑列内拖动滚轮,只滚自己,右侧不动。失焦后再滚,恢复联动。
- 切换模板(iframe 重建)后,联动仍工作。
- 空报告(清空所有章节)不报错;单章节报告滚动正常。
- 快速反复来回拖动,无可见回弹/抖动。

## 文件清单

| 路径 | 变更 |
|------|------|
| `js/modules/scroll-sync.js` | 新增 |
| `index.html` | 追加 `<script defer src="js/modules/scroll-sync.js">` |
| `js/core/bootstrap.js` | 调用 `RF_ScrollSync.init()` |
