/**
 * context-segments — tui.tsx (TUI entrypoint).
 *
 * - Compact bar in `prompt.footer.status` (per-segment colors + %).
 * - Full breakdown section in `sidebar.content` (appended; the native
 *   readout is left untouched).
 * - `/cseg` detail panel, `/cseg-skills` skill viewer (terminal or web).
 *
 * Data comes from the server RPC (single source of truth). Imports are
 * limited to `@opencode/plugin/tui` + `solid-js` on purpose. Colors use
 * theme tokens when the host has resolved them (any theme, dark or light);
 * before that, every lookup falls back to the default color.
 */

import { Plugin, usePlugin } from "@opencode/plugin/tui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

/** MUST match rpc-def.ts on the server (id + method names). */
const csegDef = {
  id: "context-segments",
  methods: { getSummary: {}, getSkills: {}, startWeb: {}, stopWeb: {}, postSummary: {} },
  events: {},
} as const;

const LOAD_FLAG = "__cseg_tui_setup_done__";

interface SegmentDatum {
  key: string;
  label: string;
  color: string;
  tokens: number;
  pctOfLimit: number | null;
  pctOfUsed: number | null;
}

interface ToolRow {
  name: string;
  tokens: number;
  calls: number;
  /** Tool source bucket; absent on summaries from older servers. */
  category?: string;
  truncatedCalls?: number;
}

interface ContributorRow {
  name: string;
  label: string;
  tokens: number;
  calls: number;
  category?: string;
  truncatedCalls?: number;
  method?: "provider" | "estimated";
  inContext?: boolean;
}

type ToolCategory = "skills" | "mcps" | "rules" | "others";

interface Summary {
  ok?: boolean;
  error?: string;
  model: string;
  limit: number | null;
  used: number;
  pct: number | null;
  /** New shaped usage; absent on summaries from older servers. */
  context?: {
    used: number;
    limit: number | null;
    pct: number | null;
    remaining: number | null;
    method: "provider" | "estimate" | "unknown";
    stale: boolean;
  };
  segments: SegmentDatum[];
  /** Residual inside the partition; absent on older servers. */
  unaccounted?: number;
  skippedParts?: number;
  topTools: ToolRow[];
  /** Every ranked tool, unsliced — the full list behind the top-N slice. */
  toolIO?: ToolRow[];
  topSkills: { id: string; name: string; tokens: number; count: number }[];
  /** Per-category tool leaders; absent on summaries from older servers. */
  topByCategory?: Record<ToolCategory, ToolRow[]>;
  /** Token/call totals per tool category. */
  toolTotals?: Record<ToolCategory, { tokens: number; calls: number }>;
  /** Heaviest individual loads; absent on summaries from older servers. */
  topDetails?: {
    name: string;
    label: string;
    tokens: number;
    calls: number;
    category?: string;
    truncatedCalls?: number;
  }[];
  /** Per-segment drill-down rows; absent on older servers. */
  contributors?: Record<string, ContributorRow[]>;
  othersContributors?: ContributorRow[];
  /** Whether MCP attribution used the live registry or name heuristics. */
  classifierSource?: "registry" | "heuristic";
  counts: {
    messages: number;
    steps: number;
    userMessages?: number;
    assistantMessages?: number;
    systemMessages?: number;
    syntheticMessages?: number;
    compactionCount?: number;
    ignoredMessages?: number;
    excludedByCompaction?: number;
  };
  warn: { level: string; text: string } | null;
  estimated: boolean;
  cumulative: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    scope?: string;
  } | null;
}

interface SkillRow {
  id: string;
  name: string;
  count: number;
  lastUsed: number;
  estTokens: number;
}

type Theme = {
  text?: {
    base?: unknown;
    muted?: unknown;
    feedback?: {
      error?: { base?: unknown };
      warning?: { base?: unknown };
      success?: { base?: unknown };
      info?: { base?: unknown };
    };
  };
  syntax?: {
    keyword?: unknown;
    comment?: unknown;
    function?: unknown;
    string?: unknown;
    number?: unknown;
  };
};

/**
 * The TUI context exposes the resolved theme directly as ctx.theme (nested
 * tokens: text.base, text.muted, text.feedback.*, syntax.*). There is no
 * `.current` layer — reading one yields undefined and crashed the footer
 * slot. Return the live theme when present, otherwise an empty object so
 * every fg lookup degrades to the default color instead of throwing.
 */
function themeOf(ctx: { theme?: unknown }): Theme {
  const current = (ctx as { theme?: unknown } | undefined)?.theme;
  if (current && typeof current === "object") return current as Theme;
  return {};
}

// Explicit bar palette: /context's theme paints several rows the same grey,
// so each used row gets its own color, in order. The history row (the one
// that grows with the conversation) gets the accent color. Free space is a
// mid-grey thin line that reads as empty on dark and light themes.
const PALETTE = [
  "#7aa2f7",
  "#7dcfff",
  "#bb9af7",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
  "#73daca",
  "#ff9e64",
  "#c0caf5",
];
const MESSAGES = "#d97757";
const FREE = "#808080";

/** Map every used segment key to its bar color. Track/free resolves later. */
function paletteFor(summary: Summary): Map<string, string> {
  const map = new Map<string, string>();
  let order = 0;
  for (const seg of summary.segments) {
    if (!seg.tokens) continue;
    if (seg.key === "history") {
      map.set(seg.key, MESSAGES);
    } else {
      map.set(seg.key, PALETTE[order % PALETTE.length]);
      order += 1;
    }
  }
  return map;
}

