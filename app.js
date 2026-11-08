"use strict";

/* ============================================================
 * Jev Test Console — test harness for TypeSafe's System One API
 * Request/response shapes per docs.typesafe.ai and opencode.ai
 * ============================================================ */

const LS = {
  settings: "jevconsole.settings.v1",
  history: "jevconsole.history.v1",
  presets: "jevconsole.presets.v1",
};

const DEFAULT_SETTINGS = {
  endpointId: "proxy_opencode",
  customEndpoint: "",
  apiKey: "",
  model: "jev-1.13-free",
  imagesHeader: "auto",
};

const ENDPOINTS = {
  opencode: {
    url: "https://opencode.ai/inference/systemone/v1/systemone",
    models: "https://opencode.ai/inference/v1/models",
    defaultModel: "jev-1.13-free",
  },
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    models: null,
    defaultModel: "jev-latest",
  },
  proxy_opencode: {
    url: "http://localhost:8787/opencode/v1/systemone",
    models: "http://localhost:8787/opencode/v1/models",
    defaultModel: "jev-1.13-free",
  },
  proxy_typesafe: {
    url: "http://localhost:8787/typesafe/v1/systemone",
    models: null,
    defaultModel: "jev-latest",
  },
};

// USD per 1M tokens, from the OpenCode Console pricing table.
const PRICING = {
  "jev-1.13": { inputPerMTok: 0.042, outputPerMTok: 0 },
  "jev-1.13-free": { inputPerMTok: 0, outputPerMTok: 0 },
};

const ASSET_REF = "img-1";
const HISTORY_LIMIT = 25;

let settings = loadSettings();
const runtime = {
  stateMode: "text",
  questions: [],
  asset: null,
  jsonMode: false,
  abort: null,
  timer: null,
  compare: [],
  selectedPreset: "",
  lastResponseText: "",
  session: { runs: 0, input: 0, output: 0, cost: 0 },
};

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function fmt(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return String(Math.round(num * 100) / 100);
}

function pct(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value * 100));
}

