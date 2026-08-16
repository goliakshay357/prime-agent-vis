/**
 * Prime Agent Vis — frontend (vanilla JS, no build step).
 *
 * Home view: folder-level session explorer matching kimi vis UX
 *   (theme toggle, search, sort, group-by-folder, cards/compact).
 * Timeline view: block-by-block LLM I/O trace for a selected session.
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────
let sessions = [];
let search = "";
let sortMode = "time";        // "time" | "messages" | "name"
let groupMode = "folder";   // "folder" | "date" | "none"
let viewMode = "cards";       // "cards" | "compact"
let collapsedGroups = new Set();
let currentSessionId = null;
let currentTimeline = null;
let toolCallIdToResult = {};
let toolCallIdToMeta = {};
let liveInfo = null;

const THEME_KEY = "pav-theme";
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

// ─── DOM helpers ──────────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length <= n ? s : s.slice(0, n) + "…";
}
function prettyJson(o) {
  if (typeof o === "string") return o;
  try { return JSON.stringify(o, null, 2); } catch { return String(o); }
}
function parseTs(ts) {
  if (ts == null || ts === "") return null;
  if (typeof ts === "number") return new Date(ts);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}
function formatTime(ts) {
  const d = parseTs(ts);
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatDate(ts) {
  const d = parseTs(ts);
  if (!d) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatBytes(n) {
  n = Number(n) || 0;
  if (n === 0) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function formatTokens(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "k";
  return (n / 1000000).toFixed(1) + "M";
}
function formatCost(c) {
  c = Number(c) || 0;
  if (c === 0) return "$0";
  if (c < 0.01) return "$" + c.toFixed(4);
  return "$" + c.toFixed(2);
}
function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return "";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}
function shortId(id) {
  return String(id || "").slice(0, 8);
}

// ─── Theme ────────────────────────────────────────────────────────
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);
  $("#theme-toggle").innerHTML = t === "dark" ? SUN_SVG : MOON_SVG;
}
function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

// ─── Filter / sort / group ────────────────────────────────────────
function filtered() {
  if (!search.trim()) return sessions;
  const q = search.trim().toLowerCase();
  return sessions.filter((s) =>
    (s.id || "").toLowerCase().includes(q) ||
    (s.first_message || "").toLowerCase().includes(q) ||
    (s.cwd || "").toLowerCase().includes(q)
  );
}
function sorted(list) {
  const arr = [...list];
  if (sortMode === "time") {
    arr.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  } else if (sortMode === "messages") {
    arr.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
  } else if (sortMode === "name") {
    arr.sort((a, b) =>
      String(a.first_message || "").localeCompare(String(b.first_message || "")));
  }
  return arr;
}
function makeFolderGroups(list) {
  const map = new Map();
  for (const s of list) {
    const key = s.cwd || "Unknown";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const groups = Array.from(map.entries()).map(([label, list]) => ({ key: "folder:" + label, label, icon: "folder", list }));
  const maxMod = (l) => Math.max(0, ...l.map((s) => s.modified || 0));
  groups.sort((a, b) => maxMod(b.list) - maxMod(a.list));
  return groups;
}

function dateLabel(ms) {
  const d = new Date(Number(ms) || 0);
  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

function makeDateGroups(list) {
  const map = new Map();
  for (const s of list) {
    const label = dateLabel(s.modified || 0);
    const key = "date:" + label;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const groups = Array.from(map.entries()).map(([key, list]) => ({ key, label: key.slice(5), icon: "date", list }));
  const maxMod = (l) => Math.max(0, ...l.map((s) => s.modified || 0));
  groups.sort((a, b) => maxMod(b.list) - maxMod(a.list));
  return groups;
}

// ─── Render helpers ───────────────────────────────────────────────
function cardHtml(s, compact) {
  const id = shortId(s.id);
  const title = s.first_message || "(no messages)";
  const folder = s.cwd || "Unknown";
  const time = formatDate(s.modified);
  const meta = `${s.message_count} msg${s.message_count === 1 ? "" : "s"} · ${formatBytes(s.file_size)}`;

  if (compact) {
    return `<div class="row" data-session-id="${escapeHtml(s.id)}">
      <span class="card-id" title="${escapeHtml(s.id)}">${escapeHtml(id)}</span>
      <span class="card-title">${escapeHtml(truncate(title, 90))}</span>
      <span class="card-meta"><span>${escapeHtml(meta)}</span><span>${escapeHtml(time)}</span></span>
    </div>`;
  }
  return `<div class="card" data-session-id="${escapeHtml(s.id)}">
    <div class="card-top">
      <span class="card-id" title="${escapeHtml(s.id)}">${escapeHtml(id)}</span>
      <span class="card-time">${escapeHtml(time)}</span>
    </div>
    <div class="card-title">${escapeHtml(title)}</div>
    <div class="card-folder" title="${escapeHtml(folder)}">${escapeHtml(folder)}</div>
    <div class="card-meta"><span>${escapeHtml(meta)}</span></div>
  </div>`;
}

function renderCollection(list) {
  if (viewMode === "compact") {
    return `<div class="list">${list.map((s) => cardHtml(s, true)).join("")}</div>`;
  }
  return `<div class="grid">${list.map((s) => cardHtml(s, false)).join("")}</div>`;
}

function groupHtml(g) {
  const collapsed = collapsedGroups.has(g.key);
  const icon = g.icon === "date"
    ? '<svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>'
    : '<svg class="group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
  return `<div class="group">
    <div class="group-header" data-group-key="${escapeHtml(g.key)}">
      ${icon}
      <svg class="chevron${collapsed ? " collapsed" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      <span class="path" title="${escapeHtml(g.label)}">${escapeHtml(g.label)}</span>
      <span class="count">${g.list.length}</span>
    </div>
    <div class="group-body"${collapsed ? " hidden" : ""}>${renderCollection(g.list)}</div>
  </div>`;
}

function footerHtml() {
  const folders = new Set(sessions.map((s) => s.cwd || "Unknown")).size;
  const totalSize = sessions.reduce((sum, s) => sum + (Number(s.file_size) || 0), 0);
  let html = `<span>${sessions.length} session${sessions.length === 1 ? "" : "s"}</span>`;
  html += `<span class="sep">·</span><span>${folders} folder${folders === 1 ? "" : "s"}</span>`;
  if (totalSize > 0) html += `<span class="sep">·</span><span>${formatBytes(totalSize)} total</span>`;
  return html;
}

// ─── Render home ──────────────────────────────────────────────────
function renderHome() {
  const listEl = $("#session-list");
  const f = filtered();
  const s = sorted(f);
  const g = groupMode === "none" ? null : (groupMode === "date" ? makeDateGroups(s) : makeFolderGroups(s));

  $("#view-toggle").setAttribute("aria-pressed", String(viewMode === "compact"));

  if (sessions.length === 0) {
    listEl.innerHTML = `<div class="empty"><div class="big">No sessions found</div>
      <div>Run Prime Agent to create a session. Sessions are read from <code class="hint">~/.prime/agent/sessions</code>.</div></div>`;
  } else if (f.length === 0) {
    listEl.innerHTML = `<div class="empty">No sessions matching <code class="hint">${escapeHtml(search)}</code></div>`;
  } else if (g) {
    listEl.innerHTML = g.map(groupHtml).join("");
  } else {
    listEl.innerHTML = renderCollection(s);
  }

  $("#footer").innerHTML = footerHtml();
}

// ─── View switching ───────────────────────────────────────────────
function showHome() {
  currentSessionId = null;
  currentTimeline = null;
  $("#timeline-view").hidden = true;
  $("#home-view").hidden = false;
  closeDetail();
  hideKernel();
  const kt = $("#kernel-toggle");
  if (kt) kt.hidden = true;
  renderHome();
}
function showTimelineView() {
  $("#home-view").hidden = true;
  $("#timeline-view").hidden = false;
  closeDetail();
}

function isLiveSession(id) {
  return liveInfo != null && liveInfo.live_session_id === id;
}
function hideKernel() {
  const panel = $("#kernel-panel");
  if (panel) panel.hidden = true;
  const split = $(".timeline-split");
  if (split) split.hidden = false;
  const kt = $("#kernel-toggle");
  if (kt) kt.setAttribute("aria-pressed", "false");
}
function updateKernelToggle(sessionId) {
  const kt = $("#kernel-toggle");
  if (!kt) return;
  if (isLiveSession(sessionId)) {
    kt.hidden = false;
  } else {
    kt.hidden = true;
    hideKernel();
  }
}
function toggleKernel() {
  const panel = $("#kernel-panel");
  const timeline = $("#timeline");
  if (panel.hidden) {
    const iframe = $("#kernel-iframe");
    if (iframe && !iframe.getAttribute("src")) iframe.setAttribute("src", liveInfo.jupyter_url);
    const split = $(".timeline-split");
    if (split) split.hidden = true;
    panel.hidden = false;
    $("#kernel-toggle").setAttribute("aria-pressed", "true");
  } else {
    hideKernel();
  }
}
function loadLiveInfo() {
  fetch("/api/live")
    .then((r) => r.json())
    .then((d) => {
      liveInfo = d;
      if (currentSessionId) updateKernelToggle(currentSessionId);
    })
    .catch(() => { liveInfo = null; });
}

// ─── Timeline ─────────────────────────────────────────────────────
async function openSession(sessionId) {
  currentSessionId = sessionId;
  showTimelineView();
  updateKernelToggle(sessionId);

  const timelineEl = $("#timeline");
  timelineEl.innerHTML = '<div class="loading">Loading session timeline…</div>';
  $("#timeline-title").textContent = shortId(sessionId);
  $("#timeline-stats").innerHTML = "";

  try {
    const res = await fetch("/api/sessions/" + encodeURIComponent(sessionId));
    if (!res.ok) {
      timelineEl.innerHTML = `<div class="error-msg">Failed to load: HTTP ${res.status}</div>`;
      return;
    }
    currentTimeline = await res.json();
  } catch (err) {
    timelineEl.innerHTML = `<div class="error-msg">Error: ${escapeHtml(String(err))}</div>`;
    return;
  }

  $("#timeline-title").textContent = (currentTimeline.header?.cwd || sessionId).split("/").pop() || sessionId;

  fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/summary")
    .then((r) => r.json())
    .then(renderTopbar)
    .catch(() => {});

  toolCallIdToResult = {};
  toolCallIdToMeta = {};
  for (const b of currentTimeline.blocks) {
    if (b.type === "tool_result") toolCallIdToResult[b.tool_call_id] = b;
    if (b.type === "llm_output") {
      for (const tc of b.tool_calls) toolCallIdToMeta[tc.id] = { name: tc.name, arguments: tc.arguments };
    }
  }

  renderTimeline(currentTimeline.blocks);
  renderTurnSidebar(currentTimeline.blocks);
}

function renderTopbar(summary) {
  if (!summary) return;
  const parts = [];
  parts.push(`<span>👤 <span class="value">${summary.turns}</span> turn${summary.turns === 1 ? "" : "s"}</span>`);
  parts.push(`<span>🤖 <span class="value">${summary.llm_calls}</span> LLM call${summary.llm_calls === 1 ? "" : "s"}</span>`);
  parts.push(`<span>🔧 <span class="value">${summary.tool_calls}</span> tool${summary.tool_calls === 1 ? "" : "s"}</span>`);
  if (summary.total_tokens) {
    parts.push(`<span>📥 <span class="value">${formatTokens(summary.input_tokens)}</span> in · 📤 <span class="value">${formatTokens(summary.output_tokens)}</span> out</span>`);
  }
  if (summary.total_cost) {
    parts.push(`<span>💰 <span class="value">${formatCost(summary.total_cost)}</span></span>`);
  }
  if (summary.errors) {
    parts.push(`<span style="color:var(--red)">⚠ <span class="value">${summary.errors}</span> error${summary.errors === 1 ? "" : "s"}</span>`);
  }
  if (summary.compactions) {
    parts.push(`<span style="color:var(--orange)">🧹 <span class="value">${summary.compactions}</span> compaction${summary.compactions === 1 ? "" : "s"}</span>`);
  }
  $("#timeline-stats").innerHTML = parts.join("");
}

function renderSystemPromptBlock(prompt) {
  const chars = (prompt || "").length;
  return `<div class="block block-system">
    <div class="block-system-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> ⚙️ System prompt <span class="count">· ${chars} chars</span>
    </div>
    <div class="block-system-text" style="display:none;">${escapeHtml(prompt)}</div>
  </div>`;
}

function renderTurnDivider(n) {
  return `<div class="turn-divider" id="turn-${n}">
    <span class="turn-number">Turn ${n}</span>
    <span class="turn-rule"></span>
  </div>`;
}

function turnTitle(text) {
  if (!text) return "(empty)";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return truncate(lines.slice(0, 2).join(" "), 80);
}

function renderTurnItem(t) {
  return `<div class="turn-item" data-turn="${t.number}" onclick="scrollToTurn(${t.number})">
    <span class="turn-item-number">${t.number}</span>
    <span class="turn-item-title">${escapeHtml(t.title)}</span>
  </div>`;
}

function renderTurnSidebar(blocks) {
  const sidebar = $("#turn-sidebar");
  if (!sidebar) return;
  let html = "";
  let n = 0;
  for (const b of blocks) {
    if (b.type === "user_input") {
      n++;
      html += renderTurnItem({ number: n, title: turnTitle(b.text) });
    }
  }
  sidebar.innerHTML = html || '<div class="turn-sidebar-empty">No turns</div>';
}

function scrollToTurn(n) {
  const el = document.getElementById("turn-" + n);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll(".turn-item").forEach((it) => it.classList.remove("active"));
  const item = document.querySelector('.turn-item[data-turn="' + n + '"]');
  if (item) item.classList.add("active");
}

function renderTimeline(blocks) {
  const container = $("#timeline");
  let html = "";
  if (currentTimeline && currentTimeline.system_prompt) {
    html += renderSystemPromptBlock(currentTimeline.system_prompt);
  }
  let turn = 0;
  for (const b of blocks) {
    if (b.type === "user_input") {
      turn++;
      html += renderTurnDivider(turn);
    }
    if (b.type === "user_input") html += renderUserBlock(b);
    else if (b.type === "llm_output") html += renderLlmBlock(b);
    else if (b.type === "tool_result") html += renderToolResultBlock(b);
    else if (b.type === "custom_message") html += renderCustomMessageBlock(b);
    else if (b.type === "compaction") html += renderCompactionBlock(b);
    else if (b.type === "branch_summary") html += renderBranchSummaryBlock(b);
  }
  container.innerHTML = html;
}

function renderUserBlock(block) {
  const chars = (block.text || "").length;
  return `<div class="block block-user">
    <div class="block-user-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> 👤 User input <span class="count">· ${chars} chars</span>
    </div>
    <div class="block-user-text" style="display:none;">${escapeHtml(block.text)}</div>
  </div>`;
}

function renderLlmBlock(block) {
  let body = "";
  if (block.thinking) {
    const chars = block.thinking.length;
    body += `<div class="block-thinking">
      <div class="block-thinking-label" onclick="toggleCollapse(this)">
        <span class="chev">▶</span> 💭 Thinking <span class="count">· ${chars} chars</span>
      </div>
      <div class="block-thinking-body" style="display:none;">${escapeHtml(block.thinking)}</div>
    </div>`;
  }
  if (block.text) {
    const chars = block.text.length;
    body += `<div class="block-text-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> 💬 Text <span class="count">· ${chars} chars</span>
    </div>
    <div class="block-text" style="display:none;">${escapeHtml(block.text)}</div>`;
  }
  for (const tc of block.tool_calls) {
    const argsJson = prettyJson(tc.arguments);
    const preview = truncate(argsJson.replace(/\n/g, " "), 80);
    body += `<div class="tool-call" id="tc-${escapeHtml(tc.id)}">
      <div class="tool-call-header" onclick="toggleArgs(this)">
        <span>🔧</span>
        <span class="tool-call-name">${escapeHtml(tc.name)}</span>
        <span class="tool-call-duration">${escapeHtml(preview)}</span>
        <span class="tool-call-chevron">▶</span>
      </div>
      <div class="tool-call-args" style="display:none;">${escapeHtml(argsJson)}</div>
      <div class="tool-call-detail-btn" onclick="showToolDetail('${escapeHtml(tc.id)}')">View input/output ↓</div>
    </div>`;
  }
  let usageStr = "";
  if (block.usage) {
    usageStr = `${formatTokens(block.usage.input)} in → ${formatTokens(block.usage.output)} out`;
    if (block.usage.cost && block.usage.cost.total) usageStr += " · " + formatCost(block.usage.cost.total);
  }
  return `<div class="block block-llm">
    <div class="block-llm-header">
      <span class="block-llm-label">🤖 LLM output</span>
      <span class="block-llm-model">${escapeHtml(block.model || "unknown")}</span>
      <span class="timestamp">${formatTime(block.timestamp)}</span>
      <span class="block-llm-usage">${usageStr}</span>
    </div>
    <div class="block-llm-body">${body}</div>
  </div>`;
}

function renderToolResultBlock(block) {
  const isError = block.is_error;
  const blockClass = isError ? "block block-tool block-tool-error" : "block block-tool";
  const nameClass = isError ? "block-tool-name block-tool-name-error" : "block-tool-name";
  const outputClass = isError ? "block-tool-output is-error" : "block-tool-output";
  let duration = "";
  if (block.details && block.details.durationMs !== undefined) duration = formatDuration(block.details.durationMs);

  return `<div class="${blockClass}">
    <div class="block-tool-header" onclick="toggleResult(${block.index})">
      <span>📤</span>
      <span class="${nameClass}">${escapeHtml(block.tool_name)}</span>
      ${duration ? `<span class="block-tool-duration">⏱ ${duration}</span>` : ""}
      ${isError ? '<span class="block-tool-duration" style="color:var(--red)">⚠ error</span>' : ""}
      <span class="timestamp">${formatTime(block.timestamp)}</span>
      <span class="block-tool-chevron" id="chevron-${block.index}">▶</span>
    </div>
    <div class="${outputClass}" id="output-${block.index}" style="display:none;">${escapeHtml(block.output || "(no output)")}</div>
  </div>`;
}

function renderCustomMessageBlock(block) {
  const chars = (block.text || "").length;
  return `<div class="block block-custom">
    <div class="block-custom-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> 🔌 Custom message · ${escapeHtml(block.custom_type)} <span class="count">· ${chars} chars</span>
    </div>
    <div class="block-custom-text" style="display:none;">${escapeHtml(block.text)}</div>
  </div>`;
}

function renderCompactionBlock(block) {
  return `<div class="block block-compaction">
    <div class="block-compaction-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> 🧹 Context compacted <span class="count">· ${formatTokens(block.tokens_before)} tokens before</span>
    </div>
    <div class="block-compaction-summary" style="display:none;">${escapeHtml(block.summary)}</div>
  </div>`;
}

function renderBranchSummaryBlock(block) {
  return `<div class="block block-branch">
    <div class="block-branch-label" onclick="toggleCollapse(this)">
      <span class="chev">▶</span> 🌿 Branch summary
    </div>
    <div class="block-branch-summary" style="display:none;">${escapeHtml(block.summary)}</div>
  </div>`;
}

// ─── Timeline interactions ────────────────────────────────────────
function toggleCollapse(headerEl) {
  const body = headerEl.nextElementSibling;
  const chev = headerEl.querySelector(".chev");
  if (!body) return;
  const wasHidden = body.style.display === "none";
  body.style.display = wasHidden ? "block" : "none";
  if (chev) chev.textContent = wasHidden ? "▼" : "▶";
}

function toggleArgs(headerEl) {
  const argsEl = headerEl.parentNode.querySelector(".tool-call-args");
  const chevron = headerEl.querySelector(".tool-call-chevron");
  if (argsEl.style.display === "none") { argsEl.style.display = "block"; chevron.classList.add("expanded"); }
  else { argsEl.style.display = "none"; chevron.classList.remove("expanded"); }
}
function toggleResult(index) {
  const out = document.getElementById("output-" + index);
  const chevron = document.getElementById("chevron-" + index);
  if (!out || !chevron) return;
  if (out.style.display === "none") { out.style.display = "block"; chevron.classList.add("expanded"); }
  else { out.style.display = "none"; chevron.classList.remove("expanded"); }
}
function showToolDetail(toolCallId) {
  const panel = $("#detail-panel");
  panel.hidden = false;
  const meta = toolCallIdToMeta[toolCallId];
  const result = toolCallIdToResult[toolCallId];
  $("#detail-title").textContent = (meta ? meta.name : "tool") + " — " + shortId(toolCallId);
  $("#detail-input").innerHTML = escapeHtml(meta ? prettyJson(meta.arguments) : "(no arguments)");
  const outEl = $("#detail-output");
  outEl.innerHTML = escapeHtml(result ? (result.output || "(no output)") : "(no result)");
  outEl.style.color = result && result.is_error ? "var(--red)" : "";
}
function closeDetail() {
  $("#detail-panel").hidden = true;
}

// ─── Events ───────────────────────────────────────────────────────
function bindEvents() {
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#back").addEventListener("click", showHome);

  $("#search").addEventListener("input", (e) => {
    search = e.target.value;
    renderHome();
  });
  $("#sort").addEventListener("change", (e) => {
    sortMode = e.target.value;
    renderHome();
  });
  $("#group-select").addEventListener("change", (e) => {
    groupMode = e.target.value;
    renderHome();
  });
  $("#view-toggle").addEventListener("click", () => {
    viewMode = viewMode === "cards" ? "compact" : "cards";
    renderHome();
  });

  $("#kernel-toggle").addEventListener("click", toggleKernel);

  // Delegate clicks on the session list (group collapse + session select).
  $("#session-list").addEventListener("click", (e) => {
    const header = e.target.closest(".group-header");
    if (header) {
      const body = header.nextElementSibling;
      const key = header.dataset.groupKey;
      const chevron = header.querySelector(".chevron");
      if (body.hidden) { collapsedGroups.delete(key); body.hidden = false; chevron.classList.remove("collapsed"); }
      else { collapsedGroups.add(key); body.hidden = true; chevron.classList.add("collapsed"); }
      return;
    }
    const item = e.target.closest("[data-session-id]");
    if (item) openSession(item.dataset.sessionId);
  });

  // "?" focuses search (matching kimi vis).
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    else if (e.key === "Escape" && !$("#home-view").hidden) { $("#search").value = ""; search = ""; renderHome(); $("#search").blur(); }
  });
}

// ─── Init ─────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    sessions = data.sessions || [];
  } catch (err) {
    sessions = [];
    $("#session-list").innerHTML = `<div class="error-msg">Failed to load sessions: ${escapeHtml(String(err))}</div>`;
  }
  renderHome();
}

function init() {
  const saved = localStorage.getItem(THEME_KEY);
  const sys = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(saved || sys);
  bindEvents();
  loadLiveInfo();
  loadSessions();
}

document.addEventListener("DOMContentLoaded", init);
