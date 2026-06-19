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
      id: "custom", label: "自定义 OpenAI 兼容端点",
      baseUrl: "", model: "",
      hint: "任何兼容 /chat/completions 的端点。"
    }
  ];

  var DEFAULTS = {
    preset:      "deepseek",
    baseUrl:     "https://api.deepseek.com/v1",
    apiKey:      "",
    model:       "deepseek-chat",
    temperature: 0.3,
    maxTokens:   2048,
    timeoutMs:   60000,
    rps:         1,
    corsProxy:   ""
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

    var btn = document.getElementById("rf-btn-settings");
    if (btn) btn.addEventListener("click", openModal);
  }

  function get() { return state.get("config.llm") || DEFAULTS; }

  function save(cfg) {
    state.set("config.llm", cfg);
    storage.set("config", "llm", cfg);
    bus.emit("config:saved", cfg);
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
    body.appendChild(field("API 地址 (baseUrl)", baseUrl, "应为以 /v1 等结尾的 OpenAI 兼容根；客户端会自动追加 /chat/completions。"));

    var apiKey = inputText(current.apiKey, "sk-…", true);
    body.appendChild(field("API 密钥", apiKey, "明文存储于浏览器 localStorage，仅在本地。"));

    var model = inputText(current.model, "deepseek-chat");
    body.appendChild(field("模型名", model));

    var row = document.createElement("div"); row.className = "rf-field-row";
    var temp = inputNumber(current.temperature, 0, 2, 0.05);
    row.appendChild(field("Temperature", temp, "0 ~ 2，解析建议 0.2"));
    var maxT = inputSelect(current.maxTokens, MAX_TOKEN_OPTIONS);
    row.appendChild(field("最大生成长度 (tokens)", maxT, "1024 适合短回复；2048（默认）适合解析；推理类模型建议 ≥ 4096"));
    body.appendChild(row);

    var row2 = document.createElement("div"); row2.className = "rf-field-row";
    var timeout = inputNumber(current.timeoutMs, 5000, 600000, 1000);
    row2.appendChild(field("超时 (ms)", timeout));
    var rps = inputNumber(current.rps, 0.1, 10, 0.1);
    row2.appendChild(field("速率上限 (req/s)", rps));
    body.appendChild(row2);

    var corsProxy = inputText(current.corsProxy, "https://your-proxy.example.com/?url=");
    body.appendChild(field("CORS 代理 URL（可选）", corsProxy,
      "若勾上面带 ⚠ 的预设、或浏览器直连失败时填写。常见格式末尾为 ?url=，客户端会把真实 API URL 编码后追加。⚠ 不要把真实密钥发给陌生公共代理。"));

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
      title: "大模型设置",
      bodyEl: body,
      footerEl: foot,
      size: "lg"
    });

    // Append the test result box to the modal body so the user can read the
    // result without scrolling away from the test button.
    body.appendChild(testBox);

    presetSel.addEventListener("change", function () {
      var p = PRESETS.find(function (x) { return x.id === presetSel.value; }) || {};
      hintBox.textContent = p.hint || "";
      if (p.id !== "custom") {
        baseUrl.value = p.baseUrl || "";
        if (p.model) model.value = p.model;
      }
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
    });

    function gather() {
      return {
        preset:      presetSel.value,
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
      if (!c.model) errs.push("缺少模型名");
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

  window.RF_ConfigManager = { init: init, get: get, save: save, openModal: openModal };
})();