function formatNumber(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function pctLabel(summary: Summary): { text: string; level: string } {
  if (summary.pct === null || summary.pct === undefined) {
    return { text: `${formatNumber(summary.used)}`, level: "unknown" };
  }
  const level =
    summary.warn?.level === "critical"
      ? "critical"
      : summary.warn?.level === "warn"
        ? "warn"
        : "normal";
  // Percentages must always state their denominator — never a bare "%".
  // This is a status bar, so keep it to the shortest honest form: the
  // percent plus "of window" (it is a share of the context window, not of
  // used). Unknown limit is handled above: no percent is printed at all,
  // so there is no fabricated 0% and no denominator to state.
  return { text: `${summary.pct.toFixed(0)}% of window`, level };
}

function levelColor(theme: Theme, level: string): unknown {
  if (level === "critical") return theme.text?.feedback?.error?.base;
  if (level === "warn") return theme.text?.feedback?.warning?.base;
  return theme.text?.base;
}

function useRpc(): {
  getSummary: (args: { sessionID: string }) => Promise<Summary | null>;
  getSkills: () => Promise<{ skills: SkillRow[] } | null>;
  startWeb: () => Promise<{ url?: string; ok?: boolean; error?: string } | null>;
  postSummary: (args: { sessionID: string }) => Promise<{ ok?: boolean; error?: string } | null>;
} {
  const ctx = usePlugin();
  const client = (ctx.client as unknown as Record<string, unknown>).rpc as
    | ((def: unknown) => Record<string, (args?: unknown) => Promise<unknown>>)
    | undefined;
  const rpc = client ? client(csegDef) : null;
  return {
    getSummary: async (args) => {
      try {
        if (!rpc) return null;
        const res = (await rpc.getSummary(args)) as Summary | null;
        if (!res || res.ok === false) return null;
        return res;
      } catch {
        return null;
      }
    },
    getSkills: async () => {
      try {
        if (!rpc) return null;
        const res = (await rpc.getSkills({})) as {
          skills?: SkillRow[];
        } | null;
        return res && Array.isArray(res.skills) ? { skills: res.skills } : null;
      } catch {
        return null;
      }
    },
    startWeb: async () => {
      try {
        if (!rpc) return null;
        return (await rpc.startWeb({})) as {
          url?: string;
          ok?: boolean;
          error?: string;
        } | null;
      } catch {
        return null;
      }
    },
    postSummary: async (args) => {
      try {
        if (!rpc) return null;
        return (await rpc.postSummary(args)) as {
          ok?: boolean;
          error?: string;
        } | null;
      } catch {
        return null;
      }
    },
  };
}

function useSummary(sessionID: () => string | undefined) {
  const ctx = usePlugin();
  const rpc = useRpc();
  const [data, setData] = createSignal<Summary | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let seq = 0;
  const load = (sid: string) => {
    const my = ++seq;
    setLoading(true);
    setFailed(false);
    rpc
      .getSummary({ sessionID: sid })
      .then((res) => {
        if (my !== seq) return;
        if (res) {
          setData(res);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (my !== seq) return;
        setFailed(true);
      })
      .finally(() => {
        if (my !== seq) return;
        setLoading(false);
      });
  };
  const retry = () => {
    const sid = sessionID();
    if (sid) load(sid);
  };
  // Trailing debounce for event-driven refreshes: step/skill events can
  // burst during multi-step turns, and each refresh walks the full
  // transcript plus an RPC round-trip. Session switches and manual
  // retries below still load immediately.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (sid: string) => {
    try {
      if (refreshTimer) clearTimeout(refreshTimer);
    } catch {
      // ignore
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      load(sid);
    }, 300);
  };
  onCleanup(() => {
    try {
      if (refreshTimer) clearTimeout(refreshTimer);
    } catch {
      // ignore
    }
    refreshTimer = undefined;
  });
  createEffect(() => {
    const sid = sessionID();
    if (!sid) {
      seq++;
      setData(null);
      setFailed(false);
      setLoading(false);
      return;
    }
    load(sid);
  });
  createEffect(() => {
    const sid = sessionID();
    if (!sid) return;
    const bump = (got: string) => {
      if (got === sid) schedule(sid);
    };
    // An unknown event name (host drift) must not take the component down.
    let offs: (() => void)[] = [];
    try {
      offs = [
        ctx.data.on("session.step.ended", (e) => bump(e.data.sessionID)),
        ctx.data.on("session.skill.activated", (e) => bump(e.data.sessionID)),
      ];
    } catch {
      offs = [];
    }
    onCleanup(() => {
      for (const off of offs) {
        try {
          off();
        } catch {
          // ignore
        }
      }
    });
  });
  return { data, loading, failed, retry } as const;
}

function cellsFor(
  summary: Summary,
  width: number,
): { ch: string; key: string }[] {
  const cells: { ch: string; key: string }[] = [];
  if (summary.limit && summary.limit > 0) {
    let placed = 0;
    for (const seg of summary.segments) {
      if (!seg.tokens) continue;
      const n = Math.max(
        1,
        Math.round((seg.tokens / (summary.limit as number)) * width),
      );
      for (let i = 0; i < n && placed < width; i++) {
        cells.push({ ch: "█", key: seg.key });
        placed += 1;
      }
    }
    while (cells.length < width) cells.push({ ch: "─", key: "__free" });
    return cells.slice(0, width);
  }
  const total = summary.used > 0 ? summary.used : 1;
  let placed = 0;
  for (const seg of summary.segments) {
    if (!seg.tokens) continue;
    const n = Math.max(1, Math.round((seg.tokens / total) * width));
    for (let i = 0; i < n && placed < width; i++) {
      cells.push({ ch: "█", key: seg.key });
      placed += 1;
    }
  }
  while (cells.length < width) cells.push({ ch: "░", key: "__buffer" });
  return cells.slice(0, width);
}

/** Composition bar cells for one segment, scaled to USED context (not the window limit). Non-zero segments always get min 1 cell so tiny categories stay visible. */
function segBarCells(tokens: number, used: number, width: number): { filled: number; empty: number } {
  if (used <= 0 || tokens <= 0 || width <= 0) return { filled: 0, empty: Math.max(0, width) };
  const filled = Math.max(1, Math.round((tokens / used) * width));
  return { filled: Math.min(filled, width), empty: Math.max(0, width - Math.min(filled, width)) };
}

// Static (non-expandable) row for categories with no drill-down data —
// mirrors TopicRow layout minus the toggle, so headers and bars align.
function SegRow(props: { color: string; header: string; bar: { text: string; fg: unknown }[]; sub?: string | null }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.text?.base as never}>{props.header}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.text?.muted as never}>{"    "}</text>
        <For each={props.bar}>
          {(run) => <text fg={run.fg as never}>{run.text}</text>}
        </For>
      </box>
      <Show when={props.sub} fallback={null}>
        <box flexDirection="row">
          <text fg={theme.text?.muted as never}>{"    "}</text>
          <text fg={theme.text?.muted as never}>{props.sub as string}</text>
        </box>
      </Show>
    </box>
  );
}

/** Mix a #rrggbb color toward white so hovered runs read lighter. */
function lighten(hex: string, amount = 0.35): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

