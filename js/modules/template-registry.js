/**
 * template-registry.js — the plug-in API every template self-registers against.
 *
 * Templates do, in their render.js IIFE:
 *
 *   window.ReportFlowTemplates.register({
 *     manifest: { id, name, version, description, capabilities: { charts, pdfSafe } },
 *     renderReport(data, container, ctx) { ... },        // required
 *     renderChart?(spec, container, ctx),                 // optional override
 *     theme?: { palette, textColor, axisColor, splitColor, fontFamily },
 *                                                         // optional — exposes the
 *                                                         // template's chart theme
 *                                                         // so exporters (ZIP/PDF)
 *                                                         // can match preview colors.
 *     onMount?(container), onUnmount?(container)          // optional hooks
 *   });
 *
 * Adding a new template = drop a folder under templates/<id>/ and add one
 * <script> tag to index.html. The core never knows the names.
 */
(function () {
  "use strict";

  var registry = Object.create(null);
  var order = [];

  function register(spec) {
    if (!spec || !spec.manifest || !spec.manifest.id) {
      console.error("[templates] register() rejected: missing manifest.id", spec);
      return;
    }
    if (typeof spec.renderReport !== "function") {
      console.error("[templates] register() rejected: renderReport must be a function", spec.manifest.id);
      return;
    }
    var id = spec.manifest.id;
    if (registry[id]) {
      console.warn("[templates] overwriting existing template", id);
    } else {
      order.push(id);
    }
    registry[id] = spec;
    if (window.RF_Bus) window.RF_Bus.emit("template:registered", spec.manifest);
  }

  function get(id) { return registry[id] || null; }
  function list() { return order.map(function (id) { return registry[id].manifest; }); }
  function has(id) { return !!registry[id]; }
  function pickDefault() { return order[0] || null; }

  window.ReportFlowTemplates = {
    register: register, get: get, list: list, has: has, pickDefault: pickDefault
  };
})();
