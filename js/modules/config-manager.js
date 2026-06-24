/**
 * config-manager.js — LLM configuration UI + persistence + validation.
 *
 * State key: "config.llm"
 *   { preset, baseUrl, apiKey, model, temperature, maxTokens, timeoutMs, rps, corsProxy }
 *
 * The UI is a modal opened by the topbar gear button. Includes a "测试连接"
 * button that fires RF_LLM.test() and surfaces a tailored CORS hint on failure.
 */
(function () {
  "use strict";

  var bus     = window.RF_Bus;
  var state   = window.RF_State;
  var storage = window.RF_Storage;
  var log     = window.RF_Log;

  var PRESETS = [
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

  // Preset id -> API protocol. Anything not listed defaults to "openai"
  // (the OpenAI-compatible /chat/completions schema). "dify" routes through
  // the Dify Chatflow /chat-messages schema instead.
  function presetApi(id) {
    var p = PRESETS.find(function (x) { return x.id === id; });
    return (p && p.api) || "openai";
  }

  var DEFAULTS = {
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
    // Load saved config (if any) into state.
    var saved = storage.get("config", "llm", null);
    var cfg = saved || DEFAULTS;
    state.set("config.llm", cfg);

    // Load report config.
    var reportSaved = storage.get("config", "report", null);
    var reportCfg = reportSaved || REPORT_DEFAULTS;
    state.set("config.report", reportCfg);

    var btn = document.getElementById("rf-btn-settings");
    if (btn) btn.addEventListener("click", openModal);
  }

  function get() { return state.get("config.llm") || DEFAULTS; }

  // True when the active LLM config has everything it needs to make a call.
  // Dify Chatflow has its model configured inside the workflow, so the model
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

  function getReport() { return state.get("config.report") || REPORT_DEFAULTS; }

  function saveReport(cfg) {
    state.set("config.report", cfg);
    storage.set("config", "report", cfg);
    bus.emit("config:report:saved", cfg);
    // Footer text/visibility affects the rendered output — force a re-render.
    bus.emit("preview:force", {});
  }

  function openModal() {
    var current = Object.assign({}, DEFAULTS, get());

    var body = document.createElement("div");

    // Preset row
    var presetSel = document.createElement("select");
    presetSel.className = "rf-select";
    PRESETS.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.label;
      if (p.id === current.preset) o.selected = true;
      presetSel.appendChild(o);
    });
    body.appendChild(field("供应商预设", presetSel,
      "切换预设会预填 API 地址 / 模型名。带 ⚠ 的家通常浏览器直连会被 CORS 拦截，需要配合「CORS 代理」字段。"));

    var hintBox = document.createElement("div");
    hintBox.className = "rf-field__hint";
    hintBox.style.cssText = "background:var(--rf-accent-soft);padding:6px 10px;border-radius:4px;color:var(--rf-accent-strong);";
    hintBox.textContent = (PRESETS.find(function (p) { return p.id === current.preset; }) || {}).hint || "";
    body.appendChild(hintBox);

    // Inputs
    var baseUrl = inputText(current.baseUrl, "https://api.example.com/v1");
    var baseUrlField = field("API 地址 (baseUrl)", baseUrl, "应为以 /v1 等结尾的 OpenAI 兼容根；客户端会自动追加 /chat/completions。");
    var baseUrlHint = baseUrlField.querySelector(".rf-field__hint");
    body.appendChild(baseUrlField);

    var apiKey = inputText(current.apiKey, "sk-…", true);
    var apiKeyWrap = wrapWithToggle(apiKey);
    body.appendChild(field("API 密钥", apiKeyWrap, "明文存储于浏览器 localStorage，仅在本地。点击右侧按钮切换显示/隐藏。"));

    var model = inputText(current.model, "deepseek-chat");
    var modelField = field("模型名", model);
    body.appendChild(modelField);

    var row = document.createElement("div"); row.className = "rf-field-row";
    var temp = inputNumber(current.temperature, 0, 2, 0.05);
    row.appendChild(field("Temperature", temp, "0 ~ 2，解析建议 0.2"));
    var maxT = inputSelect(current.maxTokens, MAX_TOKEN_OPTIONS);
    row.appendChild(field("最大生成长度 (tokens)", maxT, "1024 适合短回复；2048（默认）适合解析；推理类模型建议 ≥ 4096"));
    body.appendChild(row);
    var genParamsRow = row;

    var row2 = document.createElement("div"); row2.className = "rf-field-row";
    var timeout = inputNumber(current.timeoutMs, 5000, 600000, 1000);
    row2.appendChild(field("超时 (ms)", timeout));
    var rps = inputNumber(current.rps, 0.1, 10, 0.1);
    row2.appendChild(field("速率上限 (req/s)", rps));
    body.appendChild(row2);

    var corsProxy = inputText(current.corsProxy, "https://your-proxy.example.com/?url=");
    body.appendChild(field("CORS 代理 URL（可选）", corsProxy,
      "若勾上面带 ⚠ 的预设、或浏览器直连失败时填写。常见格式末尾为 ?url=，客户端会把真实 API URL 编码后追加。⚠ 不要把真实密钥发给陌生公共代理。"));

    // ----- 报告设置 -----
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
    // Toggle disabled state
    function syncFooterDisabled() { footerTextInp.disabled = !showFooterCheck.checked; }
    showFooterCheck.addEventListener("change", syncFooterDisabled);
    syncFooterDisabled();

    body.appendChild(reportDiv);

    // Test connection result
    var testBox = document.createElement("div");
    testBox.style.cssText = "margin-top:6px;font-size:12px;color:var(--rf-text-muted);min-height:18px;";

    // Footer buttons
    var foot = document.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;width:100%;justify-content:space-between;align-items:center";

    var leftFoot = document.createElement("div");
    var resetBtn = document.createElement("button");
    resetBtn.className = "rf-btn rf-btn--ghost";
    resetBtn.textContent = "恢复默认";
    leftFoot.appendChild(resetBtn);

    var rightFoot = document.createElement("div");
    rightFoot.style.cssText = "display:flex;gap:8px";
    var testBtn = document.createElement("button");
    testBtn.className = "rf-btn rf-btn--ghost";
    testBtn.textContent = "测试连接";
    rightFoot.appendChild(testBtn);
    var saveBtn = document.createElement("button");
    saveBtn.className = "rf-btn rf-btn--primary";
    saveBtn.textContent = "保存";
    rightFoot.appendChild(saveBtn);

    foot.appendChild(leftFoot);
    foot.appendChild(rightFoot);

    var modal = window.RF_UI.modal.open({
      title: "设置",
      bodyEl: body,
      footerEl: foot,
      size: "lg"
    });

    // Append the test result box to the modal body so the user can read the
    // result without scrolling away from the test button.
    body.appendChild(testBox);

    // Show/hide the model-name field depending on the selected API protocol.
    // Dify Chatflow configures the model and generation params (temperature,
    // max tokens) inside the workflow, so those fields are hidden and not
    // required there. Timeout / rate-limit are client-side, so they stay.
    function syncApiUI() {
      var api = presetApi(presetSel.value);
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
      var p = PRESETS.find(function (x) { return x.id === presetSel.value; }) || {};
      hintBox.textContent = p.hint || "";
      if (p.id !== "custom") {
        baseUrl.value = p.baseUrl || "";
        if (p.model) model.value = p.model;
      }
      syncApiUI();
    });

    resetBtn.addEventListener("click", function () {
      presetSel.value = DEFAULTS.preset;
      baseUrl.value = DEFAULTS.baseUrl;
      apiKey.value = "";
      model.value = DEFAULTS.model;
      temp.value = DEFAULTS.temperature;
      maxT.value = String(DEFAULTS.maxTokens);
      timeout.value = DEFAULTS.timeoutMs;
      rps.value = DEFAULTS.rps;
      corsProxy.value = "";
      hintBox.textContent = (PRESETS.find(function (p) { return p.id === DEFAULTS.preset; }) || {}).hint || "";
      showFooterCheck.checked = REPORT_DEFAULTS.showFooter;
      footerTextInp.value = REPORT_DEFAULTS.footerText;
      syncFooterDisabled();
      syncApiUI();
    });

    function gather() {
      return {
        preset:      presetSel.value,
        api:         presetApi(presetSel.value),
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
      // Dify Chatflow has the model configured inside the workflow, so the
      // model name is optional there; required for OpenAI-compatible endpoints.
      if (c.api !== "dify" && !c.model) errs.push("缺少模型名");
      if (c.temperature < 0 || c.temperature > 2) errs.push("Temperature 应在 0~2");
      return errs;
    }

    testBtn.addEventListener("click", function () {
      var c = gather();
      var errs = validate(c);
      if (errs.length) {
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ " + errs.join("；");
        return;
      }
      // Save in-memory so RF_LLM picks up the right config for the test.
      var prev = state.get("config.llm");
      state.set("config.llm", c);
      testBox.style.color = "var(--rf-text-muted)";
      testBox.textContent = "测试中…";
      window.RF_LLM.test().then(function (r) {
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
        // Keep previous config if test failed (don't pollute live state).
        state.set("config.llm", prev);
      });
    });

    saveBtn.addEventListener("click", function () {
      var c = gather();
      var errs = validate(c);
      if (errs.length) {
        testBox.style.color = "var(--rf-err)";
        testBox.textContent = "✗ " + errs.join("；");
        return;
      }
      save(c);
      saveReport({
        showFooter: showFooterCheck.checked,
        footerText: footerTextInp.value.trim() || REPORT_DEFAULTS.footerText
      });
      window.RF_UI.toast.ok("配置已保存");
      modal.close();
    });
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

  window.RF_ConfigManager = { init: init, get: get, isConfigured: isConfigured, save: save, getReport: getReport, saveReport: saveReport, openModal: openModal };
})();