function BarLine(props: {
  summary: Summary;
  width?: number;
  hot?: boolean;
  hideLabel?: boolean;
  onActivate?: () => void;
  onHover?: (inside: boolean) => void;
}) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const width = props.width ?? 20;
  // Reactive: the component body runs once, so eager reads of props here
  // would freeze the bar on the first summary while the header/details
  // (reactive JSX positions) keep updating. Memos re-run when the summary
  // (or hover state) changes, keeping the bar in sync.
  const label = createMemo(() => pctLabel(props.summary));
  const colors = createMemo(() => paletteFor(props.summary));
  // Merge adjacent same-color cells into single runs. The host puts gaps
  // between sibling elements, which is what split per-cell text apart.
  const runs = createMemo<{ text: string; fg: unknown }[]>(() => {
    const hot = props.hot;
    const list: { text: string; fg: unknown }[] = [];
    for (const cell of cellsFor(props.summary, width)) {
      const base =
        cell.key === "__free" || cell.key === "__buffer"
          ? FREE
          : (colors().get(cell.key) ?? FREE);
      const fg = hot ? lighten(base) : base;
      const last = list[list.length - 1];
      if (last && last.fg === fg) last.text += cell.ch;
      else list.push({ text: cell.ch, fg });
    }
    return list;
  });
  return (
    <box
      flexDirection="row"
      onMouseUp={() => {
        props.onActivate?.();
      }}
      onMouseOver={() => {
        props.onHover?.(true);
      }}
      onMouseOut={() => {
        props.onHover?.(false);
      }}
    >
      <For each={runs()}>
        {(run) => <text fg={run.fg as never}>{run.text}</text>}
      </For>
      <Show when={!props.hideLabel} fallback={null}>
        <text fg={levelColor(theme, label().level) as never}>{` ${label().text}`}</text>
      </Show>
    </box>
  );
}

/** One-line contributor hint per segment so the bar answers *what* was
 *  read into each bucket — not just the token count. Returns null when
 *  there is nothing useful to say. In particular the `skills` segment is
 *  usually dominated by the injected skills catalog (`available_skills`),
 *  not by real skill invocations: when that is the case the sub-text says
 *  so explicitly instead of letting the bar imply heavy skill use. */
function segmentSubtext(summary: Summary, segKey: string): string | null {
  try {
    const byCat = summary.topByCategory;
    const details = summary.topDetails ?? [];
    const names = (rows: ToolRow[] | undefined, max = 3): string | null => {
      if (!rows || rows.length === 0) return null;
      const top = rows.slice(0, max);
      return top.map((r) => `${r.name} ${formatNumber(r.tokens)}`).join(", ");
    };
    if (segKey === "skills") {
      const skills = summary.topSkills ?? [];
      if (skills.length > 0) {
        const top = skills.slice(0, 3);
        const skillTokens = skills.reduce((n, s) => n + (s.tokens || 0), 0);
        const seg = summary.segments.find((s) => s.key === "skills");
        const remainder = Math.max(0, (seg?.tokens ?? 0) - skillTokens);
        const invocations = top
          .map((s) => `${s.name} ${formatNumber(s.tokens)}`)
          .join(", ");
        // Remainder is the injected skills catalog + SKILL.md reads that
        // were not attributed to a named skill invocation.
        if (remainder > skillTokens && remainder > 1000) {
          return `real skill loads: ${invocations} · catalog/instructions ~${formatNumber(remainder)}`;
        }
        return `real skill loads: ${invocations}`;
      }
      // No named invocations at all — the whole segment is catalog text.
      const seg = summary.segments.find((s) => s.key === "skills");
      if (seg && seg.tokens > 0) {
        const reads = names(byCat?.skills);
        return reads
          ? `no skill invocations — catalog/SKILL.md reads: ${reads}`
          : `no skill invocations — injected skills catalog/instructions`;
      }
      return null;
    }
    if (segKey === "mcps") {
      const n = names(byCat?.mcps);
      return n ? `mcp tools: ${n}` : `mcp tool outputs`;
    }
    if (segKey === "rules") {
      const n = names(byCat?.rules);
      return n ? `rule/instruction files: ${n}` : `AGENTS.md/CLAUDE.md/instructions`;
    }
    if (segKey === "others") {
      const n = names(byCat?.others);
      return n ? `${n}` : null;
    }
    if (segKey === "history") {
      const c = summary.counts;
      if (c && (c.messages > 0 || c.steps > 0)) {
        return `${c.messages} messages, ${c.steps} steps`;
      }
      return `user + compacted history`;
    }
    if (segKey === "system") return `base prompt + injected instructions`;
    if (segKey === "assistant") return `model output text + tool-call args`;
    if (segKey === "reasoning") return `extended thinking blocks`;
    // Any other tool-sourced segment: heaviest individual loads in it.
    const inSeg = details.filter(
      (d) => (d.category ?? "") === segKey,
    );
    if (inSeg.length > 0) {
      return inSeg
        .slice(0, 2)
        .map((d) => `${shortLabel(d.label, 60)} ${formatNumber(d.tokens)}`)
        .join(", ");
    }
    return null;
  } catch {
    return null;
  }
}

/** One vertical detail row per used segment, each led by a swatch in its
 *  bar color plus a muted contributor sub-line. Shared by the sidebar
 *  expanded section and the full breakdown (footer dialog / session
 *  panel) so both stay identical. */
function SegmentDetails(props: { summary: Summary; hot?: boolean }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const colors = createMemo(() => paletteFor(props.summary));
  return (
    <For each={props.summary.segments.filter((seg) => seg.tokens > 0)}>
      {(seg) => {
        const sub = createMemo(() => segmentSubtext(props.summary, seg.key));
        return (
          <box flexDirection="column">
            <box flexDirection="row">
              <text fg={(colors().get(seg.key) ?? FREE) as never}>{"■ "}</text>
              <text
                fg={(props.hot ? theme.text?.base : theme.text?.muted) as never}
              >
                {`${seg.label} ${seg.pctOfLimit !== null && seg.pctOfLimit !== undefined ? seg.pctOfLimit.toFixed(1) + "% of window" : ""} (${formatNumber(seg.tokens)})`}
              </text>
            </box>
            <Show when={sub()} fallback={null}>
              {(line) => (
                <box flexDirection="row">
                  <text fg={theme.text?.muted as never}>{"  • "}</text>
                  <text fg={theme.text?.muted as never}>{line()}</text>
                </box>
              )}
            </Show>
          </box>
        );
      }}
    </For>
  );
}

/** Shorten overflow-prone detail labels for TUI columns: keep the
 *  tail of paths (the filename matters) and the head of commands.
 *  The dialog now opens at xlarge width, so the budget is generous —
 *  each detail still gets its own row (one list item per line). */
function shortLabel(label: string, max = 140): string {
  if (label.length <= max) return label;
  return label.includes("/") || label.includes("\\")
    ? `…${label.slice(-(max - 1))}`
    : `${label.slice(0, max - 1)}…`;
}

