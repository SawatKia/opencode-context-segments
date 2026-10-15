/**
 * context-segments — tui.ts (discovery shim).
 *
 * OpenCode's global plugin discovery documents `<config>/plugins/<name>/tui.ts`
 * as the TUI entrypoint, while the CLI building guide uses a `./tui`
 * (`.tsx`) export. This shim re-exports the real implementation in
 * `tui.tsx` so the bar loads under either convention. A globalThis guard
 * inside `tui.tsx` makes a double load a no-op.
 */
export { default } from "./tui.tsx";