function parseMaybeJson(text) {
  const t = String(text).trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

function stringifyMaybe(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function clearError(id) {
  $(id).hidden = true;
  $(id).textContent = "";
}

function announce(message) {
  $("liveRegion").textContent = message;
}

function setPresetStatus(message) {
  const el = $("presetStatus");
  el.textContent = message;
  el.hidden = !message;
}

function downloadFile(filename, text, type) {
  const blob = new Blob([text], { type: type || "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

/* ---------------- persistence ---------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS.settings);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function saveSettings() {
  if (!writeStorage(LS.settings, settings)) {
    announce("Browser storage is full; settings could not be saved.");
  }
  updateKeyBadge();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS.history);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function saveHistory(items) {
  if (!writeStorage(LS.history, items)) {
    announce("Browser storage is full; history could not be saved.");
  }
  renderHistory();
}

function loadPresets() {
  try {
    const raw = localStorage.getItem(LS.presets);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function savePresets(items) {
  return writeStorage(LS.presets, items);
}

function updateKeyBadge() {
  const badge = $("keyBadge");
  const set = Boolean(settings.apiKey.trim());
  badge.textContent = set ? "API key: set" : "API key: not set";
  badge.classList.toggle("ok", set);
}

function updateSessionChip() {
  const chip = $("sessionChip");
  const s = runtime.session;
  if (!s.runs) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const cost = s.cost ? ` · est. cost $${s.cost.toFixed(4)}` : "";
  chip.textContent = `Session: ${s.runs} run${s.runs === 1 ? "" : "s"} · ${s.input + s.output} tokens${cost}`;
}

function estimateCost(model, usage) {
  const price = PRICING[String(model || "").trim()];
  if (!price || !usage) return null;
  return (
    (Number(usage.input_tokens || 0) * price.inputPerMTok +
      Number(usage.output_tokens || 0) * price.outputPerMTok) /
    1e6
  );
}

/* ---------------- endpoints ---------------- */

function resolveEndpoint() {
  if (settings.endpointId === "custom") return settings.customEndpoint.trim();
  const endpoint = ENDPOINTS[settings.endpointId];
  return endpoint ? endpoint.url : "";
}

function buildHeaders(body) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey.trim()}`,
  };
  const hasBox = Object.values(body.questions || {}).some((question) => question && question.type === "box");
  const wantsImages = Boolean(runtime.asset) || hasBox;
  const mode = settings.imagesHeader;
  if (mode === "always" || (mode === "auto" && wantsImages)) {
    headers["TypeSafe-Danger-Zone-Images"] = "true";
  }
  return headers;
}

/* ---------------- question model ---------------- */

const QUESTION_TYPES = {
  noul: { label: "Noul", hint: "Yes / no probability" },
  choice: { label: "Choice", hint: "Pick one option" },
  score: { label: "Score", hint: "Rate along ordered levels" },
  box: { label: "Box", hint: "Locate a target in an image" },
};

function newQuestion(type) {
  return {
    id: "",
    type,
    instructions: "",
    critTrue: "",
    critFalse: "",
    rows: [
      { name: "", desc: "" },
      { name: "", desc: "" },
    ],
    levels: ["", ""],
  };
}

function renderQuestions() {
  if (!runtime.questions.length) {
    $("questionList").innerHTML =
      '<p class="empty">No questions yet. Add a Noul, Choice, Score, or Box question below.</p>';
  } else {
    $("questionList").innerHTML = runtime.questions.map(questionHtml).join("");
  }
  updateModelNote();
}

function nextQuestionId() {
  const used = new Set(runtime.questions.map((question) => question.id.trim()));
  let n = runtime.questions.length + 1;
  while (used.has("q" + n)) n += 1;
  return "q" + n;
}

function focusQuestion(index) {
  const card = $("questionList").querySelector(`.question[data-i="${index}"]`);
  if (!card) return;
  card.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  const input = card.querySelector?.('[data-field="id"]');
  if (input) {
    input.focus();
    input.select();
  }
}

function questionHtml(question, i) {
  const meta = QUESTION_TYPES[question.type] || { label: question.type || "Question", hint: "" };
  const typeOptions = Object.keys(QUESTION_TYPES)
    .map(
      (t) =>
        `<option value="${t}"${t === question.type ? " selected" : ""}>${QUESTION_TYPES[t].label.toLowerCase()}</option>`
    )
    .join("");

  let crit = "";
  if (question.type === "noul") {
    crit = `
      <details${question.critTrue || question.critFalse ? " open" : ""}>
        <summary>Criteria (optional: what counts as true / false)</summary>
        <div class="crit-row"><input data-field="critTrue" data-i="${i}" value="${esc(question.critTrue)}" placeholder="true: what counts as a yes"></div>
        <div class="crit-row"><input data-field="critFalse" data-i="${i}" value="${esc(question.critFalse)}" placeholder="false: what counts as a no"></div>
      </details>`;
  } else if (question.type === "choice") {
    crit =
      question.rows
        .map(
          (r, j) => `
      <div class="crit-row">
        <input data-field="rowName" data-i="${i}" data-j="${j}" value="${esc(r.name)}" placeholder="option name">
        <input data-field="rowDesc" data-i="${i}" data-j="${j}" value="${esc(r.desc)}" placeholder="description (optional)">
        <button class="ghost tiny" data-action="remove-row" data-i="${i}" data-j="${j}" aria-label="Remove option ${j + 1}">x</button>
      </div>`
        )
        .join("") +
      `<div class="row"><button class="chip-btn" data-action="add-row" data-i="${i}">+ option</button>
       <span class="hint">Empty descriptions are sent as <code>null</code>. Choice accepts up to 255 options.</span></div>`;
  } else if (question.type === "score") {
    crit =
      question.levels
        .map(
          (l, j) => `
      <div class="crit-row">
        <span class="hint">level ${j}</span>
        <input data-field="level" data-i="${i}" data-j="${j}" value="${esc(l)}" placeholder="what this level means">
        <button class="ghost tiny" data-action="remove-level" data-i="${i}" data-j="${j}" aria-label="Remove level ${j}">x</button>
      </div>`
        )
        .join("") +
      `<div class="row"><button class="chip-btn" data-action="add-level" data-i="${i}">+ level</button>
       <span class="hint">Levels are ordered low to high; the answer is a position along them.</span></div>`;
  } else {
    crit = `<p class="hint">No criteria. Box returns <code>top / bottom / left / right</code> edges as fractions of the image. Needs an attached image and Jev&nbsp;1.14+, and the images header. Pair with a Noul to detect whether the target is present at all.</p>`;
  }

  return `
    <div class="question q-type-${question.type}" data-i="${i}">
      <div class="q-title">
        <span class="type-tag">${esc(meta.label)}</span>
        <span class="q-title-hint">${esc(meta.hint)}</span>
        <span class="q-title-actions">
          <button class="ghost tiny" data-action="duplicate-q" data-i="${i}" data-tip="Duplicate this question with the same settings.">Duplicate</button>
          <button class="ghost tiny" data-action="remove-q" data-i="${i}" data-tip="Remove this question from the request.">Remove</button>
        </span>
      </div>
      <div class="q-head">
        <label>Question ID<input data-field="id" data-i="${i}" value="${esc(question.id)}" placeholder="is_urgent" spellcheck="false"></label>
        <label>Type<select data-field="type" data-i="${i}">${typeOptions}</select></label>
        <label>Instructions<textarea data-field="instructions" data-i="${i}" rows="2" placeholder="The judgment to make about the state (text or JSON)">${esc(question.instructions)}</textarea></label>
      </div>
      <div class="q-body">${crit}</div>
    </div>`;
}

function updateModelNote() {
  const hasBox = runtime.questions.some((question) => question.type === "box");
  const parts = [];
  if (settings.endpointId === "opencode") {
    parts.push("OpenCode Console models: use jev-1.13-free or jev-1.13.");
  } else if (settings.endpointId === "typesafe") {
    parts.push("TypeSafe API models: use jev-latest.");
  } else if (settings.endpointId.startsWith("proxy_")) {
    parts.push("Local proxy endpoint. Start it first: node proxy.js in the project folder.");
  }
  if (hasBox) parts.push("Box questions need Jev 1.14+ and an attached image.");
  $("modelNote").textContent = parts.join(" ");
}

/* ---------------- request building ---------------- */

function getStateValue() {
  const raw = $("stateInput").value;
  if (runtime.stateMode === "json") {
    try {
      return { value: JSON.parse(raw) };
    } catch (e) {
      return { error: "State is not valid JSON: " + e.message };
    }
  }
  if (!raw.trim()) return { error: "State is empty. Paste the text or JSON to evaluate." };
  return { value: raw };
}

function buildRequestBody() {
  const body = { model: $("modelInput").value.trim() };
  const state = getStateValue();
  if (state.value !== undefined) body.state = state.value;

  const questions = {};
  for (const question of runtime.questions) {
    const obj = { type: question.type, instructions: parseMaybeJson(question.instructions) };
    if (question.type === "noul") {
      const criteria = {};
      if (question.critTrue.trim()) criteria.true = parseMaybeJson(question.critTrue);
      if (question.critFalse.trim()) criteria.false = parseMaybeJson(question.critFalse);
      if (Object.keys(criteria).length) obj.criteria = criteria;
    } else if (question.type === "choice") {
      const criteria = {};
      for (const r of question.rows) {
        const name = r.name.trim();
        if (!name) continue;
        criteria[name] = r.desc.trim() ? parseMaybeJson(r.desc) : null;
      }
      obj.criteria = criteria;
    } else if (question.type === "score") {
      obj.criteria = question.levels.map((l) => l.trim()).filter(Boolean).map(parseMaybeJson);
    }
    questions[question.id.trim()] = obj;
  }
  body.questions = questions;

  if (runtime.asset) {
    body.assets = {
      [runtime.asset.ref]: {
        type: "image",
        format: runtime.asset.format,
        data_base64: runtime.asset.base64,
      },
    };
  }
  return body;
}

function snapshotRequest() {
  const body = runtime.jsonMode
    ? JSON.parse($("requestJson").value)
    : buildRequestBody();
  const copy = JSON.parse(JSON.stringify(body));
  delete copy.assets;
  return copy;
}

function requestForHistory(body) {
  const copy = JSON.parse(JSON.stringify(body));
  delete copy.assets;
  return copy;
}

function validateForm() {
  clearError("stateError");
  clearError("questionsError");

  const state = getStateValue();
  if (state.error) {
    showError("stateError", state.error);
    return false;
  }
  if (!$("modelInput").value.trim()) {
    showError("questionsError", "Model is empty. Try jev-1.13-free.");
    return false;
  }
  if (!runtime.questions.length) {
    showError("questionsError", "Add at least one question.");
    return false;
  }

  const ids = new Set();
  for (const question of runtime.questions) {
    const id = question.id.trim();
    if (!id) {
      showError("questionsError", "Every question needs an ID (it names the answer in the response).");
      return false;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      showError("questionsError", `Question ID "${id}" may only contain letters, digits, _ . -`);
      return false;
    }
    if (ids.has(id)) {
      showError("questionsError", `Duplicate question ID "${id}".`);
      return false;
    }
    ids.add(id);
    if (!question.instructions.trim()) {
      showError("questionsError", `Question "${id}" has no instructions.`);
      return false;
    }
    if (question.type === "choice") {
      const named = question.rows.filter((r) => r.name.trim());
      if (named.length < 2) {
        showError("questionsError", `Choice "${id}" needs at least two named options.`);
        return false;
      }
    }
    if (question.type === "score") {
      const levels = question.levels.filter((l) => l.trim());
      if (levels.length < 2) {
        showError("questionsError", `Score "${id}" needs at least two levels.`);
        return false;
      }
    }
    if (question.type === "box" && !runtime.asset) {
      showError("questionsError", `Box question "${id}" needs an attached image.`);
      return false;
    }
  }

  if (!settings.apiKey.trim()) {
    showError("questionsError", "No API key set. Add one in Settings.");
    return false;
  }

  const endpoint = resolveEndpoint();
  if (!/^https?:\/\//.test(endpoint)) {
    showError("questionsError", "Endpoint must be an http(s) URL.");
    return false;
  }
  return true;
}

function applyBodyToForm(body) {
  if (body.model) {
    $("modelInput").value = String(body.model);
    settings.model = String(body.model);
    saveSettings();
  }
  const st = body.state;
  if (typeof st === "string") {
    runtime.stateMode = "text";
    $("stateInput").value = st;
  } else {
    runtime.stateMode = "json";
    $("stateInput").value = JSON.stringify(st, null, 2);
  }
  updateStateModeUI();

  runtime.questions = [];
  for (const [id, question] of Object.entries(body.questions || {})) {
    const type = ["noul", "choice", "score", "box"].includes(question.type) ? question.type : "noul";
    const item = newQuestion(type);
    item.id = id;
    item.instructions = question.instructions == null ? "" : stringifyMaybe(question.instructions);
    if (type === "noul" && question.criteria) {
      item.critTrue = question.criteria.true != null ? stringifyMaybe(question.criteria.true) : "";
      item.critFalse = question.criteria.false != null ? stringifyMaybe(question.criteria.false) : "";
    } else if (type === "choice" && question.criteria) {
      item.rows = Object.entries(question.criteria).map(([name, desc]) => ({
        name,
        desc: desc == null ? "" : stringifyMaybe(desc),
      }));
    } else if (type === "score" && question.criteria) {
      const levels = Array.isArray(question.criteria) ? question.criteria : [question.criteria];
      item.levels = levels.map((c) => stringifyMaybe(c));
    }
    runtime.questions.push(item);
  }
  renderQuestions();
}

/* ---------------- run & response ---------------- */

let runToken = 0;

function setResponseBusy(busy) {
  $("responseCard").setAttribute("aria-busy", busy ? "true" : "false");
  if (busy) {
    $("answers").innerHTML =
      '<div class="skeleton-answer">' +
      '<span class="skeleton w30"></span><span class="skeleton w80"></span><span class="skeleton w65"></span>' +
      "</div>" +
      '<div class="skeleton-answer">' +
      '<span class="skeleton w40"></span><span class="skeleton w75"></span>' +
      "</div>";
  }
}

async function run() {
  clearError("jsonError");
  clearError("responseError");

  let body;
  if (runtime.jsonMode) {
    try {
      body = JSON.parse($("requestJson").value);
    } catch (e) {
      showError("jsonError", "Request body is not valid JSON: " + e.message);
      return;
    }
    if (!body || typeof body !== "object") {
      showError("jsonError", "Request body must be a JSON object.");
      return;
    }
  } else {
    if (!validateForm()) return;
    body = buildRequestBody();
    if (body.state === undefined) return;
    syncJsonEditor();
  }

  if (!settings.apiKey.trim()) {
    showError("responseError", "No API key set. Add one in Settings.");
    return;
  }
  const endpoint = resolveEndpoint();
  if (!/^https?:\/\//.test(endpoint)) {
    showError("responseError", "Endpoint must be an http(s) URL.");
    return;
  }

  // Only one run may own the response pane. Abort the previous request and
  // invalidate its token so a late result cannot overwrite this run.
  const token = ++runToken;
  if (runtime.abort) runtime.abort.abort();
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
  $("responseMeta").innerHTML = "";
  $("answers").innerHTML = "";
  $("rawResponse").textContent = "";

  const btn = $("runBtn");
  btn.disabled = true;
  btn.textContent = "Running…";
  $("cancelRunBtn").hidden = false;
  runtime.abort = new AbortController();
  setResponseBusy(true);

  const t0 = performance.now();
  const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1);
  $("responseMeta").innerHTML = '<span class="meta-chip loading">Sending request…</span>';
  runtime.timer = setInterval(() => {
    $("responseMeta").innerHTML = `<span class="meta-chip loading">Waiting for the API… ${elapsed()} s</span>`;
  }, 250);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(body),
      body: JSON.stringify(body),
      signal: runtime.abort.signal,
    });
    if (token !== runToken) return;
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    if (token !== runToken) return;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }

    recordHistory({
      ts: Date.now(),
      ms,
      status: res.status,
      ok: res.ok,
      model: body.model || settings.model,
      endpoint,
      request: requestForHistory(body),
      response: data !== null ? data : text,
    });

    renderResponse({ res, data, text, ms, body });
  } catch (err) {
    if (token !== runToken) return;
    const ms = Math.round(performance.now() - t0);
    if (err && err.name === "AbortError") {
      setResponseBusy(false);
      $("responseMeta").innerHTML = `<span class="meta-chip bad">cancelled</span><span class="meta-chip">${ms} ms</span>`;
      $("answers").innerHTML = '<p class="empty">Request cancelled. Nothing was recorded in history.</p>';
      announce("Request cancelled.");
      return;
    }

    // A direct endpoint is CORS-blocked in browsers. If the bundled proxy is
    // running, switch to it and retry the same request automatically.
    const onProxy = settings.endpointId.startsWith("proxy_");
    const directKnown = settings.endpointId === "opencode" || settings.endpointId === "typesafe";
    if (!onProxy && directKnown && (await probeProxy())) {
      if (token !== runToken) return;
      clearInterval(runtime.timer);
      runtime.timer = null;
      switchToProxyEndpoint();
      announce("Switched to the local proxy and retrying.");
      run();
      return;
    }

    recordHistory({
      ts: Date.now(),
      ms,
      status: 0,
      ok: false,
      model: body.model || settings.model,
      endpoint,
      request: requestForHistory(body),
      error: String(err),
    });
    $("responseMeta").innerHTML = `<span class="meta-chip bad">request failed</span><span class="meta-chip">${ms} ms</span>`;
    setResponseBusy(false);
    $("answers").innerHTML = "";
    showRunFailure(String(err));
    $("rawResponse").textContent = JSON.stringify(body, null, 2);
    $("responseDetails").open = true;
    announce("Request failed before reaching the API.");
  } finally {
    if (token === runToken) {
      clearInterval(runtime.timer);
      runtime.timer = null;
      runtime.abort = null;
      setResponseBusy(false);
      $("cancelRunBtn").hidden = true;
      btn.disabled = false;
      btn.textContent = "Run request";
    }
  }
}

function cancelRun() {
  if (runtime.abort) runtime.abort.abort();
}

async function probeProxy() {
  try {
    const res = await fetch("http://localhost:8787/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

function switchToProxyEndpoint() {
  settings.endpointId = settings.endpointId === "typesafe" ? "proxy_typesafe" : "proxy_opencode";
  settings.model = ENDPOINTS[settings.endpointId].defaultModel;
  applySettingsToForm();
  saveSettings();
  updateModelNote();
}

async function showRunFailure(message) {
  const endpointId = settings.endpointId;
  const onProxy = endpointId.startsWith("proxy_");
  const directKnown = endpointId === "opencode" || endpointId === "typesafe";
  const proxyUp = await probeProxy();
  const lines = ["The request never reached the API: " + message, ""];

  if (directKnown) {
    if (proxyUp) {
      lines.push(
        "This API refuses direct browser (CORS) calls, which is expected. " +
          "A local proxy is running on localhost:8787, so switching endpoint fixes it:"
      );
    } else {
      lines.push(
        "This API refuses direct browser (CORS) calls, which is expected. " +
          "To run from the browser, start the bundled proxy: node proxy.js in the project folder, " +
          "then switch Endpoint to a Local proxy option."
      );
    }
  } else if (onProxy) {
    if (!proxyUp) {
      lines.push(
        "You are on a Local proxy endpoint, but nothing answered on localhost:8787. " +
          "Start it with: node proxy.js in the project folder, then run again."
      );
    } else {
      lines.push(
        "The proxy on localhost:8787 is reachable but the call still failed. " +
          "Check the proxy terminal for the upstream error."
      );
    }
  } else {
    lines.push(
      "The browser could not reach this custom endpoint. Check the URL, that the server is running, " +
        "and that it sends CORS headers (Access-Control-Allow-Origin)."
    );
  }

  lines.push("Or click Copy as cURL and run the request in a terminal, which has no CORS limits.");

  const el = $("responseError");
  const canFix = directKnown && proxyUp;
  el.innerHTML =
    esc(lines.join("\n")) +
    (canFix
      ? '<div class="error-actions"><button class="ghost" data-action="use-proxy">Switch to Local proxy and run again</button></div>'
      : "");
  el.hidden = false;
}

function renderResponse({ res, data, text, ms, body, countSession = true }) {
  setResponseBusy(false);
  const meta = [];
  meta.push(`<span class="meta-chip ${res.ok ? "ok" : "bad"}">HTTP ${res.status}</span>`);
  meta.push(`<span class="meta-chip">${ms} ms</span>`);
  const model = (data && data.model) || body.model;
  if (model) meta.push(`<span class="meta-chip">${esc(model)}</span>`);
  if (data && data.usage) {
    const it = data.usage.input_tokens ?? "?";
    const ot = data.usage.output_tokens ?? "?";
    meta.push(`<span class="meta-chip">input tokens ${esc(it)} · output tokens ${esc(ot)}</span>`);
    const cost = estimateCost(model, data.usage);
    if (cost !== null) {
      meta.push(`<span class="meta-chip">${cost === 0 ? "free" : `est. cost $${cost.toFixed(4)}`}</span>`);
    }
    if (res.ok && countSession) {
      runtime.session.runs += 1;
      runtime.session.input += Number(data.usage.input_tokens || 0);
      runtime.session.output += Number(data.usage.output_tokens || 0);
      if (cost !== null) runtime.session.cost += cost;
      updateSessionChip();
    }
  }
  $("responseMeta").innerHTML = meta.join("");

  const rawText = data ? JSON.stringify(data, null, 2) : text;
  runtime.lastResponseText = rawText;
  $("copyResponseBtn").disabled = false;
  $("downloadResponseBtn").disabled = false;

  if (!res.ok) {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* keep raw */
    }
    showError("responseError", `HTTP ${res.status}: the API rejected the request.\n${pretty}`);
    $("answers").innerHTML = "";
    $("rawResponse").textContent = pretty;
    $("responseDetails").open = true;
    announce(`Request rejected with HTTP ${res.status}.`);
    return;
  }

  const answers = data && data.answers;
  if (!answers || typeof answers !== "object" || !Object.keys(answers).length) {
    $("answers").innerHTML =
      '<p class="empty">No <code>answers</code> object in the response. See the raw response below.</p>';
  } else {
    $("answers").innerHTML = Object.entries(answers)
      .map(([id, answer]) => answerHtml(id, answer))
      .join("");
  }
  $("rawResponse").textContent = rawText;
  $("responseDetails").open = true;
  announce(`Run finished: HTTP ${res.status} in ${ms} milliseconds.`);
}

function answerHead(id, type, confidence) {
  const conf =
    confidence === undefined || confidence === null
      ? ""
      : `<span class="conf-chip">confidence ${fmt(confidence)}</span>`;
  return `<div class="answer-head"><code class="qid">${esc(id)}</code><span class="type-tag">${esc(type)}</span>${conf}</div>`;
}

function barRow(label, value, winner) {
  return `
    <div class="bar-row${winner ? " winner" : ""}">
      <span class="bar-label">${esc(label)}</span>
      <div class="bar"><div class="fill" style="width:${pct(value)}%"></div></div>
      <span class="bar-val">${fmt(value)}</span>
    </div>`;
}

function answerHtml(id, answer) {
  if (!answer || typeof answer !== "object") {
    return `<div class="answer">${answerHead(id, "?")}<pre>${esc(JSON.stringify(answer, null, 2))}</pre></div>`;
  }

  if (answer.type === "noul") {
    const v = Number(answer.noul);
    const verdict =
      v >= 0.7
        ? '<span class="verdict yes">YES &ge; 0.7</span>'
        : v <= 0.3
          ? '<span class="verdict no">NO &le; 0.3</span>'
          : '<span class="verdict maybe">UNCERTAIN 0.3&ndash;0.7</span>';
    return `
      <div class="answer q-type-noul">
        ${answerHead(id, "noul")}
        <div class="big-value">${fmt(v)}</div>
        ${verdict}
        <div class="gauge">
          <span class="thresh" style="left:30%">0.3</span>
          <span class="thresh" style="left:70%">0.7</span>
          <span class="marker" style="left:${pct(v)}%"></span>
        </div>
        <div class="gauge-scale"><span>0 = no</span><span>0.5 = uncertain</span><span>1 = yes</span></div>
      </div>`;
  }

  if (answer.type === "choice") {
    const probs = answer.probabilities || {};
    const rows = Object.entries(probs).sort((a, b) => Number(b[1]) - Number(a[1]));
    return `
      <div class="answer q-type-choice">
        ${answerHead(id, "choice", answer.confidence)}
        <div>choice: <b>${esc(answer.choice == null ? "(none)" : String(answer.choice))}</b></div>
        ${rows.map(([key, p]) => barRow(key, p, key === answer.choice)).join("")}
      </div>`;
  }

  if (answer.type === "score") {
    const probs = answer.probabilities || {};
    const legend = answer.legend || {};
    const idxs = Object.keys(probs).sort((a, b) => Number(a) - Number(b));
    const maxIdx = Math.max(1, idxs.length - 1);
    const pos = pct(Number(answer.score) / maxIdx);
    const ticks = idxs
      .map((idx) => {
        const at = (Number(idx) / maxIdx) * 100;
        return `<span class="tick" style="left:${at}%"></span><span class="tick-label" style="left:${at}%">${esc(idx)}</span>`;
      })
      .join("");
    return `
      <div class="answer q-type-score">
        ${answerHead(id, "score", answer.confidence)}
        <div class="big-value">${fmt(answer.score)}</div>
        <div class="score-track">${ticks}<span class="marker" style="left:${pos}%"></span></div>
        ${idxs
          .map((idx) => {
            const label = legend[idx] != null ? `${idx} — ${legend[idx]}` : idx;
            return barRow(label, probs[idx], false);
          })
          .join("")}
      </div>`;
  }

  if (answer.type === "box") {
    const b = answer.box || {};
    const left = pct(b.left);
    const top = pct(b.top);
    const width = pct(Math.max(0, Number(b.right) - Number(b.left)));
    const height = pct(Math.max(0, Number(b.bottom) - Number(b.top)));
    const rect = `<div class="box-rect" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"></div>`;
    const stage = runtime.asset && runtime.asset.dataUrl
      ? `<div class="box-stage"><img src="${runtime.asset.dataUrl}" alt="The request image with the returned box drawn on it">${rect}</div>`
      : `<div class="unit-box">${rect}</div>`;
    return `
      <div class="answer q-type-box">
        ${answerHead(id, "box", answer.confidence)}
        ${stage}
        <table class="edges-table">
          <tr><td>top</td><td>${fmt(b.top)}</td></tr>
          <tr><td>bottom</td><td>${fmt(b.bottom)}</td></tr>
          <tr><td>left</td><td>${fmt(b.left)}</td></tr>
          <tr><td>right</td><td>${fmt(b.right)}</td></tr>
        </table>
      </div>`;
  }

  return `<div class="answer">${answerHead(id, answer.type)}<pre>${esc(JSON.stringify(answer, null, 2))}</pre></div>`;
}

/* ---------------- history & comparison ---------------- */

function recordHistory(entry) {
  let items = loadHistory();
  let ts = Date.now();
  while (items.some((item) => item.ts === ts)) ts += 1;
  items.unshift({ ...entry, ts });
  items = items.slice(0, HISTORY_LIMIT);

  let saved = writeStorage(LS.history, items);
  while (!saved && items.length > 1) {
    items.pop();
    saved = writeStorage(LS.history, items);
  }
  if (!saved) {
    announce("Browser storage is full; this run could not be saved to history.");
  }
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  const count = $("historyCount");
  count.textContent = items.length;
  count.hidden = items.length === 0;
  $("clearHistoryBtn").disabled = items.length === 0;
  $("exportHistoryJsonBtn").disabled = items.length === 0;
  $("exportHistoryCsvBtn").disabled = items.length === 0;

  if (!items.length) {
    $("historyList").innerHTML = '<p class="empty">No runs yet. Requests you send are listed here with their answers, ready to reopen or compare.</p>';
    runtime.compare = [];
    renderCompare();
    return;
  }
  $("historyList").innerHTML = items
    .map((item) => {
      const questions = (item.request && item.request.questions) || {};
      const questionText = Object.entries(questions)
        .map(([id, question]) => `${id} (${question && question.type ? question.type : "?"})`)
        .join(", ");
      const answers =
        (item.response && typeof item.response === "object" && item.response.answers) || {};
      const answerText = Object.entries(answers)
        .map(([id, answer]) => `${id}: ${answerSummary(answer).text}`)
        .join(", ");
      const summary = answerText || questionText || "(no questions)";
      const checked = runtime.compare.includes(item.ts) ? " checked" : "";
      return `
        <div class="history-item">
          <span class="meta-chip ${item.ok ? "ok" : "bad"}">${item.status || "failed"}</span>
          <div>
            <div class="summary" title="${esc(summary)}">${esc(summary)}</div>
            <div class="meta">${new Date(item.ts).toLocaleString()} · ${esc(item.model || "")} · ${item.ms} ms</div>
          </div>
          <label class="compare-check"><input type="checkbox" data-action="history-compare" data-ts="${item.ts}"${checked}> Compare</label>
          <button class="ghost tiny" data-action="history-open" data-ts="${item.ts}">Open</button>
          <button class="ghost tiny" data-action="history-delete" data-ts="${item.ts}">Delete</button>
        </div>`;
    })
    .join("");
  renderCompare();
}

function findHistoryItem(ts) {
  return loadHistory().find((item) => item.ts === ts);
}

function historyOpen(ts) {
  const item = findHistoryItem(ts);
  if (!item) return;
  if (item.request) applyBodyToForm(item.request);
  switchTab("playground");

  if (item.error) {
    $("responseMeta").innerHTML = `<span class="meta-chip bad">request failed</span><span class="meta-chip">${item.ms} ms</span>`;
    showError("responseError", "This request failed: " + item.error);
    $("answers").innerHTML = "";
    $("rawResponse").textContent = JSON.stringify(item.request, null, 2);
    return;
  }
  renderResponse({
    res: { ok: item.ok, status: item.status },
    data: typeof item.response === "object" ? item.response : null,
    text: typeof item.response === "string" ? item.response : "",
    ms: item.ms,
    body: item.request,
    countSession: false,
  });
}

function answerSummary(answer) {
  if (!answer || typeof answer !== "object") return { text: String(answer), num: null };
  if (answer.type === "noul") return { text: fmt(answer.noul), num: Number(answer.noul) };
  if (answer.type === "score") {
    const conf = answer.confidence != null ? ` · conf ${fmt(answer.confidence)}` : "";
    return { text: fmt(answer.score) + conf, num: Number(answer.score) };
  }
  if (answer.type === "choice") {
    const conf = answer.confidence != null ? ` · conf ${fmt(answer.confidence)}` : "";
    const choice = answer.choice == null ? "(none)" : String(answer.choice);
    return { text: choice + conf, num: null };
  }
  if (answer.type === "box") {
    const b = answer.box || {};
    return {
      text: `t ${fmt(b.top)} · b ${fmt(b.bottom)} · l ${fmt(b.left)} · r ${fmt(b.right)}`,
      num: null,
    };
  }
  return { text: JSON.stringify(answer), num: null };
}

function renderCompare() {
  const panel = $("comparePanel");
  const picks = runtime.compare.map(findHistoryItem).filter(Boolean);
  if (picks.length !== 2) {
    panel.hidden = true;
    $("compareTable").innerHTML = "";
    return;
  }
  panel.hidden = false;

  const [a, b] = picks;
  const answersA = (a.response && typeof a.response === "object" && a.response.answers) || {};
  const answersB = (b.response && typeof b.response === "object" && b.response.answers) || {};
  const ids = [...new Set([...Object.keys(answersA), ...Object.keys(answersB)])];

  const head = `
    <table class="compare-table">
      <thead>
        <tr>
          <th>Question</th>
          <th>Run A · ${new Date(a.ts).toLocaleString()} · ${esc(a.model || "")}</th>
          <th>Run B · ${new Date(b.ts).toLocaleString()} · ${esc(b.model || "")}</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>`;

  const rows = ids
    .map((id) => {
      const sa = answerSummary(answersA[id]);
      const sb = answerSummary(answersB[id]);
      let delta = "same";
      if (sa.text !== sb.text) {
        if (sa.num != null && sb.num != null) {
          const diff = sb.num - sa.num;
          delta = `${diff > 0 ? "+" : ""}${fmt(diff)}`;
        } else {
          delta = "changed";
        }
      }
      return `
        <tr>
          <td class="mono">${esc(id)}</td>
          <td class="mono">${esc(sa.text)}</td>
          <td class="mono">${esc(sb.text)}</td>
          <td class="delta">${delta}</td>
        </tr>`;
    })
    .join("");

  const usageRow = `
      <tr>
        <td class="mono">latency</td>
        <td class="mono">${a.ms} ms</td>
        <td class="mono">${b.ms} ms</td>
        <td class="delta">${b.ms - a.ms > 0 ? "+" : ""}${b.ms - a.ms} ms</td>
      </tr>`;

  $("compareTable").innerHTML = head + rows + usageRow + "</tbody></table>";
  announce("Comparison ready for the two selected runs.");
}

function toggleCompare(ts, on) {
  const idx = runtime.compare.indexOf(ts);
  if (on && idx === -1) {
    runtime.compare.push(ts);
    if (runtime.compare.length > 2) runtime.compare.shift();
  } else if (!on && idx !== -1) {
    runtime.compare.splice(idx, 1);
  }
  renderHistory();
}

/* ---------------- export to code ---------------- */

function buildCurl(body) {
  const endpoint = resolveEndpoint();
  const headers = buildHeaders(body);
  const lines = [`curl '${endpoint}'`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`  -H '${key}: ${value.replace(/'/g, "'\\''")}'`);
  }
  const json = JSON.stringify(body, null, 2).replace(/'/g, "'\\''");
  lines.push(`  --data-binary '${json}'`);
  return lines.join(" \\\n");
}

function buildFetchSnippet(body) {
  const endpoint = resolveEndpoint();
  const headers = buildHeaders(body);
  return `const res = await fetch(${JSON.stringify(endpoint)}, {
  method: "POST",
  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, "\n  ")},
  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")})
});
if (!res.ok) throw new Error("HTTP " + res.status);
const data = await res.json();`;
}

async function copySnippet(kind, button, label) {
  clearError("questionsError");
  let body;
  if (runtime.jsonMode) {
    try {
      body = JSON.parse($("requestJson").value);
    } catch (e) {
      showError("jsonError", "Request body is not valid JSON: " + e.message);
      return;
    }
  } else {
    const state = getStateValue();
    if (state.error) {
      showError("stateError", state.error);
      return;
    }
    body = buildRequestBody();
  }
  const snippet = kind === "curl" ? buildCurl(body) : buildFetchSnippet(body);
  try {
    await copyText(snippet);
    button.textContent = "Copied (contains your key)";
    announce(`${label} copied to the clipboard.`);
    setTimeout(() => (button.textContent = label), 2500);
  } catch {
    showError("questionsError", "Clipboard copy failed. The snippet:\n\n" + snippet);
  }
}

/* ---------------- JSON editor sync ---------------- */

function syncJsonEditor() {
  try {
    $("requestJson").value = JSON.stringify(buildRequestBody(), null, 2);
    clearError("jsonError");
  } catch (e) {
    showError("jsonError", "Could not build the request: " + e.message);
  }
}

function setJsonMode(on) {
  const btn = $("jsonToggleBtn");
  if (on) {
    syncJsonEditor();
    runtime.jsonMode = true;
    $("jsonEditor").hidden = false;
    btn.textContent = "Back to form";
    btn.setAttribute("aria-pressed", "true");
  } else {
    let body;
    try {
      body = JSON.parse($("requestJson").value);
    } catch (e) {
      showError("jsonError", "Fix the JSON first: " + e.message);
      return;
    }
    runtime.jsonMode = false;
    $("jsonEditor").hidden = true;
    btn.textContent = "Edit request JSON";
    btn.setAttribute("aria-pressed", "false");
    applyBodyToForm(body);
  }
}

/* ---------------- state samples & example presets ---------------- */

const SAMPLE_STATES = {
  ticket:
    "Our API integration started returning 500 errors on every request about 20 minutes ago, and we can't process any customer orders until this is fixed.",
  repeat: "I have asked three times now. Can I please just talk to a real person?",
  json: {
    ticket: {
      subject: "Duplicate charge",
      messages: [
        { from: "customer", text: "I was charged twice for order A-104. Please refund the duplicate." },
        { from: "support", text: "We are checking the charges." },
      ],
    },
    order: {
      id: "A-104",
      charges: [
        { amount_usd: 49, status: "captured" },
        { amount_usd: 49, status: "captured" },
      ],
    },
    refund_policy: "Duplicate charges are eligible for a refund.",
  },
};

function loadSample(name) {
  const sample = SAMPLE_STATES[name];
  if (sample == null) return;
  if (typeof sample === "string") {
    runtime.stateMode = "text";
    $("stateInput").value = sample;
  } else {
    runtime.stateMode = "json";
    $("stateInput").value = JSON.stringify(sample, null, 2);
  }
  updateStateModeUI();
  clearError("stateError");
}

function q(id, type, instructions, extra = {}) {
  const item = newQuestion(type);
  item.id = id;
  item.instructions = instructions;
  Object.assign(item, extra);
  return item;
}

const PRESETS = {
  triage() {
    runtime.stateMode = "text";
    $("stateInput").value = SAMPLE_STATES.ticket;
    runtime.questions = [
      q("department", "choice", "Which team should handle this", {
        rows: [
          { name: "billing", desc: "Payment or subscription issues" },
          { name: "technical", desc: "Bugs or integration problems" },
          { name: "sales", desc: "Pricing or account questions" },
        ],
      }),
      q("frustration", "score", "How frustrated the customer appears", {
        levels: ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"],
      }),
      q("is_urgent", "noul", "The message conveys urgency or time-sensitivity"),
    ];
  },
  fanout() {
    runtime.stateMode = "text";
    $("stateInput").value =
      "I ordered a pair of running shoes and the box that arrived has the wrong size and there was a second charge on my card. It is three days late and I still have not heard back from support.";
    runtime.questions = [
      q("department", "choice", "Which team should handle this?", {
        rows: [
          { name: "returns", desc: "Exchanges, wrong or damaged items" },
          { name: "shipping", desc: "Delivery status, delays, lost packages" },
          { name: "billing", desc: "Charges, invoices, payment problems" },
        ],
      }),
      q("return_reason", "choice", "If the customer wants to return something, why?", {
        rows: [
          { name: "wrong_size", desc: "The item doesn't fit" },
          { name: "wrong_item", desc: "A different product was delivered" },
          { name: "damaged", desc: "The item arrived broken or faulty" },
          { name: "changed_mind", desc: "The item is fine, the customer no longer wants it" },
          { name: "other", desc: "A return reason that fits none of the above" },
        ],
      }),
      q("shipping_issue", "choice", "If this is a shipping problem, which kind is it?", {
        rows: [
          { name: "not_delivered", desc: "The package never arrived" },
          { name: "delayed", desc: "The package is late but still on its way" },
          { name: "wrong_address", desc: "The package went to the wrong place" },
          { name: "damaged_in_transit", desc: "The package arrived damaged" },
          { name: "other", desc: "A shipping problem that fits none of the above" },
        ],
      }),
      q("requested_resolution", "choice", "What does the customer want to happen?", {
        rows: [
          { name: "exchange", desc: "Swap the item for a different one" },
          { name: "refund", desc: "Money back" },
          { name: "replacement", desc: "The same item sent again" },
          { name: "information", desc: "Just an answer, no action needed" },
        ],
      }),
      q("tone", "choice", "What is the customer's tone?", {
        rows: [
          { name: "calm", desc: "" },
          { name: "frustrated", desc: "" },
          { name: "angry", desc: "" },
        ],
      }),
    ];
  },
  nouls() {
    runtime.stateMode = "text";
    $("stateInput").value = SAMPLE_STATES.repeat;
    runtime.questions = [
      q("is_human_escalation", "noul", "Is the customer asking for a human agent?"),
      q("is_repeat_contact", "noul", "Has the customer contacted support about this before?", {
        critTrue: "Mentions a prior attempt, ticket, or that they have asked before",
        critFalse: "No sign of any previous contact",
      }),
    ];
  },
  fieldpaths() {
    runtime.stateMode = "json";
    $("stateInput").value = JSON.stringify(SAMPLE_STATES.json, null, 2);
    runtime.questions = [
      q("refund_requested", "noul", "Does `ticket.messages[0].text` request a refund?"),
      q(
        "policy_supports_refund",
        "noul",
        "Does `refund_policy` support the refund requested in `ticket.messages[0].text`, given `order.charges`?"
      ),
    ];
  },
  box() {
    runtime.stateMode = "json";
    $("stateInput").value = JSON.stringify({ photo: runtime.asset ? runtime.asset.ref : ASSET_REF }, null, 2);
    runtime.questions = [
      q("mug_visible", "noul", "Is there a coffee mug in `photo`?"),
      q("mug", "box", "the coffee mug in `photo`"),
    ];
  },
};

const EXAMPLE_LABELS = {
  triage: "Example: support triage (choice + score + noul)",
  fanout: "Example: speculative fan-out (5 choices)",
  nouls: "Example: noul checklist",
  fieldpaths: "Example: JSON state and field paths",
  box: "Example: box, locate an object (image, Jev 1.14)",
};

function loadPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  preset();
  updateStateModeUI();
  renderQuestions();
  clearError("stateError");
  clearError("questionsError");
}

function renderPresetOptions(selected) {
  const saved = loadPresets();
  const examples = Object.keys(PRESETS)
    .map((key) => `<option value="${key}">${esc(EXAMPLE_LABELS[key] || key)}</option>`)
    .join("");
  const savedOptions = saved.length
    ? `<optgroup label="Saved presets">${saved
        .map((p) => `<option value="saved::${esc(p.name)}">${esc(p.name)}</option>`)
        .join("")}</optgroup>`
    : "";
  $("presetSelect").innerHTML =
    `<option value="">Load a preset…</option>` +
    `<optgroup label="Examples">${examples}</optgroup>` +
    savedOptions;
  if (selected) $("presetSelect").value = selected;
  const isSaved = String($("presetSelect").value || "").startsWith("saved::");
  $("deletePresetBtn").disabled = !isSaved;
  $("exportPresetsBtn").disabled = saved.length === 0;
}

function openSaveForm() {
  $("savePresetRow").hidden = false;
  $("presetNameInput").value = String($("presetSelect").value || "").startsWith("saved::")
    ? $("presetSelect").value.slice(7)
    : "";
  $("presetNameInput").focus();
  setPresetStatus("");
}

function closeSaveForm() {
  $("savePresetRow").hidden = true;
  $("savePresetBtn").focus();
}

function savePresetFromForm() {
  const name = $("presetNameInput").value.trim();
  if (!name) {
    setPresetStatus("Enter a name for the preset.");
    $("presetNameInput").focus();
    return;
  }
  let request;
  try {
    request = snapshotRequest();
  } catch (e) {
    setPresetStatus("Could not save: " + e.message);
    return;
  }
  const list = loadPresets();
  const entry = { name, savedAt: Date.now(), request };
  const idx = list.findIndex((p) => p.name === name);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  if (!savePresets(list)) {
    setPresetStatus("Could not save the preset: browser storage is full.");
    return;
  }
  renderPresetOptions("saved::" + name);
  runtime.selectedPreset = "saved::" + name;
  closeSaveForm();
  setPresetStatus(
    idx >= 0
      ? `Updated "${name}". Attached images are not stored in presets.`
      : `Saved "${name}". Attached images are not stored in presets.`
  );
  announce(`Preset ${name} ${idx >= 0 ? "updated" : "saved"}.`);
}

function deleteSelectedPreset() {
  const value = String($("presetSelect").value || "");
  if (!value.startsWith("saved::")) return;
  const name = value.slice(7);
  if (!confirm(`Delete the preset "${name}" from this browser?`)) return;
  if (!savePresets(loadPresets().filter((p) => p.name !== name))) {
    setPresetStatus("Could not delete the preset: browser storage is full.");
    return;
  }
  renderPresetOptions("");
  runtime.selectedPreset = "";
  setPresetStatus(`Deleted "${name}".`);
  announce(`Preset ${name} deleted.`);
}

function exportPresets() {
  const list = loadPresets();
  if (!list.length) {
    setPresetStatus("No saved presets to export yet. Use Save as preset first.");
    return;
  }
  const payload = {
    app: "jev-test-console",
    version: 1,
    exportedAt: new Date().toISOString(),
    presets: list,
  };
  downloadFile("jev-presets.json", JSON.stringify(payload, null, 2));
  setPresetStatus(`Exported ${list.length} preset${list.length === 1 ? "" : "s"} as jev-presets.json.`);
  announce("Presets exported.");
}

function setHistoryStatus(message) {
  const el = $("historyStatus");
  el.textContent = message;
  el.hidden = !message;
}

function exportHistoryJson() {
  const items = loadHistory();
  if (!items.length) {
    setHistoryStatus("No history to export yet. Run a request first.");
    return;
  }
  const payload = {
    app: "jev-test-console",
    version: 1,
    exportedAt: new Date().toISOString(),
    history: items,
  };
  downloadFile("jev-history.json", JSON.stringify(payload, null, 2));
  setHistoryStatus(`Exported ${items.length} run${items.length === 1 ? "" : "s"} as jev-history.json.`);
  announce("History exported as JSON.");
}

function csvField(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function exportHistoryCsv() {
  const items = loadHistory();
  if (!items.length) {
    setHistoryStatus("No history to export yet. Run a request first.");
    return;
  }
  const header = ["timestamp", "status", "ok", "model", "endpoint", "ms", "questions", "answers"];
  const rows = items.map((item) => {
    const questions = (item.request && item.request.questions) || {};
    const questionText = Object.entries(questions)
      .map(([id, question]) => `${id} (${question && question.type ? question.type : "?"})`)
      .join("; ");
    const answers =
      (item.response && typeof item.response === "object" && item.response.answers) || {};
    const answerText = Object.entries(answers)
      .map(([id, answer]) => `${id}: ${answerSummary(answer).text}`)
      .join("; ");
    return [
      new Date(item.ts).toISOString(),
      item.status || "failed",
      item.ok ? "yes" : "no",
      item.model || "",
      item.endpoint || "",
      item.ms == null ? "" : item.ms,
      questionText,
      answerText,
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
  downloadFile("jev-history.csv", csv, "text/csv;charset=utf-8");
  setHistoryStatus(`Exported ${items.length} run${items.length === 1 ? "" : "s"} as jev-history.csv.`);
  announce("History exported as CSV.");
}

function normalizeImported(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.presets)
      ? data.presets
      : [data];
  return list.filter(
    (p) => p && typeof p.name === "string" && p.request && typeof p.request === "object"
  );
}

function importPresets(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let incoming;
    try {
      incoming = normalizeImported(JSON.parse(String(reader.result)));
    } catch (e) {
      setPresetStatus("Import failed: the file is not valid JSON. " + e.message);
      return;
    }
    if (!incoming.length) {
      setPresetStatus("Import failed: no presets with a name and request were found in the file.");
      return;
    }
    const list = loadPresets();
    let replaced = 0;
    for (const item of incoming) {
      const entry = { name: item.name, savedAt: item.savedAt || Date.now(), request: item.request };
      const idx = list.findIndex((p) => p.name === entry.name);
      if (idx >= 0) {
        list[idx] = entry;
        replaced += 1;
      } else {
        list.push(entry);
      }
    }
    if (!savePresets(list)) {
      setPresetStatus("Import failed: browser storage is full.");
      return;
    }
    renderPresetOptions(String($("presetSelect").value || ""));
    setPresetStatus(
      `Imported ${incoming.length} preset${incoming.length === 1 ? "" : "s"}` +
        (replaced ? `, ${replaced} replaced.` : ".")
    );
    announce(`Imported ${incoming.length} presets.`);
  };
  reader.readAsText(file);
}

/* ---------------- image assets ---------------- */

const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_MIN_SIDE = 280;
const IMAGE_MAX_SIDE = 1568;

function attachImage(file) {
  if (!file) return;
  const format = file.type === "image/png" ? "png" : "jpg";
  const resetInput = () => {
    $("imageInput").value = "";
  };
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    showError("stateError", "Images must be PNG or JPEG. Convert the file and try again.");
    resetInput();
    return;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    showError("stateError", "Image is larger than 16 MiB. Resize or compress it and try again.");
    resetInput();
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    showError("stateError", "Could not read the image file. Try another PNG or JPEG.");
    resetInput();
  };
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const probe = new Image();
    probe.onerror = () => {
      showError("stateError", "Could not decode the image. Try another PNG or JPEG.");
      resetInput();
    };
    probe.onload = () => {
      if (
        probe.width < IMAGE_MIN_SIDE ||
        probe.height < IMAGE_MIN_SIDE ||
        probe.width > IMAGE_MAX_SIDE ||
        probe.height > IMAGE_MAX_SIDE
      ) {
        showError(
          "stateError",
          `Each image side must be between ${IMAGE_MIN_SIDE} and ${IMAGE_MAX_SIDE} px. ` +
            `This image is ${probe.width}x${probe.height}.`
        );
        resetInput();
        return;
      }
      runtime.asset = {
        ref: ASSET_REF,
        format,
        base64: dataUrl.split(",")[1],
        dataUrl,
        width: probe.width,
        height: probe.height,
      };
      $("assetThumb").src = dataUrl;
      $("assetRef").textContent =
        `reference \`${ASSET_REF}\` · ${probe.width}x${probe.height} ${format.toUpperCase()}`;
      $("assetChip").hidden = false;
      clearError("stateError");
      updateModelNote();
      announce(`Image attached, reference ${ASSET_REF}.`);
    };
    probe.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

function insertAssetRef() {
  const ta = $("stateInput");
  const ref = "`" + ASSET_REF + "`";
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.setRangeText(ref, start, end, "end");
  ta.focus();
}

function removeAsset() {
  runtime.asset = null;
  $("assetChip").hidden = true;
  $("assetThumb").removeAttribute("src");
  $("imageInput").value = "";
  updateModelNote();
}

/* ---------------- tabs ---------------- */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== "tab-" + name;
  });
}