/** One clickable action in the detail footer bar. `run` must never throw
 *  outward — DetailBody wraps every invocation so a failing action can't
 *  take the breakdown view down with it. `key` is registered as a modal
 *  keymap binding (and shown in the bar as `[c Copy]`); `hint` renders the
 *  key text without binding it, for keys the host already owns. */
interface DetailAction {
  id: string;
  label: string;
  /** Modal-mode binding owned by this plugin. Omitted when the host
   *  already binds the key (e.g. `escape`) — only `hint` then. */
  key?: string;
  /** Key text rendered next to the label without binding it. */
  hint?: string;
  run: () => void | Promise<void>;
}

/** Plain-text rendering of a loaded summary for Copy / Post-to-session.
 *  Mirrors the server's `renderSummaryText` (analyze.ts), including the
 *  per-segment contributor sub-lines. */
function formatSummaryText(s: Summary): string {
  const lines: string[] = [];
  const method =
    s.context?.method === "provider"
      ? "provider-anchored"
      : s.context?.method === "estimate" || s.estimated
        ? "estimates"
        : "unattributed";
  const remaining =
    s.context?.remaining !== null && s.context?.remaining !== undefined
      ? `, ${formatNumber(s.context.remaining)} remaining`
      : "";
  const head =
    s.limit && s.pct !== null && s.pct !== undefined
      ? `${formatNumber(s.used)} / ${formatNumber(s.limit)} tokens (${s.pct.toFixed(1)}% of window, ${s.model})`
      : `${formatNumber(s.used)} tokens (model limit unknown — ${s.model})`;
  lines.push(`Context: ${head}${remaining} [${method}]${s.context?.stale ? " [stale: newer turn reported no usage]" : ""}`);
  lines.push("");
  for (const seg of s.segments) {
    if (!seg.tokens) continue;
    const w =
      seg.pctOfLimit !== null && seg.pctOfLimit !== undefined
        ? `${seg.pctOfLimit.toFixed(1)}% of window`
        : "window share unknown";
    const u =
      seg.pctOfUsed !== null && seg.pctOfUsed !== undefined
        ? `${seg.pctOfUsed.toFixed(1)}% of used`
        : "share of used unknown";
    lines.push(`- ${seg.label} ${w} (${u}) (${formatNumber(seg.tokens)})`);
    const sub = segmentSubtext(s, seg.key);
    if (sub) lines.push(`    ${sub}`);
  }
  if (s.topTools.length > 0) {
    lines.push("");
    lines.push(
      `Top tools, by returned output (estimates${s.classifierSource === "registry" ? ", registry-classified" : s.classifierSource === "heuristic" ? ", name-heuristic; registry unavailable" : ""} — not shares of used context):`,
    );
    for (const tool of s.topTools) {
      lines.push(
        `- ${tool.name}${tool.category ? ` [${tool.category}]` : ""}: ~${formatNumber(tool.tokens)} returned, ${tool.calls} calls${(tool.truncatedCalls ?? 0) > 0 ? `, ${tool.truncatedCalls} truncated` : ""}`,
      );
    }
  }
  if (s.toolTotals) {
    const parts = (Object.keys(s.toolTotals) as ToolCategory[])
      .filter((cat) => {
        const t = (s.toolTotals as Record<ToolCategory, { tokens: number; calls: number }>)[cat];
        return t.tokens > 0 || t.calls > 0;
      })
      .map((cat) => {
        const t = (s.toolTotals as Record<ToolCategory, { tokens: number; calls: number }>)[cat];
        return `${cat} ~${formatNumber(t.tokens)} returned/${t.calls} calls`;
      })
      .join(" · ");
    if (parts) {
      lines.push("");
      lines.push(`Tool output by source (returned, estimated): ${parts}`);
    }
  }
  if (s.topSkills.length > 0) {
    lines.push("");
    lines.push("Skills this session (estimated):");
    for (const skill of s.topSkills) {
      lines.push(`- ${skill.name}: ~${formatNumber(skill.tokens)} tokens, ${skill.count}x`);
    }
  }
  if ((s.topDetails ?? []).length > 0) {
    lines.push("");
    lines.push("Loaded details (heaviest individual loads, estimated returned output):");
    for (const d of s.topDetails ?? []) {
      lines.push(
        `- ${d.name}${d.category ? ` [${d.category}]` : ""} ${d.label}: ~${formatNumber(d.tokens)} tokens, ${d.calls} calls${(d.truncatedCalls ?? 0) > 0 ? `, ${d.truncatedCalls} truncated` : ""}`,
      );
    }
  }
  if (s.cumulative) {
    const c = s.cumulative;
    lines.push("");
    lines.push(
      `Session totals (cumulative across requests — NOT current window${c.scope ? `, ${c.scope}` : ""}): in ${formatNumber(c.input)}, out ${formatNumber(c.output)}, reasoning ${formatNumber(c.reasoning)}, cache read/write ${formatNumber(c.cacheRead)}/${formatNumber(c.cacheWrite)}`,
    );
  }
  {
    const c = s.counts;
    lines.push("");
    lines.push(
      `Transcript: ${formatNumber(c.messages)} messages (${formatNumber(c.userMessages ?? 0)} user, ${formatNumber(c.assistantMessages ?? 0)} assistant, ${formatNumber(c.systemMessages ?? 0)} system, ${formatNumber(c.syntheticMessages ?? 0)} synthetic, ${formatNumber(c.compactionCount ?? 0)} compaction, ${formatNumber(c.ignoredMessages ?? 0)} ignored)${(c.excludedByCompaction ?? 0) > 0 ? `, ${formatNumber(c.excludedByCompaction ?? 0)} fenced out by compaction` : ""}`,
    );
  }
  if (s.warn) {
    lines.push("");
    lines.push(s.warn.text);
  }
  return lines.join("\n");
}

/** Standard footer-bar actions for the full breakdown: Copy (OSC52 via the
 *  renderer), Investigate (Post to session), Refresh, Dashboard, Close.
 *  Each carries its modal-mode key so the dialog is fully keyboard-driven;
 *  `close` deliberately has no key (the host's own modal layer already binds
 *  `escape` — binding it here too would close it twice). Every action degrades
 *  to a toast instead of throwing. */
