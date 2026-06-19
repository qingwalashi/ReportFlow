/**
 * llm-client.js — OpenAI-compatible chat completions client.
 *
 * Works against any provider that exposes OpenAI's `/chat/completions` schema:
 *   DeepSeek, Moonshot/Kimi, Zhipu (compat mode), local Ollama, etc.
 *
 * Public:
 *   await llm.complete({ messages, model, temperature, maxTokens, jsonMode, signal })
 *   await llm.test()                          -> 'ok' or throws
 *
 * Reads config from RF_State.get("config.llm").
 *
 * If config.corsProxy is set, requests are routed as:
 *   <corsProxy>?url=<encoded baseUrl + path>
 * (Caller is responsible for trusting that proxy with their key.)
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  var lastTokenAt = 0;          // rate-limit token-bucket cursor

  function cfg() {
    return state.get("config.llm") || window.RF_ConfigManager.get();
  }

  function joinUrl(base, path) {
    if (!base) return path;
    if (base.endsWith("/")) base = base.slice(0, -1);
    if (path.startsWith("/")) path = path.slice(1);
    return base + "/" + path;
  }

  function rateGate(rps) {
    if (!rps || rps <= 0) return Promise.resolve();
    var minInterval = 1000 / rps;
    var now = Date.now();
    var wait = Math.max(0, lastTokenAt + minInterval - now);
    lastTokenAt = now + wait;
    return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : Promise.resolve();
  }

  function buildUrl(c) {
    var base = (c.baseUrl || "").trim();
    var direct = joinUrl(base, "/chat/completions");
    if (c.corsProxy) {
      var proxy = c.corsProxy.trim();
      // Heuristic: proxies that already accept ?url= use the encoded form;
      // otherwise we just append the URL as the rightmost path component.
      if (proxy.indexOf("?url=") >= 0 || proxy.endsWith("?")) {
        return proxy + encodeURIComponent(direct);
      }
      if (proxy.endsWith("/")) return proxy + direct;
      return proxy + "/" + direct;
    }
    return direct;
  }

  function complete(opts) {
    opts = opts || {};
    var c = cfg();
    if (!c || !c.baseUrl || !c.apiKey || !c.model) {
      return Promise.reject(new Error("LLM 未配置：请先在「设置」中填写 API 地址、密钥和模型名"));
    }

    var stream = !!opts.stream && typeof opts.onDelta === "function";

    var body = {
      model: opts.model || c.model,
      messages: opts.messages || [],
      temperature: opts.temperature == null ? c.temperature : opts.temperature,
      max_tokens: opts.maxTokens || c.maxTokens || 2048,
      stream: stream
    };
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    var url = buildUrl(c);
    var timeoutMs = opts.timeoutMs || c.timeoutMs || 60000;

    return rateGate(c.rps || 1).then(function () {
      if (stream) {
        return doStreamFetch(url, c.apiKey, body, timeoutMs, opts.onDelta);
      }
      return doFetchWithRetry(url, c.apiKey, body, timeoutMs, 0);
    });
  }

  // SSE streaming path. We don't retry mid-stream — if the connection drops
  // halfway the user sees a clear error rather than a silently stitched reply.
  // onDelta receives ({ delta, kind }) where kind is "content" or "reasoning".
  function doStreamFetch(url, apiKey, body, timeoutMs, onDelta) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    var t0 = Date.now();

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "Accept": "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      if (!r.ok) {
        clearTimeout(timer);
        return r.text().then(function (txt) {
          var err = new Error("LLM HTTP " + r.status + ": " + truncate(txt, 220));
          err.status = r.status; err.body = txt;
          throw err;
        });
      }
      if (!r.body || !r.body.getReader) {
        // Fallback: server didn't actually stream; treat as non-stream JSON.
        clearTimeout(timer);
        return r.json().then(function (j) {
          return extractContent(j);
        });
      }
      var reader = r.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buf = "";
      var contentBuf = "";
      var reasonBuf = "";

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            clearTimeout(timer);
            var out = contentBuf || reasonBuf;
            log.info("llm: stream ok " + (Date.now() - t0) + "ms, " + out.length + " chars"
                   + (contentBuf ? "" : " (reasoning fallback)"));
            return out;
          }
          buf += decoder.decode(chunk.value, { stream: true });
          // Parse SSE: events separated by "\n\n", lines start with "data: ".
          var idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            var raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            raw.split("\n").forEach(function (line) {
              line = line.trim();
              if (!line.startsWith("data:")) return;
              var payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") return;
              try {
                var ev = JSON.parse(payload);
                var d = ev && ev.choices && ev.choices[0] && ev.choices[0].delta || {};
                if (typeof d.content === "string" && d.content) {
                  contentBuf += d.content;
                  try { onDelta({ delta: d.content, kind: "content", total: contentBuf.length }); } catch (e) {}
                } else if (typeof d.reasoning_content === "string" && d.reasoning_content) {
                  reasonBuf += d.reasoning_content;
                  try { onDelta({ delta: d.reasoning_content, kind: "reasoning", total: reasonBuf.length }); } catch (e) {}
                }
              } catch (e) {
                // Some providers emit keep-alive comments or partial chunks; ignore.
              }
            });
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        var to = new Error("LLM 请求超时（" + timeoutMs + "ms）。可在设置中调高超时。");
        to.cause = err; throw to;
      }
      if (err instanceof TypeError) {
        var hint = "请求失败（可能是 CORS 跨域被阻止）。建议：① 切换到 DeepSeek/Moonshot 等浏览器友好的预设；② 或在设置里填写「CORS 代理 URL」。";
        var ne = new Error(hint);
        ne.cause = err; throw ne;
      }
      throw err;
    });
  }

  function extractContent(j) {
    var msg = j && j.choices && j.choices[0] && j.choices[0].message || {};
    return msg.content
        || msg.reasoning_content
        || msg.reasoning
        || (j.choices && j.choices[0] && j.choices[0].text)
        || "";
  }

  function doFetchWithRetry(url, apiKey, body, timeoutMs, attempt) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    var t0 = Date.now();

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (r.ok) {
        return r.json().then(function (j) {
          var msg = j && j.choices && j.choices[0] && j.choices[0].message || {};
          // Reasoning models (GLM-Z1, DeepSeek-R1, Qwen3-Thinking, o1, …) sometimes
          // emit their final answer in a side-channel field instead of `content`,
          // or burn the whole budget on hidden CoT and leave `content` empty.
          // Fall back through the known field names so a health check still sees text.
          var content = msg.content
                     || msg.reasoning_content
                     || msg.reasoning
                     || (j.choices[0] && j.choices[0].text)   // legacy /completions shape
                     || "";
          log.info("llm: ok " + (Date.now() - t0) + "ms, " + content.length + " chars"
                    + (msg.content ? "" : " (fallback field)"));
          return content;
        });
      }
      var status = r.status;
      return r.text().then(function (txt) {
        var err = new Error("LLM HTTP " + status + ": " + truncate(txt, 220));
        err.status = status; err.body = txt;
        // Retry 429/5xx
        if ((status === 429 || (status >= 500 && status < 600)) && attempt < 2) {
          var backoff = 600 * Math.pow(2, attempt);
          log.warn("llm: " + status + ", retrying in " + backoff + "ms");
          return new Promise(function (res) { setTimeout(res, backoff); })
            .then(function () { return doFetchWithRetry(url, apiKey, body, timeoutMs, attempt + 1); });
        }
        throw err;
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        var to = new Error("LLM 请求超时（" + timeoutMs + "ms）。可在设置中调高超时。");
        to.cause = err; throw to;
      }
      // Network errors (most common: CORS) — surface a tailored hint.
      if (err instanceof TypeError) {
        var hint = "请求失败（可能是 CORS 跨域被阻止）。建议：① 切换到 DeepSeek/Moonshot 等浏览器友好的预设；② 或在设置里填写「CORS 代理 URL」。";
        var ne = new Error(hint);
        ne.cause = err; throw ne;
      }
      throw err;
    });
  }

  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }

  /**
   * Quick health check. We don't care WHAT the model says — only that the
   * endpoint is reachable, the key is accepted, and the model returns *some*
   * non-empty text. Asking for an exact "pong" was too strict (reasoning
   * models burn tokens on hidden CoT before producing visible output, and
   * temperature=0 isn't universally accepted).
   */
  function test() {
    // 1024 covers reasoning models that burn most of the budget on hidden CoT
    // before emitting the visible reply. Cheap on non-reasoning models because
    // they stop at the natural end-of-message regardless of the cap.
    return complete({
      messages: [
        { role: "user", content: "你好，请回复一个字。" }
      ],
      maxTokens: 1024,
      temperature: 0.5,
      timeoutMs: 30000
    }).then(function (text) {
      var s = String(text || "").trim();
      return { ok: s.length > 0, reply: s };
    });
  }

  window.RF_LLM = { complete: complete, test: test };
})();