function setupTabKeyboard() {
  const tabs = [...document.querySelectorAll(".tab")];
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i === -1) return;
    let next = null;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabs[next].focus();
    switchTab(tabs[next].dataset.tab);
  });
}

/* ---------------- models listing ---------------- */

async function fetchModels() {
  const info = ENDPOINTS[settings.endpointId];
  const url = info && info.models;
  if (!url) {
    showError("stateError", "No documented models endpoint for this target. OpenCode Console publishes GET /inference/v1/models.");
    return;
  }
  $("modelsPanel").hidden = false;
  $("modelsOut").textContent = "Loading…";
  try {
    const headers = {};
    if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    const res = await fetch(url, { headers });
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* keep raw */
    }
    $("modelsOut").textContent = `HTTP ${res.status}\n\n${pretty}`;
  } catch (err) {
    $("modelsOut").textContent = "Request failed: " + String(err);
  }
}

/* ---------------- PWA plumbing ---------------- */

function registerServiceWorker() {
  const status = $("swStatus");
  if (!("serviceWorker" in navigator)) {
    status.textContent = "Service workers are not supported in this browser.";
    return;
  }
  if (location.protocol === "file:") {
    status.textContent = "Serve this app over http(s) (for example localhost) to enable offline caching and install.";
    return;
  }
  navigator.serviceWorker
    .register("sw.js")
    .then(() => {
      status.textContent = "Offline-ready: the app shell is cached and updates automatically.";
    })
    .catch((err) => {
      status.textContent = "Service worker registration failed: " + String(err);
    });
}