function buildDetailActions(
  ctx: ReturnType<typeof usePlugin>,
  opts: {
    data: () => Summary | null;
    retry: () => void;
    sessionID: () => string | undefined;
    rpc: ReturnType<typeof useRpc>;
    close: () => void;
  },
): DetailAction[] {
  const toast = (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
  ) => {
    try {
      ctx.ui.toast.show({ title: "Context segments", message, variant });
    } catch {
      // ignore
    }
  };
  return [
    {
      id: "copy",
      label: "Copy",
      key: "c",
      run: () => {
        const s = opts.data();
        if (!s) {
          toast("Nothing to copy yet.", "warning");
          return;
        }
        try {
          const renderer = (
            ctx as unknown as {
              renderer?: {
                copyToClipboardOSC52?: (text: string) => boolean;
              };
            }
          ).renderer;
          const ok = renderer?.copyToClipboardOSC52?.(formatSummaryText(s));
          toast(
            ok ? "Breakdown copied to clipboard." : "Copy not supported by this terminal.",
            ok ? "success" : "error",
          );
        } catch {
          toast("Copy failed in this terminal.", "error");
        }
      },
    },
    {
      id: "refresh",
      label: "Refresh",
      key: "r",
      run: () => {
        opts.retry();
      },
    },
    {
      id: "post",
      label: "Post to session",
      key: "i",
      run: async () => {
        const sid = opts.sessionID();
        if (!sid) {
          toast("Open a session first.", "warning");
          return;
        }
        const res = await opts.rpc.postSummary({ sessionID: sid });
        if (res && res.ok !== false) {
          toast("Breakdown posted to session for investigation.", "success");
        } else {
          toast("Could not post breakdown.", "error");
        }
      },
    },
    {
      id: "dashboard",
      label: "Dashboard",
      key: "d",
      run: async () => {
        const res = await opts.rpc.startWeb();
        if (res && res.url) {
          const url = res.url;
          ctx.ui.dialog.show(() => (
            <box flexDirection="column">
              <text>Skill dashboard</text>
              <text>{url}</text>
              <text>Loopback-only. Closing the tab stops the server.</text>
            </box>
          ));
          toast("Dashboard running.", "success");
        } else {
          toast("Could not start dashboard.", "error");
        }
      },
    },
    {
      id: "close",
      label: "Close",
      // Not bound here — the host's own modal layer already binds `escape`,
      // and a second binding would close the dialog twice. `hint` still
      // renders the key so the action bar tells the truth about it.
      hint: "esc",
      run: () => {
        opts.close();
      },
    },
  ];
}

/** Full breakdown body driven by already-loaded data (never fetches).
 *  Rendered by the session panel (after its fetch) and by the footer
 *  dialog (reusing the footer's data, so it can't get stuck loading).
 *  The body sits in a fixed-height `scrollbox` (OpenTUI's scrollable
 *  container) so long sessions no longer get their last lines clipped
 *  by the dialog viewport — arrow keys / PgUp / PgDn scroll when focused,
 *  mouse wheel scrolls directly. */
const DETAIL_SCROLL_HEIGHT = 36;

/** One drill-down topic row. Collapsed by default; opening one topic never
 *  closes the others so contributors stay comparable side by side. */
function TopicRow(props: {
  id: string;
  open: () => boolean;
  onToggle: (id: string) => void;
  header: string;
  hint?: string | null;
  bar?: { text: string; fg: unknown }[];
  children?: unknown;
}) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text
          fg={theme.text?.base as never}
          onMouseUp={() => props.onToggle(props.id)}
        >
          {`${props.open() ? "▾" : "▸"} ${props.header}`}
        </text>
      </box>
      <Show when={props.bar} fallback={null}>
        <box flexDirection="row">
          <text fg={theme.text?.muted as never}>{"    "}</text>
          <For each={props.bar ?? []}>
            {(run) => <text fg={run.fg as never}>{run.text}</text>}
          </For>
        </box>
      </Show>
      <Show when={!props.open() && props.hint} fallback={null}>
        <box flexDirection="row">
          <text fg={theme.text?.muted as never}>{"    "}</text>
          <text fg={theme.text?.muted as never}>{props.hint as string}</text>
        </box>
      </Show>
      <Show when={props.open()} fallback={null}>
        <box flexDirection="column" paddingLeft={4}>
          {props.children as never}
        </box>
      </Show>
    </box>
  );
}

/** One contributor row inside an expanded pane. Labels render in full —
 *  each gets its own row and wraps instead of truncating, so long
 *  paths/URLs/commands are never cropped. */
function ContributorRows(props: { rows: ContributorRow[]; used: number }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  return (
    <For each={props.rows}>
      {(d) => (
        <box flexDirection="column">
          <text fg={theme.text?.muted as never}>
            {`• ${d.name}${d.category ? ` [${d.category}]` : ""}: ~${formatNumber(d.tokens)} returned (${props.used > 0 ? ((d.tokens / props.used) * 100).toFixed(1) + "% of used" : "share n/a"}), ${d.calls} calls${(d.truncatedCalls ?? 0) > 0 ? `, ${d.truncatedCalls} truncated` : ""}${d.method === "estimated" ? ", estimated" : ""}${d.inContext === false ? ", NOT in model context" : ""}`}
          </text>
          <text fg={theme.text?.muted as never}>{`  ${d.label}`}</text>
        </box>
      )}
    </For>
  );
}

function useOpenTopics() {
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return { open, toggle } as const;
}

