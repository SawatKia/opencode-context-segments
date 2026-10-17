/**
 * context-segments — web.ts
 *
 * Ephemeral loopback dashboard for skill/context stats. Stdlib `node:http`
 * only — no dependencies.
 *
 * Lifecycle (per approved plan):
 *  - Binds 127.0.0.1 on a random free port; single-use token in the URL path.
 *  - The page heartbeats GET /ping; ANY authenticated request refreshes it.
 *  - Auto-close: no heartbeat for >25s after the first one (tab closed),
 *    or never pinged within 90s (browser never opened), or idle timeout
 *    with zero requests, or explicit stop(), or plugin unload cleanup.
 *
 * XSS: every value from the server reaches the DOM through
 * createElement + textContent (innerHTML is only ever used for the fixed,
 * data-free `<td>` scaffolding). There is therefore no HTML-escaping helper
 * and there never needs to be one — the previous `escapeHtml` was dead code.
 */

import http from "node:http";
import crypto from "node:crypto";

export interface DashboardData {
  summary: unknown;
  skills: unknown;
  generatedAt: number;
}

export interface DashboardCallbacks {
  getData: (sessionID?: string) => Promise<DashboardData>;
  /** Best-effort browser open; returns true when a launcher was spawned. */
  openBrowser?: (url: string) => boolean;
  idleMs?: number;
}

interface Handle {
  url: string;
  token: string;
  port: number;
  stop: () => void;
  startedAt: number;
}

let current: {
  server: http.Server;
  handle: Handle;
  lastSeen: number;
  everSeen: boolean;
  timer: ReturnType<typeof setInterval>;
} | null = null;

export function dashboardRunning(): Handle | null {
  return current?.handle ?? null;
}

