/**
 * config-manager.js — LLM configuration UI + persistence + validation.
 *
 * Two parallel LLM configs:
 *   - 文本模型 (state "config.llm")     — parsing, JSON repair, highlight, etc.
 *   - 多模态模型 (state "config.llm.vision") — image → chart recognition.
 *
 * The settings modal exposes them as two tabs. Shape of each config is
 * identical (OpenAI-compatible /chat/completions + optional Dify Chatflow):
 *   { preset, api, baseUrl, apiKey, model, temperature, maxTokens, timeoutMs, rps, corsProxy }
 *
 * Includes a "测试连接" button that fires RF_LLM.test(cfg) and surfaces a
 * tailored CORS hint on failure.
 */
(function () {
  "use strict";

  var bus     = window.RF_Bus;
  var state   = window.RF_State;
  var storage = window.RF_Storage;
  var log     = window.RF_Log;

  // ---- 文本模型 预设 ----
  var TEXT_PRESETS = [
    {
      id: "deepseek", label: "DeepSeek（推荐 / CORS 友好）",
      baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
      hint: "OpenAI 兼容，国内访问稳定，浏览器可直连。"
    },
    {
      id: "moonshot", label: "Moonshot Kimi（CORS 友好）",
      baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k",
      hint: "国内月之暗面，浏览器通常可直连。"
    },
    {
      id: "zhipu", label: "智谱 GLM（CORS 一般友好）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash",
      hint: "兼容模式，多数情况可浏览器直连。"
    },
    {
      id: "ollama-local", label: "本地 Ollama（默认 11434）",
      baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b",
      hint: "需启动 OLLAMA_ORIGINS=* ollama serve。完全离线。"
    },
    {
      id: "openai", label: "OpenAI（⚠ 通常需要代理）",
      baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
      hint: "浏览器直连一般会被 CORS 拦截，请配合 CORS 代理使用。"
    },
    {
      id: "tongyi", label: "通义千问 DashScope（⚠ 需代理）",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-turbo",
      hint: "浏览器直连通常被拒，请配合 CORS 代理使用。"
    },
    {
      id: "dify-chatflow", label: "Dify Chatflow（工作流编排）",
      api: "dify",
      baseUrl: "https://api.dify.ai/v1", model: "",
      hint: "对接 Dify Chatflow 应用：模型与提示词已在 Dify 端配置，此处无需填模型名。只需填 Dify 应用的 API 服务地址（形如 https://api.dify.ai/v1）与该应用的 API 密钥（App API Key，形如 app-…），客户端会按 Dify /chat-messages 规范请求。"
    },
    {
      id: "custom", label: "自定义 OpenAI 兼容端点",
      baseUrl: "", model: "",
      hint: "任何兼容 /chat/completions 的端点。"
    }
  ];

  // ---- 多模态模型 预设（视觉模型，仅列已知支持图片输入的） ----
  var VISION_PRESETS = [
    {
      id: "zhipu-glm4v", label: "智谱 GLM-4V（CORS 友好）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-plus",
      hint: "智谱多模态系列，浏览器通常可直连。也可改成 glm-4v / glm-4.5v。"
    },
    {
      id: "moonshot-vision", label: "Moonshot Kimi Vision（CORS 友好）",
      baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview",
      hint: "月之暗面视觉模型预览版，浏览器通常可直连。"
    },
    {
      id: "qwen-vl", label: "通义千问 VL（DashScope / ⚠ 需代理）",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-vl-plus",
      hint: "阿里通义多模态，也可填 qwen-vl-max / qwen2.5-vl-72b-instruct。浏览器直连通常被拒，请配合 CORS 代理使用。"
    },
    {
      id: "doubao-vision", label: "字节豆包 Vision（火山方舟）",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-1-5-vision-pro-32k",
      hint: "火山方舟视觉模型。模型 ID 以你在控制台开通的实际 endpoint 为准。"
    },
    {
      id: "openai-vision", label: "OpenAI GPT-4o（⚠ 通常需要代理）",
      baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini",
      hint: "支持视觉的 GPT-4o / GPT-4o-mini。浏览器直连一般会被 CORS 拦截，请配合 CORS 代理使用。"
    },
    {
      id: "ollama-vision-local", label: "本地 Ollama（视觉模型）",
      baseUrl: "http://localhost:11434/v1", model: "qwen2.5vl:7b",
      hint: "需启动 OLLAMA_ORIGINS=* ollama serve，并拉取 qwen2.5vl / llava 等视觉模型。"
    },
    {
      id: "custom-vision", label: "自定义 OpenAI 兼容端点（视觉）",
      baseUrl: "", model: "",
      hint: "任何兼容 /chat/completions 且接受 image_url 内容的端点。"
    }
  ];

  // Preset id -> API protocol. Anything not listed defaults to "openai"
  // (the OpenAI-compatible /chat/completions schema). "dify" routes through
  // the Dify Chatflow /chat-messages schema instead.
  function presetApi(presets, id) {
    var p = presets.find(function (x) { return x.id === id; });
    return (p && p.api) || "openai";
  }

  var TEXT_DEFAULTS = {
    preset:      "deepseek",
    api:         "openai",
    baseUrl:     "https://api.deepseek.com/v1",
    apiKey:      "",
    model:       "deepseek-chat",
    temperature: 0.3,
    maxTokens:   2048,
    timeoutMs:   60000,
    rps:         1,
    corsProxy:   ""
  };

  var VISION_DEFAULTS = {
    preset:      "zhipu-glm4v",
    api:         "openai",
    baseUrl:     "https://open.bigmodel.cn/api/paas/v4",
    apiKey:      "",
    model:       "glm-4v-plus",
    temperature: 0.1,
    // 视觉模型通常输出 JSON 比较短，但用 2048 给个安全余量。
    maxTokens:   2048,
    // 视觉识别更慢，超时给到 90s。
    timeoutMs:   90000,
    rps:         1,
    corsProxy:   ""
  };

  var REPORT_DEFAULTS = {
    showFooter:   true,
    footerText:   "—— 本报告由 ReportFlow 生成 ——"
  };

  // Preset thresholds for the "最大生成长度" dropdown. Covers short replies up
  // to long reasoning outputs; chosen as common power-of-two checkpoints so
  // users don't have to think about exact token counts.
  var MAX_TOKEN_OPTIONS = [
    { value: 1024,  label: "1024（短回复）" },
    { value: 2048,  label: "2048（默认）" },
    { value: 4096,  label: "4096" },
    { value: 8192,  label: "8192（长输出）" },
    { value: 16384, label: "16384（推理类模型）" }
  ];

  function init() {
    // Load saved text-model config (if any) into state.
    var saved = storage.get("config", "llm", null);
    var cfg = saved || TEXT_DEFAULTS;
    state.set("config.llm", cfg);

    // Load saved vision-model config; fall back to defaults if missing.
    var savedVision = storage.get("config", "llm.vision", null);
    var visionCfg = savedVision || VISION_DEFAULTS;
    state.set("config.llm.vision", visionCfg);

    // Load report config.
    var reportSaved = storage.get("config", "report", null);
    var reportCfg = reportSaved || REPORT_DEFAULTS;
    state.set("config.report", reportCfg);

    var btn = document.getElementById("rf-btn-settings");
    if (btn) btn.addEventListener("click", openModal);
  }

  function get() { return state.get("config.llm") || TEXT_DEFAULTS; }

  // True when the active text-model config has everything it needs.
  // Dify Chatflow has the model configured inside the workflow, so the model
  // name is not required there.
  function isConfigured(cfg) {
    var c = cfg || get();
    if (!c || !c.baseUrl || !c.apiKey) return false;
    if (c.api === "dify") return true;
    return !!c.model;
  }

  function save(cfg) {
    state.set("config.llm", cfg);
    storage.set("config", "llm", cfg);
    bus.emit("config:saved", cfg);
  }

  function getVision() { return state.get("config.llm.vision") || VISION_DEFAULTS; }

  function isConfiguredVision(cfg) {
    var c = cfg || getVision();
    if (!c || !c.baseUrl || !c.apiKey) return false;
    if (c.api === "dify") return true;
    return !!c.model;
  }

  function saveVision(cfg) {
    state.set("config.llm.vision", cfg);
    storage.set("config", "llm.vision", cfg);
    bus.emit("config:vision:saved", cfg);
  }

  function getReport() { return state.get("config.report") || REPORT_DEFAULTS; }

  function saveReport(cfg) {
    state.set("config.report", cfg);
    storage.set("config", "report", cfg);
    bus.emit("config:report:saved", cfg);
    // Footer text/visibility affects the rendered output — force a re-render.
    bus.emit("preview:force", {});
  }

  // ===== Modal =====

  function openModal(opts) {
    opts = opts || {};
    var initialTab = opts.tab === "vision" ? "vision" : "text";

    var body = document.createElement("div");

    // ----- Tab bar -----
    var tabs = document.createElement("div");
    tabs.className = "rf-tabs";
    tabs.style.cssText = "display:flex;gap:4px;border-bottom:1px solid var(--rf-line);margin-bottom:14px";

    function makeTab(key, label) {
      var t = document.createElement("button");
      t.type = "button";
      t.className = "rf-tab";
      t.dataset.tab = key;
      t.textContent = label;
      t.style.cssText = "background:transparent;border:none;padding:8px 14px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent;color:var(--rf-text-muted);margin-bottom:-1px";
      return t;
    }
    var tabText   = makeTab("text",   "文本模型");
    var tabVision = makeTab("vision", "多模态模型");
    tabs.appendChild(tabText);
    tabs.appendChild(tabVision);
    body.appendChild(tabs);

    // ----- Two panels -----
    var textPanel   = document.createElement("div");
    var visionPanel = document.createElement("div");

    var textCfg   = Object.assign({}, TEXT_DEFAULTS,   get());
    var visionCfg = Object.assign({}, VISION_DEFAULTS, getVision());

    var textForm   = buildLLMForm(textPanel,   textCfg,   TEXT_PRESETS,   TEXT_DEFAULTS,   { kind: "text" });
    var visionForm = buildLLMForm(visionPanel, visionCfg, VISION_PRESETS, VISION_DEFAULTS, { kind: "vision" });

    body.appendChild(textPanel);
    body.appendChild(visionPanel);

    function activate(key) {
      var isVision = key === "vision";
      textPanel.style.display   = isVision ? "none" : "";
      visionPanel.style.display = isVision ? "" : "none";
      [tabText, tabVision].forEach(function (t) {
        var active = t.dataset.tab === key;
        t.style.borderBottomColor = active ? "var(--rf-accent)" : "transparent";
        t.style.color = active ? "var(--rf-accent-strong)" : "var(--rf-text-muted)";
        t.style.fontWeight = active ? "600" : "400";
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    tabText.addEventListener("click",   function () { activeTab = "text";   activate("text"); });
    tabVision.addEventListener("click", function () { activeTab = "vision"; activate("vision"); });
    var activeTab = initialTab;
    activate(activeTab);

    // ----- 报告设置 (shared, below the tabs) -----
    var reportDiv = document.createElement("div");
    reportDiv.style.cssText = "margin-top:20px;padding-top:16px;border-top:1px solid var(--rf-line)";
    var reportTitle = document.createElement("div");
    reportTitle.className = "rf-field__label";
    reportTitle.style.cssText = "font-size:13px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;color:var(--rf-text-muted)";
    reportTitle.textContent = "报告设置";
    reportDiv.appendChild(reportTitle);

    var reportCfg = Object.assign({}, REPORT_DEFAULTS, getReport());
    var showFooterCheck = document.createElement("input");
    showFooterCheck.type = "checkbox";
    showFooterCheck.className = "rf-checkbox";
    showFooterCheck.checked = reportCfg.showFooter;
    var showFooterWrap = document.createElement("label");
    showFooterWrap.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px";
    showFooterWrap.appendChild(showFooterCheck);
    showFooterWrap.appendChild(document.createTextNode("显示底部生成标识"));
    reportDiv.appendChild(showFooterWrap);

    var footerTextInp = document.createElement("input");
    footerTextInp.type = "text";
    footerTextInp.className = "rf-input";
    footerTextInp.style.marginTop = "8px";
    footerTextInp.value = reportCfg.footerText;
    footerTextInp.placeholder = "—— 本报告由 ReportFlow 生成 ——";
    reportDiv.appendChild(footerTextInp);
    var footerHint = document.createElement("span");
    footerHint.className = "rf-field__hint";
    footerHint.style.cssText = "display:block;margin-top:4px";
    footerHint.textContent = "显示在每页报告底部的文字。取消勾选则不显示。导出（PDF/PNG/HTML）同步生效。";
    reportDiv.appendChild(footerHint);
    function syncFooterDisabled() { footerTextInp.disabled = !showFooterCheck.checked; }
    showFooterCheck.addEventListener("change", syncFooterDisabled);
    syncFooterDisabled();

    body.appendChild(reportDiv);

    // ----- Shared test result box -----
    var testBox = document.createElement("div");
    testBox.style.cssText = "margin-top:6px;font-size:12px;color:var(--rf-text-muted);min-height:18px;";
    body.appendChild(testBox);

    // ----- Footer buttons -----
    var foot = document.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;width:100%;justify-content:space-between;align-items:center";

    var leftFoot = document.createElement("div");
    var resetBtn = document.createElement("button");
    resetBtn.className = "rf-btn rf-btn--ghost";
    resetBtn.textContent = "恢复默认";
    resetBtn.title = "把当前选中的标签页恢复为默认值；报告设置也会一起恢复。";
    leftFoot.appendChild(resetBtn);

    var rightFoot = document.createElement("div");
    rightFoot.style.cssText = "display:flex;gap:8px";
    var testBtn = document.createElement("button");
    testBtn.className = "rf-btn rf-btn--ghost";
    testBtn.textContent = "测试连接";
    testBtn.title = "测试当前选中的标签页对应模型的连通性";
    rightFoot.appendChild(testBtn);
    var saveBtn = document.createElement("button");
    saveBtn.className = "rf-btn rf-btn--primary";
    saveBtn.textContent = "保存";
    saveBtn.title = "保存两个标签页的全部配置";
    rightFoot.appendChild(saveBtn);

    foot.appendChild(leftFoot);
    foot.appendChild(rightFoot);

    var modal = window.RF_UI.modal.open({
      title: "设置",
      bodyEl: body,
      footerEl: foot,
      size: "lg"
    });

    function activeForm() { return activeTab === "vision" ? visionForm : textForm; }

    resetBtn.addEventListener("click", function () {
      activeForm().reset();
      showFooterCheck.checked = REPORT_DEFAULTS.showFooter;
      footerTextInp.value = REPORT_DEFAULTS.footerText;
      syncFooterDisabled();
    });

    testBtn.addEventListener("click", function () {
      var f = activeForm();
      var c = f.gather();
      var errs = f.validate(c);
      if (errs.length) {
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ " + errs.join("；");
        return;
      }
      testBox.style.color = "var(--rf-text-muted)";
      testBox.textContent = "测试中…（" + (activeTab === "vision" ? "多模态" : "文本") + "模型）";
      // 直接把这份配置传给 RF_LLM.test，不污染 state。
      window.RF_LLM.test(c).then(function (r) {
        if (r.ok) {
          testBox.style.color = "var(--rf-ok)";
          testBox.textContent = "✓ 连接成功（reply: " + (r.reply || "").slice(0, 60) + "）";
        } else {
          testBox.style.color = "var(--rf-warn)";
          testBox.textContent = "△ 接口已通但返回空内容。可能原因：① 模型是 reasoning 类型且最大长度过小（试着把「最大生成长度」调到 ≥ 1024）；② 当前模型不允许 temperature=0；③ 模型名拼写错误。";
        }
      }).catch(function (err) {
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ " + (err && err.message || err);
      });
    });

    saveBtn.addEventListener("click", function () {
      var tc = textForm.gather();
      var vc = visionForm.gather();
      var tErrs = textForm.validate(tc);
      var vErrs = visionForm.validate(vc);
      // 多模态是可选功能：只有当用户填了 baseUrl 或 apiKey 任一项才校验它；
      // 完全空白时允许保存（视作未启用）。
      var visionStarted = (vc.baseUrl && vc.baseUrl.length) || (vc.apiKey && vc.apiKey.length);

      if (tErrs.length) {
        activeTab = "text"; activate("text");
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ 文本模型：" + tErrs.join("；");
        return;
      }
      if (visionStarted && vErrs.length) {
        activeTab = "vision"; activate("vision");
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ 多模态模型：" + vErrs.join("；");
        return;
      }
      save(tc);
      saveVision(vc);
      saveReport({
        showFooter: showFooterCheck.checked,
        footerText: footerTextInp.value.trim() || REPORT_DEFAULTS.footerText
      });
      window.RF_UI.toast.ok("配置已保存");
      modal.close();
    });
  }

  /**
   * 构建一份 LLM 配置表单（文本 / 多模态共用），写入 host 容器。
   * 返回 { gather, validate, reset }。
   */
  function buildLLMForm(host, current, presets, defaults, options) {
    options = options || {};
    var isVision = options.kind === "vision";

    // Preset row
    var presetSel = document.createElement("select");
    presetSel.className = "rf-select";
    presets.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.label;
      if (p.id === current.preset) o.selected = true;
      presetSel.appendChild(o);
    });
    host.appendChild(field("供应商预设", presetSel,
      isVision
        ? "切换预设会预填 API 地址 / 模型名。仅列入已知支持图片输入的多模态模型；带 ⚠ 的预设浏览器直连会被 CORS 拦截，需要配合「CORS 代理」字段。"
        : "切换预设会预填 API 地址 / 模型名。带 ⚠ 的预设通常浏览器直连会被 CORS 拦截，需要配合「CORS 代理」字段。"
    ));

    var hintBox = document.createElement("div");
    hintBox.className = "rf-field__hint";
    hintBox.style.cssText = "background:var(--rf-accent-soft);padding:6px 10px;border-radius:4px;color:var(--rf-accent-strong);";
    hintBox.textContent = (presets.find(function (p) { return p.id === current.preset; }) || {}).hint || "";
    host.appendChild(hintBox);

    var baseUrl = inputText(current.baseUrl, "https://api.example.com/v1");
    var baseUrlField = field("API 地址 (baseUrl)", baseUrl, "应为以 /v1 等结尾的 OpenAI 兼容根；客户端会自动追加 /chat/completions。");
    var baseUrlHint = baseUrlField.querySelector(".rf-field__hint");
    host.appendChild(baseUrlField);

    var apiKey = inputText(current.apiKey, "sk-…", true);
    var apiKeyWrap = wrapWithToggle(apiKey);
    host.appendChild(field("API 密钥", apiKeyWrap, "明文存储于浏览器 localStorage，仅在本地。点击右侧按钮切换显示/隐藏。"));

    var model = inputText(current.model, defaults.model || "model-id");
    var modelField = field("模型名", model,
      isVision ? "需要支持视觉输入（accept image_url）的模型 ID。常见：gpt-4o / qwen-vl-plus / glm-4v / doubao-vision 等。" : null);
    host.appendChild(modelField);

    var row = document.createElement("div"); row.className = "rf-field-row";
    var temp = inputNumber(current.temperature, 0, 2, 0.05);
    row.appendChild(field("Temperature", temp,
      isVision ? "0 ~ 2，图片识别建议 0.1 以降低幻觉。" : "0 ~ 2，解析建议 0.2"));
    var maxT = inputSelect(current.maxTokens, MAX_TOKEN_OPTIONS);
    row.appendChild(field("最大生成长度 (tokens)", maxT, "1024 适合短回复；2048（默认）适合解析；推理类模型建议 ≥ 4096"));
    host.appendChild(row);
    var genParamsRow = row;

    var row2 = document.createElement("div"); row2.className = "rf-field-row";
    var timeout = inputNumber(current.timeoutMs, 5000, 600000, 1000);
    row2.appendChild(field("超时 (ms)", timeout,
      isVision ? "视觉识别通常较慢，建议 ≥ 60000。" : null));
    var rps = inputNumber(current.rps, 0.1, 10, 0.1);
    row2.appendChild(field("速率上限 (req/s)", rps));
    host.appendChild(row2);

    var corsProxy = inputText(current.corsProxy, "https://your-proxy.example.com/?url=");
    host.appendChild(field("CORS 代理 URL（可选）", corsProxy,
      "若勾上面带 ⚠ 的预设、或浏览器直连失败时填写。常见格式末尾为 ?url=，客户端会把真实 API URL 编码后追加。⚠ 不要把真实密钥发给陌生公共代理。"));

    function syncApiUI() {
      var api = presetApi(presets, presetSel.value);
      var isDify = (api === "dify");
      modelField.style.display = isDify ? "none" : "";
      genParamsRow.style.display = isDify ? "none" : "";
      if (baseUrlHint) {
        baseUrlHint.textContent = isDify
          ? "填 Dify 应用的 API 服务地址（形如 https://api.dify.ai/v1）；客户端会自动追加 /chat-messages。"
          : "应为以 /v1 等结尾的 OpenAI 兼容根；客户端会自动追加 /chat/completions。";
      }
    }
    syncApiUI();

    presetSel.addEventListener("change", function () {
      var p = presets.find(function (x) { return x.id === presetSel.value; }) || {};
      hintBox.textContent = p.hint || "";
      // "custom" 类预设保留用户已填的 baseUrl / model
      if (p.id !== "custom" && p.id !== "custom-vision") {
        baseUrl.value = p.baseUrl || "";
        if (p.model) model.value = p.model;
      }
      syncApiUI();
    });

    function gather() {
      return {
        preset:      presetSel.value,
        api:         presetApi(presets, presetSel.value),
        baseUrl:     baseUrl.value.trim(),
        apiKey:      apiKey.value.trim(),
        model:       model.value.trim(),
        temperature: Number(temp.value) || 0,
        maxTokens:   Number(maxT.value) || 2048,
        timeoutMs:   Number(timeout.value) || 60000,
        rps:         Number(rps.value) || 1,
        corsProxy:   corsProxy.value.trim()
      };
    }
    function validate(c) {
      var errs = [];
      if (!/^https?:\/\//i.test(c.baseUrl)) errs.push("API 地址需以 http(s):// 开头");
      if (!c.apiKey) errs.push("缺少 API 密钥");
      if (c.api !== "dify" && !c.model) errs.push("缺少模型名");
      if (c.temperature < 0 || c.temperature > 2) errs.push("Temperature 应在 0~2");
      return errs;
    }
    function reset() {
      presetSel.value = defaults.preset;
      baseUrl.value = defaults.baseUrl;
      apiKey.value = "";
      model.value = defaults.model;
      temp.value = defaults.temperature;
      maxT.value = String(defaults.maxTokens);
      timeout.value = defaults.timeoutMs;
      rps.value = defaults.rps;
      corsProxy.value = "";
      hintBox.textContent = (presets.find(function (p) { return p.id === defaults.preset; }) || {}).hint || "";
      syncApiUI();
    }

    return { gather: gather, validate: validate, reset: reset };
  }

  // ===== Tiny form helpers =====
  function field(label, control, hint) {
    var w = document.createElement("label");
    w.className = "rf-field";
    var l = document.createElement("span"); l.className = "rf-field__label"; l.textContent = label;
    w.appendChild(l); w.appendChild(control);
    if (hint) { var h = document.createElement("span"); h.className = "rf-field__hint"; h.textContent = hint; w.appendChild(h); }
    return w;
  }
  function inputText(value, placeholder, isPassword) {
    var i = document.createElement("input");
    i.type = isPassword ? "password" : "text";
    i.className = "rf-input"; i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    if (isPassword) {
      // Allow toggling visibility: shift-click to flip type.
      i.title = "Shift+点击切换显示";
      i.addEventListener("click", function (e) {
        if (e.shiftKey) i.type = i.type === "password" ? "text" : "password";
      });
    }
    return i;
  }
  // Wrap a password input with an eye-toggle icon button on the right side.
  // Uses inline SVG so the icon renders identically across platforms (no emoji
  // font fallback). Two paths: an open-eye and a struck-through eye.
  function wrapWithToggle(inputEl) {
    var SVG_NS = "http://www.w3.org/2000/svg";
    var EYE_OPEN_D = "M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z";
    var EYE_OFF_D  = "M2 4l18 18M6.5 7.6C3.7 9.3 1.7 11.7 1 13c1 2.5 5 6 10 6 1.7 0 3.3-.4 4.7-1.1M9.9 5.2C10.6 5.1 11.3 5 12 5c5 0 9 3.5 10 6-.5 1.2-1.6 2.7-3.2 4M14.1 14.1A3 3 0 0 1 9.9 9.9";

    function makeSvg(d) {
      var svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      var p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
      return svg;
    }

    var wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:flex;align-items:center;width:100%";
    inputEl.style.flex = "1";
    inputEl.style.paddingRight = "36px";
    wrap.appendChild(inputEl);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rf-btn rf-btn--ghost rf-input-eye";
    btn.setAttribute("aria-label", "显示密钥");
    btn.setAttribute("aria-pressed", "false");
    btn.title = "显示/隐藏密钥";
    btn.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:4px;height:auto;min-width:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--rf-text-muted);cursor:pointer";
    btn.appendChild(makeSvg(EYE_OFF_D));

    btn.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep input focus
    btn.addEventListener("click", function () {
      var show = inputEl.type === "password";
      inputEl.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      btn.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
      btn.replaceChildren(makeSvg(show ? EYE_OPEN_D : EYE_OFF_D));
    });
    wrap.appendChild(btn);
    return wrap;
  }
  function inputNumber(value, min, max, step) {
    var i = document.createElement("input");
    i.type = "number"; i.className = "rf-input";
    i.value = value; i.min = min; i.max = max; i.step = step;
    return i;
  }
  function inputSelect(value, options) {
    var s = document.createElement("select");
    s.className = "rf-select";
    var matched = false;
    options.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      if (Number(value) === Number(opt.value)) { o.selected = true; matched = true; }
      s.appendChild(o);
    });
    // If a saved value isn't in the preset list (legacy config), fall back to
    // the default option so the dropdown isn't blank.
    if (!matched && options.length) s.value = String(options[1] ? options[1].value : options[0].value);
    return s;
  }

  window.RF_ConfigManager = {
    init: init,
    get: get, save: save, isConfigured: isConfigured,
    getVision: getVision, saveVision: saveVision, isConfiguredVision: isConfiguredVision,
    getReport: getReport, saveReport: saveReport,
    openModal: openModal
  };
})();