function DetailBody(props: { summary: Summary; onClose?: () => void; actions?: DetailAction[] }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const s = () => props.summary;
  const topics = useOpenTopics();
  const [showHelp, setShowHelp] = createSignal(false);
  const fireAction = (a: DetailAction) => {
    try {
      const r = a.run();
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      // actions must never break the breakdown view
    }
  };
  // Modal-mode keys for the open dialog. Calling `keymap.layer` from inside a
  // dialog component binds the layer to that Solid owner, so it disposes
  // itself on unmount — that is what scopes these keys to this dialog without
  // manual teardown. `mode: "modal"` is the host's own dialog-only input mode;
  // "global" would opt out of mode gating and steal these letters from the
  // composer. `escape` is deliberately NOT bound: the host's own modal layer
  // already owns it, so `close` carries a `hint` instead of a `key`.
  try {
    ctx.keymap.layer(() => ({
      mode: "modal",
      commands: [
        ...(props.actions ?? [])
          .filter((a) => a.key)
          .map((a) => ({
            id: `cseg.details.${a.id}`,
            title: a.label,
            bind: a.key,
            group: "Dialog",
            run: () => fireAction(a),
          })),
        {
          id: "cseg.details.help",
          title: "Toggle key legend",
          bind: "?",
          group: "Dialog",
          run: () => setShowHelp((v) => !v),
        },
      ],
    }));
  } catch {
    // Host without keymap.layer keeps the mouse-only action bar below.
  }
  return (
    <box flexDirection="column">
    <scrollbox height={DETAIL_SCROLL_HEIGHT}>
    <box flexDirection="column" paddingX={2} paddingY={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text?.base as never}>
          {`${s().context?.method === "provider" ? "" : s().estimated ? "[estimates] " : ""}Context ${s().pct !== null && s().pct !== undefined ? s().pct.toFixed(1) + "% of window" : "usage"} — ${s().model} (${formatNumber(s().used)}${s().limit ? " / " + formatNumber(s().limit) : ""} tokens${s().context?.remaining !== null && s().context?.remaining !== undefined ? ", " + formatNumber(s().context.remaining) + " left" : ""})${s().context?.stale ? " [stale]" : ""}`}
        </text>
        <Show when={props.onClose} fallback={null}>
          <text
            fg={theme.text?.muted as never}
            onMouseUp={() => props.onClose?.()}
          >
            {" [esc]"}
          </text>
        </Show>
      </box>
      <BarLine summary={s()} width={28} hideLabel />
      <For each={s().segments.filter((seg) => seg.tokens > 0)}>
        {(seg) => {
          const id = `seg:${seg.key}`;
          // For `seg.key === "others"` this IS the unsliced `othersContributors` (same array server-side) and is intentionally NOT sliced to a top-N — that slicing is what made ~64% of the `others` bucket look unattributable.
          const rows = () => (s().contributors?.[seg.key] ?? []);
          // Share of USED context (not the window limit) so the header and
          // the bar below describe the same partition. Never fabricate 0%.
          const pctOfUsed =
            seg.pctOfUsed !== null && seg.pctOfUsed !== undefined
              ? `${seg.pctOfUsed.toFixed(1)}% of used`
              : "share unknown";
          // Bar in the segment's own palette color (same mapping as the
          // footer/sidebar bar); the empty run reuses FREE.
          const color = paletteFor(s()).get(seg.key) ?? FREE;
          const cells = segBarCells(seg.tokens, s().used, 16);
          const runs = [
            { text: "█".repeat(cells.filled), fg: color },
            { text: "░".repeat(cells.empty), fg: FREE },
          ];
          const header = `${seg.label}  ${formatNumber(seg.tokens)} · ${pctOfUsed}`;
          return (
            <Show when={rows().length > 0} fallback={
              <SegRow
                color={color}
                header={header}
                bar={runs}
                sub={
                  seg.key === "unaccounted"
                    ? "Rounding + non-text residual inside the partition — not a consumer to optimize."
                    : seg.key === "history"
                      ? `${s().counts.messages} transcript messages, ${s().counts.steps} assistant steps.`
                      : seg.key === "assistant"
                        ? "Model output text + tool-call args (estimated); provider-anchored total when available."
                        : seg.key === "reasoning"
                          ? "Extended thinking blocks."
                          : seg.key === "system"
                            ? "Base prompt + injected instructions."
                            : "details unavailable"
                }
              />
            }>
              <TopicRow
                id={id}
                open={() => topics.open().has(id)}
                onToggle={(t) => topics.toggle(t)}
                header={header}
                hint={segmentSubtext(s(), seg.key)}
                bar={runs}
              >
                <ContributorRows rows={rows()} used={s().used} />
              </TopicRow>
            </Show>
          );
        }}
      </For>
      <Show when={s().topTools.length > 0}>
        <TopicRow
          id="tools"
          open={() => topics.open().has("tools")}
          onToggle={(t) => topics.toggle(t)}
          header="Tool output · estimated"
          hint={s().topTools.slice(0, 3).map((t) => `${t.name} ~${formatNumber(t.tokens)}`).join(" · ")}
        >
          <For each={s().toolIO ?? []}>
            {(tool) => (
              <text fg={theme.text?.muted as never}>
                {`${tool.name}${tool.category ? ` [${tool.category}]` : ""}: ~${formatNumber(tool.tokens)} returned, ${tool.calls} calls${(tool.truncatedCalls ?? 0) > 0 ? `, ${tool.truncatedCalls} truncated` : ""}`}
              </text>
            )}
          </For>
          <Show when={s().toolTotals} fallback={null}>
            {(totals) => (
              <text fg={theme.text?.muted as never}>
                {`By source (returned, estimated): ${(Object.keys(totals()) as ToolCategory[]).filter((cat) => totals()[cat].tokens > 0 || totals()[cat].calls > 0).map((cat) => `${cat} ~${formatNumber(totals()[cat].tokens)}/${totals()[cat].calls} calls`).join(" · ")}`}
              </text>
            )}
          </Show>
        </TopicRow>
      </Show>
      <Show when={s().topSkills.length > 0}>
        <TopicRow
          id="skills"
          open={() => topics.open().has("skills")}
          onToggle={(t) => topics.toggle(t)}
          header="Skills this session (estimated)"
          hint={s().topSkills.slice(0, 3).map((k) => `${k.name} ~${formatNumber(k.tokens)}`).join(" · ")}
        >
          <For each={s().topSkills}>
            {(skill) => (
              <text fg={theme.text?.muted as never}>
                {`${skill.name}: ~${formatNumber(skill.tokens)} tokens, ${skill.count}x`}
              </text>
            )}
          </For>
        </TopicRow>
      </Show>
      <Show when={s().cumulative} fallback={null}>
        {(c) => (
          <TopicRow
            id="session"
            open={() => topics.open().has("session")}
            onToggle={(t) => topics.toggle(t)}
            header="Session totals · cumulative"
            hint={`in ${formatNumber(c().input)}, out ${formatNumber(c().output)}, reasoning ${formatNumber(c().reasoning)}, cache r/w ${formatNumber(c().cacheRead)}/${formatNumber(c().cacheWrite)}`}
          >
            <text fg={theme.text?.muted as never}>
              {`Transcript: ${formatNumber(s().counts.messages)} messages (${formatNumber(s().counts.userMessages ?? 0)} user, ${formatNumber(s().counts.assistantMessages ?? 0)} assistant, ${formatNumber(s().counts.systemMessages ?? 0)} system, ${formatNumber(s().counts.syntheticMessages ?? 0)} synthetic, ${formatNumber(s().counts.compactionCount ?? 0)} compaction, ${formatNumber(s().counts.ignoredMessages ?? 0)} ignored)${(s().counts.excludedByCompaction ?? 0) > 0 ? `, ${formatNumber(s().counts.excludedByCompaction ?? 0)} fenced out by compaction` : ""}`}
            </text>
          </TopicRow>
        )}
      </Show>
      <Show when={s().warn}>
        {(w) => (
          <text fg={levelColor(theme, "critical") as never}>{w().text}</text>
        )}
      </Show>
    </box>
    </scrollbox>
    <Show when={(props.actions ?? []).length > 0} fallback={null}>
      <box flexDirection="row" paddingX={2} paddingY={1}>
        <Show when={showHelp()}>
          <text fg={theme.text?.muted as never}>
            {" c copy · i investigate · r refresh · d dashboard · ? keys · esc close"}
          </text>
          <text fg={theme.text?.muted as never}>
            {"shares are of used context · tool output estimated · totals cumulative"}
          </text>
        </Show>
        <For each={props.actions ?? []}>
          {(a) => (
            <text fg={theme.text?.muted as never} onMouseUp={() => fireAction(a)}>
              {` [${a.key ?? a.hint ? `${a.key ?? a.hint} ${a.label}` : a.label}]`}
            </text>
          )}
        </For>
      </box>
    </Show>
    </box>
  );
}

