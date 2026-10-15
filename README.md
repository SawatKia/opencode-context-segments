# context-segments

A global [OpenCode](https://opencode.ai) plugin that replaces the text-only context percentage with a **100%-normalized, color-segmented progress bar**, plus per-session token analysis and persistent skill-usage stats.

No config edits needed — drop it in `plugins/context-segments/` and it auto-loads (server + TUI). Lightweight token counting, no vendor tokenizer downloads.

## What you get

- **Colorized context bar** — each LLM's `limit.context` is 100%.
  Segments: `system` · `skills` · `history` · `tools` · `assistant` · `reasoning` (theme-aware colors, never text-only). Warns at 70–90%, critical above 90%.
- **Compact mode** (sidebar hidden): bar lives in the prompt footer. The whole row is clickable — opens the breakdown dialog instantly (no second fetch). `[esc]` top-right or click-outside to dismiss.
- **Full mode** (sidebar visible): breakdown section appended to the sidebar. Native readout untouched. Horizontal bar on top, per-segment rows beneath (each led by a swatch in its bar color), expanded by default, header shows `{pct}%({used})`. Click anywhere to collapse/expand; hover lightens.
- **`/cseg`** — session breakdown panel (per-segment table, top tools, top skills, compaction warning).
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

Sidebar (expanded) — header, color-segmented bar, per-segment rows:

```text
Context 24.0%(252,099) (click to collapse)
███████───────── 24%
■ system 20.9% (219,435)
■ history 0.1% (1,541)
■ tools 2.9% (30,902)
■ assistant 0.0% (216)
■ reasoning 0.0% (5)
```

`/context` agent-readable text output (produced by the real `renderSummaryText`):

```text
Context: 252,099 / 1,050,000 tokens (24.0% of anthropic/claude-opus-4-6)

SYSTEM    █████░░░░░░░░░░░░░░░░░░░  20.9% (219,435)
HISTORY   ░░░░░░░░░░░░░░░░░░░░░░░░   0.1% (1,541)
TOOLS     █░░░░░░░░░░░░░░░░░░░░░░░   2.9% (30,902)
ASSISTANT ░░░░░░░░░░░░░░░░░░░░░░░░   0.0% (216)
REASONING ░░░░░░░░░░░░░░░░░░░░░░░░   0.0% (5)

Top tools:
- read: 18,020 tokens, 42 calls
- shell: 9,400 tokens, 18 calls
```

## How the numbers work (lightweight, no downloads)

1. Visible transcript text is bucketed per segment and rough-counted (`ceil(chars / 4)`). Base64 file attachments and tool file URIs are skipped — only human-readable text counts.
2. When the newest assistant message carries server telemetry (`input / output / reasoning / cache.read / cache.write`), prompt-side buckets are scaled to `input + cache` and assistant/reasoning to `output / reasoning` — the same idea as IgorWarzocha's `Opencode-Context-Analysis-Plugin`, without its `vendor/` tokenizer downloads.
3. Headline `%` = scaled usage ÷ model `limit.context`. Unknown limit shows absolute tokens with no fake percentage.

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

## Options (`opencode.jsonc` → `plugins: [{ package, options }]`)

Only needed to override defaults: `warnAt` (0.7), `criticalAt` (0.9), `skillTracking` (true), `webIdleMs` (5 min).

## Troubleshooting

- **Bar missing**: relaunch the TUI after the server picks up the plugin; check `opencode.log` for `loading plugin ... context-segments`.
- **Wrong %**: the bar follows the session model's `limit.context`; custom providers report their own limits.
- **Skills empty**: stats accumulate from activation events going forward.
- **Dashboard port busy**: `stopWeb` via `/cseg-skills` twice, or restart the service; the server is loopback-only with a single-use token URL.

## License

MIT — see [LICENSE](./LICENSE).
