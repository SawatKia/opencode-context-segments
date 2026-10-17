# context-segments

A global [OpenCode](https://opencode.ai) plugin that replaces the text-only context percentage with a **100%-normalized, color-segmented progress bar**, plus per-session token analysis and persistent skill-usage stats.

No config edits needed — drop it in `plugins/context-segments/` and it auto-loads (server + TUI). Lightweight token counting, no vendor tokenizer downloads.

## What you get

- **Colorized context bar** — each LLM's `limit.context` is 100%.
  Segments: `system` · `skills` · `catalog` · `history` · `mcps` · `rules` · `others` · `assistant` · `reasoning` · `unaccounted` (theme-aware colors, never text-only). Warns at 70–90%, critical above 90%. Every percentage names its denominator.
- **Compact mode** (sidebar hidden): bar lives in the prompt footer. The whole row is clickable — opens the breakdown dialog instantly (no second fetch). `[esc]` top-right or click-outside to dismiss.
- **Full mode** (sidebar visible): breakdown section appended to the sidebar. Native readout untouched. Horizontal bar on top, per-segment rows beneath (each led by a swatch in its bar color), expanded by default, header shows `{pct}%({used})`. Click anywhere to collapse/expand; hover lightens.
- **Breakdown dialog** (`DetailBody`, shared by footer/sidebar/session panel): compact header with a single `% of window` plus `[estimates]`/`[stale]` tags; per-segment rows with colored proportional bars scaled to USED, headers read `Label tokens · X% of used`; a row is an expander (`TopicRow`) only when contributor rows exist, else a static `SegRow` (`details unavailable`, plus per-key fallback sublines for `unaccounted`/`history`/`assistant`/`reasoning`/`system`); single merged `Tool output · estimated` topic rendering the full unsliced `toolIO` plus the by-source line; `Session totals · cumulative` topic; keys `c` copy · `i` post-to-session · `r` refresh · `d` dashboard · `?` legend via dialog-scoped `mode: "modal"` keymap (`bind`, `esc` left to the host). The `?` legend's second line reads `shares are of used context · tool output estimated · totals cumulative`.
- **`/cseg`** — session breakdown panel (per-segment table, top tools, top skills, heaviest individual loads, compaction warning).
- **`/cseg-skills`** — skill-usage stats in the terminal, or `/cseg-skills web` for the loopback CSS dashboard (auto-closes when the tab closes).
- **`/context`** — post the breakdown into the session (agent-readable).
- **`/context-skills`** — post skill stats into the session.
- Agent tools: `context_usage`, `skill_stats`.

## Install

**Option A — clone into your plugins dir (global, auto-discovered):**

```sh
git clone https://github.com/SawatKia/opencode-context-segments.git \
  ~/.config/opencode/plugins/context-segments
```

Then relaunch the TUI. Check `opencode.log` for `loading plugin ... context-segments` if the bar doesn't appear.

**Option B — reference as a package** in `opencode.jsonc`:

```jsonc
{
  "plugins": [{ "package": "opencode-context-segments", "options": {} }]
}
```

## Preview

`/context` agent-readable text output (produced by the real `renderSummaryText` — `providerSession` fixture, `limit: 200,000`):

```text
Context: 10,100 / 200,000 tokens (5.1% of window, test-model), 189,900 remaining [provider-anchored]

HISTORY   ░░░░░░░░░░░░░░░░░░░░░░░░   0.8% (1,559) — 0.8% of window (15.4% of used)
OTHERS    █░░░░░░░░░░░░░░░░░░░░░░░   3.9% (7,793) — 3.9% of window (77.2% of used)
ASSISTANT ░░░░░░░░░░░░░░░░░░░░░░░░   0.4% (748) — 0.4% of window (7.4% of used)

Top tools, by RETURNED output, estimates (name-heuristic; registry unavailable — not shares of used context):
- read [others]: ~500 tokens returned, 1 calls

Tool output by source (returned, estimated): others ~500 returned/1 calls

Loaded details (heaviest individual loads, estimated returned output):
- read [others] C:/repo/a.ts: ~500 tokens, 1 calls

Transcript: 2 messages (1 user, 1 assistant, 0 system, 0 synthetic, 0 compaction, 0 ignored)
```

The text renderer states both denominators per row (`% of window` + `% of used`). The TUI dialog instead shows one `% of used` per row with a USED-scaled bar (see above).

## How the numbers work (lightweight, no downloads)

Four separate accounts. Mixing any two of them is what makes a context dashboard lie, so each is reported in its own place and never summed against another.

**A. The headline `used`.** It is the prompt actually sent with the newest request — that request's `tokens.input + tokens.cache.read + tokens.cache.write`, and nothing else. `cache.read` substitutes for part of `input` (it is the reused prefix), so the three are added once. The same envelope's `output`/`reasoning` are deliberately **not** added: they were produced *after* that request was sent, so they were not in its prompt and adding them would double-count the tail. Per-message `tokens` is per-request; the newest one describes the largest prompt in the transcript, which is exactly what the next request has to fit.

**B. The composition.** The bar is a mutually exclusive partition of `used` into ten segments:

| Segment | What lands there |
| --- | --- |
| `system` | base prompt text |
| `skills` | skills catalog, `skill`-tool loads, `SKILL.md` reads, skill activations |
| `catalog` | injected Code Mode / MCP **tool catalogs** — a catalog of available tools, not MCP output |
| `history` | user + synthetic messages, compaction `summary` + `recent` |
| `mcps` | tool output served by an MCP server |
| `rules` | `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` loads, `instruction`/`rule` messages (a lower bound — ambient rules in the system prompt stay in `system`) |
| `others` | built-in tools (`read`, `bash`, …), custom tools, unclassifiable |
| `assistant` | assistant text plus each tool call's name + input |
| `reasoning` | reasoning parts |
| `unaccounted` | the honest residual *inside* the partition — rounding plus non-text parts. Not a consumer to optimize. |

Bucket counts come from `ceil(chars / 4)` over transcript text — no vendor tokenizer downloads — then every bucket is scaled by a single factor (measured prompt total ÷ estimated prompt total) so the partition lands on the provider-measured number. Whatever is left over is reported as `unaccounted` rather than smeared across the largest bucket.

**C. Session totals.** `session.tokens*` columns are cumulative spend across every request in the session, not window occupancy. They are reported separately, tagged `scope: "session-cumulative"`, and never mixed into `used`.

**D. Tool I/O.** Tool-returned content is counted on its own. Rows are transcript-text estimates of **returned output**; they are deliberately **not** scaled to the context total and are never summed against `used`. Tool output counts as context only because the same bytes sit in the transcript that was sent — the UI says so rather than implying a tool "caused" growth.

### Method, staleness, the compaction fence

- `method` is `provider` (buckets scaled to reported usage), `estimate` (chars/4 only), or `unknown` (a prompt was measured but nothing could be attributed to it — the total is reported and the whole thing shows as `unaccounted`).
- `stale: true` means a newer assistant turn exists that reported no usage. The number is real but behind the live session.
- Only transcript entries at or after the **last `compaction`** count toward the composition. Everything earlier was replaced by that compaction's `summary` + `recent`; counting it would double-count content no longer in the request. The size of that fence is reported as `counts.excludedByCompaction`.
- Every percentage names its denominator: `pctOfLimit` renders as `% of window`, `pctOfUsed` as `% of used`. A `null` renders as "unknown" — never as `0%`.
- Legacy top-level `limit` / `pct` / `used` / `estimated` stay populated and mirror `context.*` so existing consumers keep working.

## Skill tracking

Precise, not heuristic: `session.skill.activated` events plus a one-time transcript backfill per session, persisted in plugin storage (`cseg:skills:global:v1`). `skill` tool calls additionally appear under top tools.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Server entrypoint: RPC, tools, commands, tracking, dashboard |
| `tui.tsx` | TUI implementation (slots, panel, dialogs, keymap) |
| `tui.ts` | Discovery shim re-exporting `tui.tsx` |
| `analyze.ts` | Pure segment math + text renderers (no imports) |
| `rpc-def.ts` | RPC surface (id + method names; `tui.tsx` keeps a copy) |
| `web.ts` | Loopback dashboard server (`node:http` only) |
| `test/` | `analyze.test.ts` · `accounting.test.ts` · `render-leak.test.ts` + `fixtures.ts` helper (run via `npm test`, i.e. `node --test "test/*.test.ts"`) |

## Tests

`npm test` runs the three suites (`node --test "test/*.test.ts"` verbatim; `fixtures.ts` is a helper, not a suite). Regression coverage: exact 424337 six-bucket partition (198499+55196+18573+113741+26768+11560), provider-independence (telemetry moves `used`, not shares), NaN/negative clamping, rounding-loss proof (tokens authoritative, percentages lossy), and the `render-leak` structural suite (no uncalled-function interpolation, denominators on every row, removed dialog prose stays gone).

## Options (`opencode.jsonc` → `plugins: [{ package, options }]`)

Only needed to override defaults: `warnAt` (0.7), `criticalAt` (0.9), `skillTracking` (true), `webIdleMs` (5 min).

## Troubleshooting

- **Bar missing**: relaunch the TUI after the server picks up the plugin; check `opencode.log` for `loading plugin ... context-segments`.
- **Wrong %**: the bar follows the session model's `limit.context`; custom providers report their own limits.
- **Skills empty**: stats accumulate from activation events going forward.
- **Dashboard port busy**: `stopWeb` via `/cseg-skills` twice, or restart the service; the server is loopback-only with a single-use token URL.

## License

MIT — see [LICENSE](./LICENSE).
