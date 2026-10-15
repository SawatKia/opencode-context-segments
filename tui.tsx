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
  methods: { getSummary: {}, getSkills: {}, startWeb: {}, stopWeb: {} },
  events: {},
} as const;

const LOAD_FLAG = "__cseg_tui_setup_done__";

interface SegmentDatum {
  key: string;
  label: string;
  color: string;
  tokens: number;
  pctOfLimit: number | null;
  pctOfUsed: number;
}

interface Summary {
  ok?: boolean;
  error?: string;
  model: string;
  limit: number | null;
  used: number;
  pct: number | null;
  segments: SegmentDatum[];
  topTools: { name: string; tokens: number; calls: number }[];
  topSkills: { id: string; name: string; tokens: number; count: number }[];
  counts: { messages: number; steps: number };
  warn: { level: string; text: string } | null;
  estimated: boolean;
  cumulative: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
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
  return { text: `${summary.pct.toFixed(0)}%`, level };
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
      if (got === sid) load(sid);
    };
    const offs = [
      ctx.data.on("session.step.ended", (e) => bump(e.data.sessionID)),
      ctx.data.on("session.skill.activated", (e) => bump(e.data.sessionID)),
    ];
    onCleanup(() => {
      for (const off of offs) off();
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
      <text fg={levelColor(theme, label().level) as never}>{` ${label().text}`}</text>
    </box>
  );
}

/** One vertical detail row per used segment, each led by a swatch in its
 *  bar color. Shared by the sidebar expanded section and the full
 *  breakdown (footer dialog / session panel) so both stay identical. */
function SegmentDetails(props: { summary: Summary; hot?: boolean }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const colors = createMemo(() => paletteFor(props.summary));
  return (
    <For each={props.summary.segments.filter((seg) => seg.tokens > 0)}>
      {(seg) => (
        <box flexDirection="row">
          <text fg={(colors().get(seg.key) ?? FREE) as never}>{"■ "}</text>
          <text
            fg={(props.hot ? theme.text?.base : theme.text?.muted) as never}
          >
            {`${seg.label} ${seg.pctOfLimit !== null && seg.pctOfLimit !== undefined ? seg.pctOfLimit.toFixed(1) + "%" : ""} (${formatNumber(seg.tokens)})`}
          </text>
        </box>
      )}
    </For>
  );
}

/** Full breakdown body driven by already-loaded data (never fetches).
 *  Rendered by the session panel (after its fetch) and by the footer
 *  dialog (reusing the footer's data, so it can't get stuck loading). */
function DetailBody(props: { summary: Summary; onClose?: () => void }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  const s = () => props.summary;
  return (
    <box flexDirection="column" paddingX={2} paddingY={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text?.base as never}>
          {`Context ${s().pct !== null && s().pct !== undefined ? s().pct.toFixed(1) + "% of limit" : "usage"} — ${s().model} (${formatNumber(s().used)}${s().limit ? " / " + formatNumber(s().limit) : ""} tokens${s().estimated ? ", estimates" : ""})`}
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
      <BarLine summary={s()} width={28} />
      <SegmentDetails summary={s()} />
      <Show when={s().topTools.length > 0}>
        <text fg={theme.text?.base as never}>Top tools</text>
        <For each={s().topTools}>
          {(tool) => (
            <text fg={theme.text?.muted as never}>
              {`${tool.name}: ${formatNumber(tool.tokens)} tokens, ${tool.calls} calls`}
            </text>
          )}
        </For>
      </Show>
      <Show when={s().topSkills.length > 0}>
        <text fg={theme.text?.base as never}>Skills this session</text>
        <For each={s().topSkills}>
          {(skill) => (
            <text fg={theme.text?.muted as never}>
              {`${skill.name}: ${formatNumber(skill.tokens)} tokens, ${skill.count}x`}
            </text>
          )}
        </For>
      </Show>
      <Show when={s().cumulative}>
        {(c) => (
          <text fg={theme.text?.muted as never}>
            {`Session totals — in ${formatNumber(c().input)}, out ${formatNumber(c().output)}, reasoning ${formatNumber(c().reasoning)}, cache r/w ${formatNumber(c().cacheRead)}/${formatNumber(c().cacheWrite)}`}
          </text>
        )}
      </Show>
      <Show when={s().warn}>
        {(w) => (
          <text fg={levelColor(theme, "critical") as never}>{w().text}</text>
        )}
      </Show>
    </box>
  );
}

function FooterHost(props: { sessionID?: string; showDetails?: boolean }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);
  // The slot input carries sessionID on current hosts; fall back to the
  // router's current route so the bar also resolves on older hosts.
  const sid = () => props.sessionID ?? currentSessionID(ctx);
  const sum = useSummary(sid);
  const [hovered, setHovered] = createSignal(false);
  // Guard against reopen races: a click outside the dialog both dismisses
  // it (host) and lands on this slot, which would instantly reopen it and
  // make outside-click dismiss feel broken. While open, footer clicks are
  // ignored so the host's dismiss wins.
  let dialogOpen = false;
  const closeDetails = () => {
    dialogOpen = false;
    ctx.ui.dialog.clear();
  };
  const openDetails = () => {
    if (dialogOpen) return;
    const id = sid();
    if (!id) return;
    const loaded = sum.data();
    if (!loaded) {
      sum.retry();
      return;
    }
    // Reuse the footer's already-loaded data as the fallback so the
    // dialog can never get stuck on "Loading context…", but prefer the
    // live signal when it renders so an open dialog tracks fresh loads.
    const snapshot = loaded;
    dialogOpen = true;
    ctx.ui.dialog.show(
      () => {
        const live = sum.data();
        return <DetailBody summary={live ?? snapshot} onClose={closeDetails} />;
      },
      () => {
        dialogOpen = false;
      },
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
  const [expanded, setExpanded] = createSignal(true);
  const [hovered, setHovered] = createSignal(false);
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
          onMouseUp={() => setExpanded((v) => !v)}
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
        >
          <text fg={(hovered() ? theme.text?.base : theme.text?.muted) as never}>
            {`Context ${s().pct !== null && s().pct !== undefined ? s().pct.toFixed(1) + "%" : "?%"}(${formatNumber(s().used)}) (click to ${expanded() ? "collapse" : "expand"})`}
          </text>
          <BarLine summary={s()} width={16} hot={hovered()} />
          <Show when={expanded()}>
            <SegmentDetails summary={s()} hot={hovered()} />
          </Show>
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
        <DetailBody summary={s()} onClose={props.onClose} />
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
    const rpc = (context.client as unknown as Record<string, unknown>)
      .rpc as
      | ((def: unknown) => Record<string, (args?: unknown) => Promise<unknown>>)
      | undefined;
    const call = rpc ? rpc(csegDef) : null;

    disposables.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => (
          <FooterHost sessionID={input.sessionID} showDetails={input.showDetails} />
        ),
      }),
    );
    disposables.push(
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => <SidebarHost sessionID={input.sessionID} />,
      }),
    );
    disposables.push(
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === "cseg.detail"} fallback={null}>
            <DetailPanel sessionID={panel.sessionID} onClose={panel.close} />
          </Show>
        ),
      }),
    );

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

    const openSkills = async (input?: string) => {
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

    return () => {
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
    };
  },
});