/** Shared detail-dialog opener: footer clicks, sidebar clicks, and the
 *  session panel all render the same `DetailBody` from the same loaded
 *  summary, at xlarge width so long detail lines get one row each.
 *  `getLoaded`/`retry` come from the caller's `useSummary` so the dialog
 *  reuses already-loaded data and can never get stuck on loading. */
function openDetailDialog(
  ctx: ReturnType<typeof usePlugin>,
  state: { dialogOpen: boolean },
  getLoaded: () => Summary | null,
  retry: () => void,
  sessionID: () => string | undefined,
  closeDetails: () => void,
  actions?: DetailAction[],
): void {
  if (state.dialogOpen) return;
  const id = sessionID();
  if (!id) return;
  const snapshot = getLoaded();
  if (!snapshot) {
    retry();
    return;
  }
  // Reuse the already-loaded data as the fallback so the dialog can
  // never get stuck on "Loading context…", but prefer the live signal
  // when it renders so an open dialog tracks fresh loads.
  state.dialogOpen = true;
  ctx.ui.dialog.show(
    () => {
      const live = getLoaded();
      return <DetailBody summary={live ?? snapshot} onClose={closeDetails} actions={actions} />;
    },
    () => {
      state.dialogOpen = false;
    },
  );
  // Wider dialog: detail labels (paths/URLs) are long and each gets its
  // own row — medium width wrapped them into what looked like multiple
  // items per list entry.
  try {
    ctx.ui.dialog.setSize("xlarge");
  } catch {
    // older hosts without setSize keep the default width
  }
}