function setupInstallPrompt() {
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event;
    $("installBtn").hidden = false;
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $("installBtn").hidden = true;
  });
}

/* ---------------- events ---------------- */

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  setupTabKeyboard();

  $("endpointSelect").addEventListener("change", (e) => {
    settings.endpointId = e.target.value;
    if (settings.endpointId !== "custom") {
      const def = ENDPOINTS[settings.endpointId].defaultModel;
      $("modelInput").value = def;
      settings.model = def;
    }
    $("customEndpointRow").hidden = settings.endpointId !== "custom";
    $("fetchModelsBtn").hidden = !(ENDPOINTS[settings.endpointId] && ENDPOINTS[settings.endpointId].models);
    saveSettings();
    updateModelNote();
  });

  $("customEndpointInput").addEventListener("input", (e) => {
    settings.customEndpoint = e.target.value;
    saveSettings();
  });

  $("modelInput").addEventListener("input", (e) => {
    settings.model = e.target.value;
    saveSettings();
    updateModelNote();
  });

  document.querySelectorAll("[data-state-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      runtime.stateMode = btn.dataset.stateMode;
      updateStateModeUI();
      clearError("stateError");
    });
  });

  document.querySelectorAll(".sample-state").forEach((btn) => {
    btn.addEventListener("click", () => loadSample(btn.dataset.sample));
  });

  $("imageInput").addEventListener("change", (e) => attachImage(e.target.files[0]));
  $("insertAssetBtn").addEventListener("click", insertAssetRef);
  $("removeAssetBtn").addEventListener("click", removeAsset);

  $("presetSelect").addEventListener("change", (e) => {
    const value = e.target.value;
    runtime.selectedPreset = value;
    $("deletePresetBtn").disabled = !value.startsWith("saved::");
    if (!value) return;
    if (value.startsWith("saved::")) {
      const name = value.slice(7);
      const preset = loadPresets().find((p) => p.name === name);
      if (preset) {
        applyBodyToForm(preset.request);
        announce(`Loaded preset ${name}.`);
      }
    } else {
      loadPreset(value);
      announce(`Loaded example ${value}.`);
    }
    setPresetStatus("");
  });

  $("savePresetBtn").addEventListener("click", openSaveForm);
  $("savePresetCancel").addEventListener("click", closeSaveForm);
  $("savePresetConfirm").addEventListener("click", savePresetFromForm);
  $("presetNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      savePresetFromForm();
    }
    if (e.key === "Escape") closeSaveForm();
  });
  $("deletePresetBtn").addEventListener("click", deleteSelectedPreset);
  $("exportPresetsBtn").addEventListener("click", exportPresets);
  $("importPresetsInput").addEventListener("change", (e) => {
    importPresets(e.target.files[0]);
    e.target.value = "";
  });

  document.querySelectorAll(".add-q").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = newQuestion(btn.dataset.type);
      item.id = nextQuestionId();
      runtime.questions.push(item);
      renderQuestions();
      focusQuestion(runtime.questions.length - 1);
    });
  });

  const list = $("questionList");
  list.addEventListener("input", (e) => {
    const el = e.target;
    const i = Number(el.dataset.i);
    const j = Number(el.dataset.j);
    const question = runtime.questions[i];
    if (!question) return;
    switch (el.dataset.field) {
      case "id":
        question.id = el.value;
        break;
      case "instructions":
        question.instructions = el.value;
        break;
      case "critTrue":
        question.critTrue = el.value;
        break;
      case "critFalse":
        question.critFalse = el.value;
        break;
      case "rowName":
        question.rows[j].name = el.value;
        break;
      case "rowDesc":
        question.rows[j].desc = el.value;
        break;
      case "level":
        question.levels[j] = el.value;
        break;
    }
  });
  list.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.field === "type") {
      const i = Number(el.dataset.i);
      const question = runtime.questions[i];
      if (!question) return;
      question.type = el.value;
      renderQuestions();
    }
  });
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const j = Number(btn.dataset.j);
    const question = runtime.questions[i];
    if (!question) return;
    switch (btn.dataset.action) {
      case "duplicate-q": {
        const copy = JSON.parse(JSON.stringify(question));
        copy.id = nextQuestionId();
        runtime.questions.splice(i + 1, 0, copy);
        renderQuestions();
        focusQuestion(i + 1);
        break;
      }
      case "remove-q":
        runtime.questions.splice(i, 1);
        renderQuestions();
        break;
      case "add-row":
        question.rows.push({ name: "", desc: "" });
        renderQuestions();
        break;
      case "remove-row":
        question.rows.splice(j, 1);
        renderQuestions();
        break;
      case "add-level":
        question.levels.push("");
        renderQuestions();
        break;
      case "remove-level":
        question.levels.splice(j, 1);
        renderQuestions();
        break;
    }
  });

  $("runBtn").addEventListener("click", run);
  $("cancelRunBtn").addEventListener("click", cancelRun);
  $("responseError").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="use-proxy"]');
    if (!btn) return;
    switchToProxyEndpoint();
    clearError("responseError");
    run();
  });
  $("curlBtn").addEventListener("click", () => copySnippet("curl", $("curlBtn"), "Copy as cURL"));
  $("fetchBtn").addEventListener("click", () => copySnippet("fetch", $("fetchBtn"), "Copy as fetch()"));
  $("jsonToggleBtn").addEventListener("click", () => setJsonMode(!runtime.jsonMode));

  $("copyResponseBtn").addEventListener("click", async () => {
    try {
      await copyText(runtime.lastResponseText);
      announce("Response JSON copied to the clipboard.");
      const btn = $("copyResponseBtn");
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy JSON"), 2000);
    } catch {
      showError("responseError", "Clipboard copy failed. The raw response is under Raw response below.");
    }
  });
  $("downloadResponseBtn").addEventListener("click", () => {
    downloadFile("jev-response.json", runtime.lastResponseText);
    announce("Response JSON downloaded.");
  });

  $("fetchModelsBtn").addEventListener("click", fetchModels);
  $("closeModelsBtn").addEventListener("click", () => ($("modelsPanel").hidden = true));

  $("exportHistoryJsonBtn").addEventListener("click", exportHistoryJson);
  $("exportHistoryCsvBtn").addEventListener("click", exportHistoryCsv);

  $("clearHistoryBtn").addEventListener("click", () => {
    if (confirm("Clear the request history on this device?")) {
      runtime.compare = [];
      saveHistory([]);
      setHistoryStatus("History cleared.");
      announce("History cleared.");
    }
  });

  $("clearCompareBtn").addEventListener("click", () => {
    runtime.compare = [];
    renderHistory();
  });

  $("historyList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const ts = Number(btn.dataset.ts);
    if (btn.dataset.action === "history-open") historyOpen(ts);
    if (btn.dataset.action === "history-delete") {
      const items = loadHistory().filter((item) => item.ts !== ts);
      runtime.compare = runtime.compare.filter((x) => x !== ts);
      saveHistory(items);
    }
  });
  $("historyList").addEventListener("change", (e) => {
    const box = e.target.closest('input[data-action="history-compare"]');
    if (!box) return;
    toggleCompare(Number(box.dataset.ts), box.checked);
  });

  $("apiKeyInput").addEventListener("input", (e) => {
    settings.apiKey = e.target.value;
    saveSettings();
    $("keyStatus").textContent = e.target.value ? "Saved to localStorage." : "";
  });
  $("toggleKeyBtn").addEventListener("click", () => {
    const input = $("apiKeyInput");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggleKeyBtn").textContent = show ? "Hide" : "Show";
  });
  $("imagesHeaderSelect").addEventListener("change", (e) => {
    settings.imagesHeader = e.target.value;
    saveSettings();
  });

  $("clearDataBtn").addEventListener("click", () => {
    if (!confirm("Remove the API key, settings, history, and saved presets from this browser?")) return;
    localStorage.removeItem(LS.settings);
    localStorage.removeItem(LS.history);
    localStorage.removeItem(LS.presets);
    settings = { ...DEFAULT_SETTINGS };
    runtime.questions = [];
    runtime.asset = null;
    runtime.jsonMode = false;
    runtime.compare = [];
    runtime.selectedPreset = "";
    applySettingsToForm();
    renderPresetOptions("");
    loadPreset("triage");
    renderHistory();
    updateKeyBadge();
    setPresetStatus("");
    setHistoryStatus("");
    announce("All stored data cleared.");
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "Escape") {
      if (runtime.abort) {
        cancelRun();
      } else if (!$("savePresetRow").hidden) {
        closeSaveForm();
      }
    }
  });
}