export function stopDashboard(): boolean {
  // Null first: a concurrent startDashboard() must build a fresh server
  // instead of grabbing a handle we are about to close.
  const cur = current;
  current = null;
  if (!cur) return false;
  try {
    clearInterval(cur.timer);
  } catch {
    // ignore
  }
  try {
    // close() alone waits for keep-alive/heartbeat sockets; drop them so
    // stop() never hangs the plugin unload path.
    const srv = cur.server as unknown as {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    try {
      srv.closeAllConnections?.();
    } catch {
      // older runtimes lack it — fall through to close()
    }
    try {
      srv.closeIdleConnections?.();
    } catch {
      // ignore
    }
    cur.server.close();
  } catch {
    // ignore
  }
  return true;
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function pageHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Context segments</title>
<style>
:root { color-scheme: dark; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0d12; color: #d6dae3; margin: 0; padding: 24px; }
main { max-width: 1120px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 4px; }
p.sub { color: #8b8fa3; font-size: 12px; margin: 0 0 20px; }
section { background: #12151c; border: 1px solid #232838; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b8fa3; margin: 0 0 12px; }
.bar { display: flex; height: 18px; border-radius: 6px; overflow: hidden; background: #1d2230; margin: 8px 0; }
.bar > div { height: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: #8b8fa3; font-weight: normal; padding: 4px 8px 4px 0; border-bottom: 1px solid #232838; }
td { padding: 5px 8px 5px 0; border-bottom: 1px solid #181c26; overflow-wrap: anywhere; word-break: break-word; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; vertical-align: baseline; }
.row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
.row .name { width: 110px; color: #aab0c0; flex-shrink: 0; }
.row .pct { margin-left: auto; text-align: right; color: #8b8fa3; white-space: nowrap; }
details.topic { border: 1px solid #232838; border-radius: 8px; margin: 8px 0; padding: 0; }
details.topic > summary { cursor: pointer; padding: 10px 12px; font-size: 13px; list-style: none; overflow-wrap: anywhere; }
details.topic > summary::-webkit-details-marker { display: none; }
details.topic > summary::before { content: "▸ "; color: #8b8fa3; }
details.topic[open] > summary::before { content: "▾ "; }
details.topic .body { padding: 4px 12px 12px; font-size: 13px; color: #aab0c0; }
details.topic .body .hint { color: #8b8fa3; font-size: 12px; margin: 0 0 8px; overflow-wrap: anywhere; }
details.topic ul.contrib { margin: 8px 0 0 18px; padding: 0; }
details.topic ul.contrib li { margin: 6px 0; overflow-wrap: anywhere; word-break: break-word; }
details.topic ul.contrib .lbl { display: block; color: #8b8fa3; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
.warn { color: #fbbf24; } .crit { color: #f87171; }
.toolbar { display: flex; gap: 8px; margin-bottom: 20px; }
input, button { font: inherit; font-size: 13px; }
input { flex: 1; background: #12151c; color: #d6dae3; border: 1px solid #232838; border-radius: 8px; padding: 8px 10px; }
button { background: #232838; color: #d6dae3; border: 1px solid #333b52; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
button:hover { background: #2b3247; }
footer { color: #5b6172; font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
<main>
<h1>Context segments</h1>
<p class="sub" id="sub">loading…</p>
<div class="toolbar">
<input id="session" placeholder="session id (optional — leave empty for skill stats only)" />
<button id="load">Load session</button>
</div>
<section id="ctx" hidden>
<h2>Session context</h2>
<div class="bar" id="bar"></div>
<p class="sub" id="compnote">Composition is a partition of used context — open a topic for contributors. Tool tokens are returned-output estimates, not window shares.</p>
  <p class="sub" id="caveat"></p>
<div id="segs"></div>
<details class="topic" id="toolioall"><summary>Tool I/O (all tools)</summary><div class="body">
<p class="hint">Every ranked tool row, unsliced. These are transcript-text estimates of <strong>returned output</strong> — deliberately NOT scaled to the context total and never summed against it. The segment bar above is a partition of used context (the composition); this list is tool-returned bytes on their own account. Conflating the two is what made earlier versions of this page lie.</p>
<table><thead><tr><th>Tool</th><th>Source</th><th>~Returned</th><th>Calls</th></tr></thead><tbody id="tooliobody"></tbody></table>
</div></details>
<div id="warn"></div>
</section>
<section id="tools" hidden>
<h2>Top tools <span id="clfsrc" style="text-transform:none"></span></h2>
<p class="sub">By returned output (estimates) — not shares of used context.</p>
<details class="topic" id="toolsdet"><summary>Top tools</summary><div class="body">
<table><thead><tr><th>Tool</th><th>Source</th><th>~Returned</th><th>Calls</th></tr></thead><tbody id="toolsbody"></tbody></table>
<p class="sub" id="tooltotals"></p>
</div></details>
<details class="topic" id="detailsdet"><summary>Loaded details (heaviest individual loads)</summary><div class="body">
<table><thead><tr><th>Tool</th><th>What was loaded</th><th>~Tokens</th><th>Calls</th></tr></thead><tbody id="detailsbody"></tbody></table>
</div></details>
</section>
<section id="sess" hidden>
<h2>Session totals</h2>
<details class="topic" id="sessdet" open><summary>Cumulative across requests — NOT current window</summary><div class="body">
<p class="sub" id="sessbody"></p>
<p class="sub" id="transcript"></p>
</div></details>
</section>
<section>
<h2>Skill usage (all sessions)</h2>
<table><thead><tr><th>Skill</th><th>Uses</th><th>Est. tokens</th><th>Last used</th></tr></thead><tbody id="skills"></tbody></table>
</section>
<footer>Loopback-only dashboard. Closing this tab stops the server automatically.</footer>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error("request failed");
  return res.json();
}
async function ping() { try { await fetch("ping"); } catch {} }
setInterval(ping, 5000);
function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
async function load() {
  const session = document.getElementById("session").value.trim();
  const data = await getJSON("data" + (session ? "?session=" + encodeURIComponent(session) : ""));
  document.getElementById("sub").textContent =
    "generated " + new Date(data.generatedAt).toLocaleTimeString();
  const skillsBody = document.getElementById("skills");
  skillsBody.innerHTML = "";
  const skills = (data.skills && data.skills.skills) || [];
  if (skills.length === 0) {
    skillsBody.innerHTML = '<tr><td colspan="4">No skill invocations recorded yet.</td></tr>';
  }
  for (const s of skills.slice(0, 30)) {
    const tr = document.createElement("tr");
    const last = s.lastUsed ? new Date(s.lastUsed).toLocaleString() : "—";
    tr.innerHTML = "<td></td><td></td><td></td><td></td>";
    tr.children[0].textContent = s.name;
    tr.children[1].textContent = s.count;
    tr.children[2].textContent = "~" + fmt(s.estTokens);
    tr.children[3].textContent = last;
    skillsBody.appendChild(tr);
  }
  const ctx = document.getElementById("ctx");
  const summary = data.summary;
  if (!summary || summary.ok === false) { ctx.hidden = true; return; }
  ctx.hidden = false;
  const bar = document.getElementById("bar");
  bar.innerHTML = "";
  const segs = document.getElementById("segs");
  segs.innerHTML = "";
  for (const seg of summary.segments) {
    if (!seg.tokens) continue;
    const share = summary.limit ? Math.min(1, seg.tokens / summary.limit) : 0;
    const div = document.createElement("div");
    div.style.width = (share * 100).toFixed(2) + "%";
    div.style.background = seg.color;
    div.title = seg.label + ": " + fmt(seg.tokens) + " tokens";
    bar.appendChild(div);
    // Server-provided share. pctOfLimit is null when the model limit is
    // unknown — render that as "unknown", never as 0%.
    const pctW = (seg.pctOfLimit !== null && seg.pctOfLimit !== undefined) ? seg.pctOfLimit.toFixed(1) + "% of window" : "window share unknown";
    const pctU = (seg.pctOfUsed !== null && seg.pctOfUsed !== undefined) ? seg.pctOfUsed.toFixed(1) + "% of used" : "share of used unknown";
    const det = document.createElement("details");
    det.className = "topic";
    const sum = document.createElement("summary");
    sum.textContent = seg.label + " " + pctW + " (" + pctU + ") (" + fmt(seg.tokens) + ")";
    det.appendChild(sum);
    const body = document.createElement("div");
    body.className = "body";
    // Server-side othersContributors and contributors["others"] are the
    // same array; prefer the named field. It is deliberately NOT sliced to a
    // top-N — "others" is the catch-all, so truncating it is how mass hides.
    const rows = seg.key === "others" && summary.othersContributors
      ? summary.othersContributors
      : (summary.contributors && summary.contributors[seg.key]) || [];
    if (rows.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = seg.key === "unaccounted"
        ? "Rounding + non-text residual inside the partition — not a consumer to optimize."
        : "No per-item rows recorded.";
      body.appendChild(hint);
    } else {
      const ul = document.createElement("ul");
      ul.className = "contrib";
      for (const r of rows) {
        const li = document.createElement("li");
        const trunc = r.truncatedCalls > 0 ? ", " + r.truncatedCalls + " truncated" : "";
        const shareTxt = summary.used > 0 ? ((r.tokens / summary.used) * 100).toFixed(1) + "% of used" : "share n/a";
        li.textContent = (r.name || "") + (r.category ? " [" + r.category + "]" : "") + ": ~" + fmt(r.tokens) + " returned (" + shareTxt + "), " + r.calls + " calls" + trunc + (r.method === "estimated" ? ", estimated" : "");
        const lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = r.label || "";
        li.appendChild(lbl);
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    det.appendChild(body);
    segs.appendChild(det);
  }
  // The residual is a fact about the partition, so state it plainly instead of
  // letting the segment row speak for itself. Only shown when non-zero.
  const unacct = document.getElementById("caveat");
  if (unacct) {
    const notes = [];
    if ((summary.unaccounted || 0) > 0) {
      notes.push("unaccounted: " + fmt(summary.unaccounted) + " tokens (rounding + non-text parts inside the partition — not a consumer to optimize)");
    }
    unacct.textContent = notes.join(" · ");
  }
  const toolIO = summary.toolIO || [];
  const toolIODet = document.getElementById("toolioall");
  const toolIOBody = document.getElementById("tooliobody");
  if (toolIODet) {
    toolIODet.hidden = toolIO.length === 0;
    toolIOBody.innerHTML = "";
    if (toolIO.length === 0) {
      toolIOBody.innerHTML = '<tr><td colspan="4">No tool calls recorded.</td></tr>';
    }
    // Every row, unsliced — toolIO is already ranked by returned bytes.
    for (const t of toolIO) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = t.name;
      tr.children[1].textContent = t.category || "—";
      tr.children[2].textContent = "~" + fmt(t.tokens) + " returned";
      tr.children[3].textContent = t.calls + (t.truncatedCalls > 0 ? " (" + t.truncatedCalls + " truncated)" : "");
      toolIOBody.appendChild(tr);
    }
  }
  const toolsSec = document.getElementById("tools");
  const toolsBody = document.getElementById("toolsbody");
  const clf = document.getElementById("clfsrc");
  toolsBody.innerHTML = "";
  const topTools = summary.topTools || [];
  if (topTools.length === 0) { toolsSec.hidden = true; }
  else {
    toolsSec.hidden = false;
    clf.textContent = summary.classifierSource === "registry" ? "(registry-classified)"
      : summary.classifierSource === "heuristic" ? "(name-heuristic; registry unavailable)" : "";
    for (const t of topTools.slice(0, 10)) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = t.name;
      tr.children[1].textContent = t.category || "—";
      tr.children[2].textContent = "~" + fmt(t.tokens) + " returned";
      tr.children[3].textContent = t.calls + (t.truncatedCalls > 0 ? " (" + t.truncatedCalls + " truncated)" : "");
      toolsBody.appendChild(tr);
    }
    const totals = summary.toolTotals || {};
    document.getElementById("tooltotals").textContent = "Tool output by source (returned, estimated): " +
      Object.keys(totals).filter(function (k) { return totals[k].tokens > 0 || totals[k].calls > 0; }).map(function (k) { return k + " ~" + fmt(totals[k].tokens) + " returned/" + totals[k].calls + " calls"; }).join(" · ");
    const detailsBody = document.getElementById("detailsbody");
    detailsBody.innerHTML = "";
    const topDetails = summary.topDetails || [];
    if (topDetails.length === 0) {
      detailsBody.innerHTML = '<tr><td colspan="4">No itemized loads recorded.</td></tr>';
    }
    for (const d of topDetails.slice(0, 12)) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td>";
      tr.children[0].textContent = d.name + (d.category ? " [" + d.category + "]" : "");
      tr.children[1].textContent = d.label;
      tr.children[2].textContent = "~" + fmt(d.tokens);
      tr.children[3].textContent = d.calls + (d.truncatedCalls > 0 ? " (" + d.truncatedCalls + " truncated)" : "");
      detailsBody.appendChild(tr);
    }
  }
  const sessSec = document.getElementById("sess");
  if (summary.cumulative) {
    sessSec.hidden = false;
    const c = summary.cumulative;
    document.getElementById("sessbody").textContent =
      "Cumulative across requests — NOT current window" + (c.scope ? " (" + c.scope + ")" : "") +
      ": in " + fmt(c.input) + ", out " + fmt(c.output) + ", reasoning " + fmt(c.reasoning) +
      ", cache read/write " + fmt(c.cacheRead) + "/" + fmt(c.cacheWrite) +
      ". Cache-read counts reused prefix tokens, not new context.";
  } else { sessSec.hidden = true; }
  const counts = summary.counts || {};
  const tx = document.getElementById("transcript");
  if (tx) {
    tx.textContent = "Transcript: " + fmt(counts.messages || 0) + " messages (" +
      fmt(counts.userMessages || 0) + " user, " + fmt(counts.assistantMessages || 0) + " assistant, " +
      fmt(counts.systemMessages || 0) + " system, " + fmt(counts.syntheticMessages || 0) + " synthetic, " +
      fmt(counts.compactionCount || 0) + " compaction, " + fmt(counts.ignoredMessages || 0) + " ignored)";
    const skips = [];
    if ((counts.excludedByCompaction || 0) > 0) {
      skips.push(fmt(counts.excludedByCompaction) + " entries fenced out by compaction (replaced by the compaction summary + recent, so excluded from the composition)");
    }
    if ((summary.skippedParts || 0) > 0) {
      skips.push(fmt(summary.skippedParts) + " non-text parts skipped (images/binary we cannot size — they occupy context and land in unaccounted)");
    }
    if (skips.length > 0) tx.textContent += " · " + skips.join(" · ");
  }
  const warn = document.getElementById("warn");
  warn.innerHTML = "";
  if (summary.warn) {
    const w = document.createElement("p");
    w.className = summary.warn.level === "critical" ? "crit" : "warn";
    w.textContent = summary.warn.text;
    warn.appendChild(w);
  }
  const head = summary.limit && summary.pct !== null && summary.pct !== undefined
    ? fmt(summary.used) + " / " + fmt(summary.limit) + " tokens (" + summary.pct.toFixed(1) + "% of window)"
    : fmt(summary.used) + " tokens (limit unknown)";
  const method = summary.context && summary.context.method
    ? summary.context.method === "provider" ? "provider-anchored"
      : summary.context.method === "estimate" ? "estimates" : "unattributed"
    : (summary.estimated ? "estimates" : "provider-anchored");
  const remaining = summary.context && summary.context.remaining !== null && summary.context.remaining !== undefined
    ? ", " + fmt(summary.context.remaining) + " remaining" : "";
  const stale = summary.context && summary.context.stale ? " [stale: newer turn reported no usage]" : "";
  document.getElementById("sub").textContent = head + remaining + " [" + method + "]" + stale + " — " + summary.model;
}
document.getElementById("load").addEventListener("click", () => load().catch(() => {}));
load().catch(() => {});
ping();
</script>
</body>
</html>`;
}

export async function startDashboard(
  callbacks: DashboardCallbacks,
): Promise<Handle> {
  if (current) return current.handle;
  // Clamp the idle window: a zero/negative value would kill the server
  // immediately, an absurd one would leak it for days.
  const rawIdle = callbacks.idleMs ?? 5 * 60 * 1000;
  const idleMs = Number.isFinite(rawIdle)
    ? Math.min(Math.max(rawIdle, 30_000), 30 * 60 * 1000)
    : 5 * 60 * 1000;
  const token = crypto.randomBytes(16).toString("hex");
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 2 || parts[0] !== "t" || parts[1] !== token) {
          unauthorized(res);
          return;
        }
        if (!current) {
          unauthorized(res);
          return;
        }
        current.lastSeen = Date.now();
        current.everSeen = true;
        const rest = parts.slice(2).join("/");
        if (rest === "" && req.method === "GET") {
          const html = pageHtml(token);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        if (rest === "ping") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (rest === "data" && req.method === "GET") {
          const sessionID = url.searchParams.get("session") ?? undefined;
          const data = await callbacks.getData(sessionID);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
          return;
        }
        unauthorized(res);
      } catch (error) {
        try {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`error: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // ignore
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const handle: Handle = {
    url: `http://127.0.0.1:${port}/t/${token}/`,
    token,
    port,
    stop: () => {
      stopDashboard();
    },
    startedAt,
  };

  const timer = setInterval(() => {
    if (!current) return;
    const now = Date.now();
    const silentFor = now - current.lastSeen;
    // Tab closed (heartbeats stopped) or browser never opened.
    if ((current.everSeen && silentFor > 25_000) || now - startedAt > idleMs) {
      stopDashboard();
      return;
    }
    if (!current.everSeen && now - startedAt > 90_000) {
      stopDashboard();
    }
  }, 5000);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  current = { server, handle, lastSeen: startedAt, everSeen: false, timer };

  if (callbacks.openBrowser) {
    try {
      callbacks.openBrowser(handle.url);
    } catch {
      // best-effort only
    }
  }
  return handle;
}