function FooterHost(props: { sessionID?: string; showDetails?: boolean }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  // The slot input carries sessionID on current hosts; fall back to the
  // router's current route so the bar also resolves on older hosts.
  const sid = () => props.sessionID ?? currentSessionID(ctx);
  const sum = useSummary(sid);
  const rpc = useRpc();
  const [hovered, setHovered] = createSignal(false);
  // Guard against reopen races: a click outside the dialog both dismisses
  // it (host) and lands on this slot, which would instantly reopen it and
  // make outside-click dismiss feel broken. While open, footer clicks are
  // ignored so the host's dismiss wins.
  const state = { dialogOpen: false };
  const closeDetails = () => {
    state.dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  const openDetails = () => {
    openDetailDialog(ctx, state, sum.data, sum.retry, sid, closeDetails,
      buildDetailActions(ctx, {
        data: sum.data,
        retry: () => sum.retry(),
        sessionID: sid,
        rpc,
        close: closeDetails,
      }),
    );
  };
  return (
    <Show when={sid()} fallback={null}>
      <Show
        when={sum.data()}
        fallback={
          <Show
            when={sum.failed()}
            fallback={<text fg={theme.text?.muted as never}>ctx …</text>}
          >
            <text fg={theme.text?.muted as never} onMouseUp={() => sum.retry()}>
              ctx unavailable — click to retry
            </text>
          </Show>
        }
      >
        {(s) => (
          <box
            flexDirection="row"
            onMouseUp={openDetails}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
          >
            <BarLine
              summary={s()}
              hot={hovered()}
              onActivate={openDetails}
              onHover={setHovered}
            />
            <Show when={props.showDetails}>
              <text fg={(hovered() ? theme.text?.base : theme.text?.muted) as never}>
                {` ${s()
                  .segments.filter((seg) => seg.tokens > 0)
                  .map((seg) => seg.label)
                  .join("·")}`}
              </text>
            </Show>
          </box>
        )}
      </Show>
    </Show>
  );
}

function SidebarHost(props: { sessionID: string }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const sum = useSummary(() => props.sessionID);
  const rpc = useRpc();
  const [hovered, setHovered] = createSignal(false);
  // Same full breakdown as the footer click: sidebar and footer render
  // the same `DetailBody` from the same loaded summary.
  const state = { dialogOpen: false };
  const closeDetails = () => {
    state.dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  const openDetails = () => {
    openDetailDialog(
      ctx,
      state,
      sum.data,
      sum.retry,
      () => props.sessionID,
      closeDetails,
      buildDetailActions(ctx, {
        data: sum.data,
        retry: () => sum.retry(),
        sessionID: () => props.sessionID,
        rpc,
        close: closeDetails,
      }),
    );
  };
  return (
    <Show
      when={sum.data()}
      fallback={
        <Show
          when={sum.failed()}
          fallback={<text fg={theme.text?.muted as never}>ctx …</text>}
        >
          <text fg={theme.text?.muted as never} onMouseUp={() => sum.retry()}>
            ctx unavailable — click to retry
          </text>
        </Show>
      }
    >
      {(s) => (
        <box
          flexDirection="column"
          onMouseUp={openDetails}
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
        >
          <text fg={(hovered() ? theme.text?.base : theme.text?.muted) as never}>
            {/* Percentages always state their denominator — never a bare `%`.
                With a known limit we show `used / limit` like `DetailBody`;
                without one we say so in words rather than print a fake `0%`. */}
            {`Context ${s().pct !== null && s().pct !== undefined ? s().pct.toFixed(1) + "% of window" : "usage, window limit unknown"} ${s().limit ? `(${formatNumber(s().used)} / ${formatNumber(s().limit)})` : `(${formatNumber(s().used)} used, limit unknown)`} (click for details)`}
          </text>
          <BarLine summary={s()} width={16} hot={hovered()} />
          <SegmentDetails summary={s()} hot={hovered()} />
          <Show when={s().warn}>
            {(w) => (
              <text fg={levelColor(theme, w().level === "critical" ? "critical" : "warn") as never}>
                {w().text}
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  );
}

function DetailPanel(props: { sessionID: string; onClose?: () => void }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const sum = useSummary(() => props.sessionID);
  const rpc = useRpc();
  const close = () => {
    try {
      props.onClose?.();
    } catch {
      // ignore
    }
  };
  const actions = buildDetailActions(ctx, {
    data: sum.data,
    retry: () => sum.retry(),
    sessionID: () => props.sessionID,
    rpc,
    close,
  });
  return (
    <Show
      when={sum.data()}
      fallback={
        <Show
          when={sum.failed()}
          fallback={<text fg={theme.text?.muted as never}>Loading context…</text>}
        >
          <text fg={theme.text?.muted as never} onMouseUp={() => sum.retry()}>
            Couldn't load context — click to retry
          </text>
        </Show>
      }
    >
      {(s) => (
        <DetailBody summary={s()} onClose={props.onClose} actions={actions} />
      )}
    </Show>
  );
}

function currentSessionID(ctx: {
  ui: { router: { current: () => unknown } };
}): string | undefined {
  try {
    const route = ctx.ui.router.current() as unknown as {
      type?: unknown;
      sessionID?: unknown;
    };
    if (
      route &&
      route.type === "session" &&
      typeof route.sessionID === "string"
    ) {
      return route.sessionID;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export default Plugin.define({
  id: "context-segments-tui",
  async setup(context) {
    const flag = globalThis as unknown as Record<string, unknown>;
    if (flag[LOAD_FLAG]) return;
    flag[LOAD_FLAG] = true;

    const disposables: (() => void)[] = [];
    // One bad slot/keymap registration must not fail setup (which would
    // unload the whole TUI plugin) — degrade to fewer contributions instead.
    const safeSlot = (def: any) => {
      try {
        disposables.push(context.ui.slot(def));
      } catch {
        // ignore: that contribution stays unavailable
      }
    };
    const rpc = (context.client as unknown as Record<string, unknown>)
      .rpc as
      | ((def: unknown) => Record<string, (args?: unknown) => Promise<unknown>>)
      | undefined;
    const call = rpc ? rpc(csegDef) : null;

    safeSlot({
        append: "prompt.footer.status",
        render: (input) => (
          <FooterHost sessionID={input.sessionID} showDetails={input.showDetails} />
        ),
    });
    safeSlot({
        append: "sidebar.content",
        render: (input) => <SidebarHost sessionID={input.sessionID} />,
    });
    safeSlot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === "cseg.detail"} fallback={null}>
            <DetailPanel sessionID={panel.sessionID} onClose={panel.close} />
          </Show>
        ),
    });

    const openDetail = () => {
      const sid = currentSessionID(context);
      if (!sid) {
        context.ui.toast.show({
          title: "Context segments",
          message: "Open a session first.",
          variant: "info",
        });
        return;
      }
      if (!context.ui.panel.open("cseg.detail")) {
        context.ui.toast.show({
          title: "Context segments",
          message: "Panel unavailable in this view.",
          variant: "warning",
        });
      }
    };

    const openSkillsInner = async (input?: string) => {
      if (!call) {
        context.ui.toast.show({
          title: "Context segments",
          message: "Server plugin offline.",
          variant: "error",
        });
        return;
      }
      const sid = currentSessionID(context);
      const wantsWeb = /\bweb\b/i.test(input ?? "");
      const showTable = async () => {
        try {
          const res = (await call.getSkills({})) as {
            skills?: SkillRow[];
            totals?: { invocations?: number };
          } | null;
          const skills = res && Array.isArray(res.skills) ? res.skills : [];
          context.ui.dialog.show(() => (
            <box flexDirection="column">
              <text>Skill usage (all sessions)</text>
              <Show
                when={skills.length > 0}
                fallback={<text>No skill invocations recorded yet.</text>}
              >
                <For each={skills.slice(0, 20)}>
                  {(skill) => (
                    <text>{`${skill.name}: ${skill.count}x, ~${formatNumber(skill.estTokens)} tokens`}</text>
                  )}
                </For>
              </Show>
            </box>
          ));
        } catch {
          context.ui.toast.show({
            title: "Context segments",
            message: "Could not load skill stats.",
            variant: "error",
          });
        }
      };
      const showWeb = async () => {
        try {
          const res = (await call.startWeb({})) as {
            ok?: boolean;
            url?: string;
            error?: string;
          } | null;
          if (!res || !res.url) {
            throw new Error(res?.error ?? "could not start dashboard");
          }
          context.ui.dialog.show(() => (
            <box flexDirection="column">
              <text>Skill dashboard</text>
              <text>{res.url as string}</text>
              <text>Loopback-only. Closing the tab stops the server.</text>
            </box>
          ));
          context.ui.toast.show({
            title: "Context segments",
            message: "Dashboard running — closing the tab stops it.",
            variant: "success",
          });
          void sid;
        } catch (error) {
          context.ui.toast.show({
            title: "Context segments",
            message: error instanceof Error ? error.message : String(error),
            variant: "error",
          });
        }
      };
      if (wantsWeb) {
        await showWeb();
        return;
      }
      const choice = await context.ui.dialog.select({
        title: "Skill usage",
        placeholder: "Choose a view",
        options: [
          {
            title: "Show in terminal",
            value: "tui",
            description: "Table in a dialog",
          },
          {
            title: "Open web dashboard",
            value: "web",
            description: "CSS page, auto-closes",
          },
        ],
      });
      if (choice === "web") await showWeb();
      else if (choice === "tui") await showTable();
    };

    // Never-reject wrapper: `run` invokes this as `void openSkills(input)`,
    // so a rejection would surface as an unhandled error in the TUI.
    const openSkills = async (input?: string) => {
      try {
        await openSkillsInner(input);
      } catch (error) {
        try {
          context.ui.toast.show({
            title: "Context segments",
            message: error instanceof Error ? error.message : String(error),
            variant: "error",
          });
        } catch {
          // ignore
        }
      }
    };

    try {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "cseg.details",
            title: "Context segments: session breakdown",
            group: "Context",
            palette: true,
            slash: { name: "cseg" },
            run: () => openDetail(),
          },
          {
            id: "cseg.skills",
            title: "Context segments: skill usage",
            group: "Context",
            palette: true,
            slash: { name: "cseg-skills", arguments: true },
            run: (input) => void openSkills(input),
          },
        ],
        bindings: ["cseg.details", "cseg.skills"],
      }));
    } catch {
      // palette/slash commands stay unavailable; the slots above still work
    }

    return () => {
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
      // Allow re-registration after a plugin reload. Without this the bar
      // silently never comes back until the whole TUI restarts.
      try {
        flag[LOAD_FLAG] = false;
      } catch {
        // ignore
      }
    };
  },
});