/* ---------------- init ---------------- */

function applySettingsToForm() {
  let changed = false;
  if (settings.endpointId !== "custom" && !ENDPOINTS[settings.endpointId]) {
    settings.endpointId = DEFAULT_SETTINGS.endpointId;
    settings.model = DEFAULT_SETTINGS.model;
    changed = true;
  }
  if (!["auto", "always", "never"].includes(settings.imagesHeader)) {
    settings.imagesHeader = DEFAULT_SETTINGS.imagesHeader;
    changed = true;
  }
  $("endpointSelect").value = settings.endpointId;
  $("customEndpointInput").value = settings.customEndpoint;
  $("customEndpointRow").hidden = settings.endpointId !== "custom";
  $("modelInput").value = settings.model;
  $("apiKeyInput").value = settings.apiKey;
  $("imagesHeaderSelect").value = settings.imagesHeader;
  $("fetchModelsBtn").hidden = !(ENDPOINTS[settings.endpointId] && ENDPOINTS[settings.endpointId].models);
  $("keyStatus").textContent = settings.apiKey ? "Saved to localStorage." : "";
  if (changed) saveSettings();
}

function updateStateModeUI() {
  document.querySelectorAll("[data-state-mode]").forEach((btn) => {
    const active = btn.dataset.stateMode === runtime.stateMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function init() {
  applySettingsToForm();
  updateKeyBadge();
  updateSessionChip();
  renderPresetOptions("");
  bindEvents();
  setupInstallPrompt();
  registerServiceWorker();
  loadPreset("triage");
  renderHistory();
}

/* ---------------- tooltips ---------------- */

const TIP_RULES = [
  ["select[data-field='type']", "Question type decides the answer shape: noul returns a probability, choice a picked option, score a position on levels, box image edges."],
  ["[data-action='remove-q']", "Remove this question from the request."],
  ["[data-action='add-row']", "Add another option. A Choice question accepts up to 255 options."],
  ["[data-action='remove-row']", "Remove this option."],
  ["[data-action='add-level']", "Add another level. Score levels are ordered low to high."],
  ["[data-action='remove-level']", "Remove this level."],
  [".question details summary", "Optional criteria. They pin down what counts as true and false, or what each option covers."],
  [".q-type-noul .type-tag", "Noul: the probability that the statement is true, 0 to 1. Near 0.5 means uncertain. No separate confidence value."],
  [".q-type-choice .type-tag", "Choice: the picked option, a probability for every option, and confidence for the pick."],
  [".q-type-score .type-tag", "Score: a position along the levels, it can fall between two. Includes legend, probabilities, and confidence."],
  [".q-type-box .type-tag", "Box: top, bottom, left, right edges as fractions of the image. A Box always returns a location, so pair it with a Noul for presence."],
  [".conf-chip", "Confidence summarizes how peaked the probabilities are: 1 is one certain option, 0 is spread evenly."],
  [".verdict.yes", "Noul at or above 0.7 reads as yes. Raise the threshold when a false yes is expensive."],
  [".verdict.no", "Noul at or below 0.3 reads as no."],
  [".verdict.maybe", "Between 0.3 and 0.7 the model is unsure. Send these to a person instead of a code path."],
  ["input[data-action='history-compare']", "Tick two runs to compare their answers side by side."],
  ["button[data-action='history-open']", "Reload this request into the form and show its recorded response."],
  ["button[data-action='history-delete']", "Remove this run from history."],
];

function findTip(target) {
  if (!(target instanceof Element)) return null;
  const own = target.closest("[data-tip]");
  if (own) return { el: own, text: own.dataset.tip };
  for (const [sel, text] of TIP_RULES) {
    const el = target.closest(sel);
    if (el) return { el, text };
  }
  return null;
}

function setupTooltips() {
  const tip = document.createElement("div");
  tip.id = "tooltip";
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  let current = null;

  function hide() {
    if (current) current.removeAttribute("aria-describedby");
    current = null;
    tip.hidden = true;
  }

  function show(el, text) {
    if (current === el) return;
    hide();
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));
    let y = r.top - t.height - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    el.setAttribute("aria-describedby", "tooltip");
    current = el;
  }

  document.addEventListener("pointerover", (e) => {
    const found = findTip(e.target);
    if (found) show(found.el, found.text);
    else hide();
  });
  document.addEventListener("pointerout", (e) => {
    if (current && !current.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const found = findTip(e.target);
    if (found) show(found.el, found.text);
    else hide();
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

setupTooltips();

init();
