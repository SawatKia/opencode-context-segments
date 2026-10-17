/**
 * context-segments — analyze.ts
 *
 * Pure, dependency-free context math. Shared by the server entrypoint
 * (`index.ts`). Operates on plain JSON message shapes (defensive `any`
 * access) so it stays robust across minor OpenCode schema drift.
 *
 * Accounting contract (verified against live `opencode.db` records — see
 * the plan's Phase 1 ground-truth table):
 *
 *  A. CONTEXT WINDOW USAGE — `context.used` is the prompt actually sent
 *     with the latest request, i.e. the newest assistant message's
 *     `tokens.input + tokens.cache.read + tokens.cache.write`. That sum
 *     grows monotonically across a session, so it is the real context
 *     size. `cache.read` SUBSTITUTES for `input` (it is the reused
 *     prefix); it is never added on top of it.
 *     `output`/`reasoning` are NOT part of that request's context — they
 *     were produced after it was sent — so they never enter `used`.
 *  B. CONTEXT COMPOSITION — a mutually exclusive partition of
 *     `context.used` into system / skills / catalog / history / mcps /
 *     rules / others / assistant / reasoning / unaccounted. Bucket counts
 *     come from `ceil(chars / 4)` over transcript text and are scaled by a
 *     single factor to land on the provider-measured total. The residual
 *     is surfaced as `unaccounted` rather than being smeared across the
 *     largest bucket.
 *  C. SESSION TOTALS — `session.tokens*` is CUMULATIVE across every
 *     request in the session and is reported separately, never mixed into
 *     the context total.
 *  D. TOOL I/O — tool-returned content is reported on its own. It counts
 *     as context only because the same bytes sit in the transcript; the
 *     UI says so explicitly rather than implying a tool "caused" growth.
 *
 * Method (lightweight, no vendor tokenizers):
 *  1. Fence off everything before the last compaction — compaction
 *     replaces that history, so counting it double-counts.
 *  2. Bucket visible transcript text; rough-count with ceil(chars / 4).
 *  3. Scale every bucket by (measured prompt total / estimated prompt
 *     total) when provider telemetry is available.
 *  4. Headline pct = context.used / model limit.
 *
 * Known limits: `chars / 4` is not the provider tokenizer, so buckets are
 * estimates anchored to a provider-measured total; reasoning may be
 * redacted from cached prefixes; MCP attribution cannot see Code
 * Mode-wrapped calls (they arrive through `execute`); pre-compaction
 * content is excluded rather than recovered.
 */

export interface SegmentMeta {
  key: string;
  label: string;
  /** Default hex color, tuned for dark themes (vesper). */
  color: string;
}

/**
 * The context-composition partition. Order is display order and is stable:
 * `catalog` sits next to `skills` because both are injected prompt
 * instructions rather than conversation, and `unaccounted` is last so the
 * residual is read as a footnote rather than a primary consumer.
 *
 * `catalog` exists because OpenCode injects the Code Mode tool catalog as a
 * `system` message tagged "Instructions updated: core/codemode,
 * core/mcp-guidance". Folding that into `mcps` made the bar claim MCP tool
 * output that never existed — `toolTotals.mcps` was 0 while the segment
 * showed tens of thousands of tokens.
 */
export const SEGMENT_META: SegmentMeta[] = [
  { key: "system", label: "system", color: "#8b8fa3" },
  { key: "skills", label: "skills", color: "#a78bfa" },
  { key: "catalog", label: "catalog", color: "#c4b5fd" },
  { key: "history", label: "history", color: "#60a5fa" },
  { key: "mcps", label: "mcps", color: "#fbbf24" },
  { key: "rules", label: "rules", color: "#2dd4bf" },
  { key: "others", label: "others", color: "#fb7185" },
  { key: "assistant", label: "assistant", color: "#34d399" },
  { key: "reasoning", label: "reasoning", color: "#f472b6" },
  { key: "unaccounted", label: "unaccounted", color: "#6b7280" },
];

/**
 * Sub-categories of the old single `tools` bucket. Every tool output lands
 * in exactly one of these; their sum equals the old `tools` total.
 *
 * - `skills`: the native `skill` tool (skill-content loads) and reads of
 *   `SKILL.md` files. Skill *activations* (`type: "skill"` messages) also
 *   live in the top-level `skills` segment.
 * - `mcps`: tools served by an MCP server (exact registry match first,
 *   `<server>_<tool>` prefix heuristic as fallback).
 * - `rules`: tool calls that load rule/instruction files (`AGENTS.md`,
 *   `CLAUDE.md`, `.cursor/rules/`, …) plus `instruction`/`rule` session
 *   messages. Ambient rules baked into the system prompt cannot be split
 *   from the transcript alone, so this is a lower bound — the rest stays
 *   in `system`.
 * - `others`: built-in tools (`read`, `edit`, `bash`, …), custom tools,
 *   `shell` messages, and anything unclassifiable.
 */
export type ToolCategory = "skills" | "mcps" | "rules" | "others";

export const TOOL_CATEGORIES: ToolCategory[] = [
  "skills",
  "mcps",
  "rules",
  "others",
];

/** Registry-derived ground truth for exact classification. */
export interface ToolClassifier {
  /** MCP server names from `ctx.mcp.list()` (e.g. `["context7"]`). */
  mcpServers?: unknown;
  /** Exact MCP tool ids from `ctx.tool.list()` when available. */
  mcpTools?: unknown;
}

/** Built-in OpenCode tools — never MCPs, never skills. */
const BUILTIN_TOOLS = new Set([
  "bash",
  "shell",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "lsp",
  "apply_patch",
  "skill",
  "webfetch",
  "websearch",
  "question",
]);

const MCP_ID_RE = /^mcp[_-]{1,2}.+/i;
const MCP_WRAPPED_RE = /^mcp__.+__.+$/i;
const RULE_FILE_RE =
  /(^|[/\\])(agents|claude|gemini)(\.md)?\b|[/\\]\.cursor[/\\]rules[/\\]|[/\\]\.opencode[/\\]|(^|[/\\])instructions?[/\\]|\.cursorrules\b/i;
const SKILL_FILE_RE = /skill\.md\b/i;

const SKILLS_CATALOG_RE = /available skills have changed|<available_skills>/i;
const TOOL_CATALOG_RE = /# Code Mode|tool catalog has changed/i;

/**
 * Where a `system` context entry really belongs. OpenCode injects
 * instruction blocks as `type: "system"` messages tagged
 * `description: "Instructions updated: …"`. Leaving them all in `system`
 * hides what's actually eating context.
 *
 * The Code Mode / MCP guidance block is a TOOL CATALOG — a description of
 * tools sent to the model — not the output of an MCP call, so it routes to
 * `catalog`. Routing it to `mcps` (as this did) reported MCP output for
 * sessions where no MCP tool ever ran.
 */
function systemBucket(
  msg: Record<string, unknown>,
): "system" | "skills" | "catalog" | "rules" {
  const desc = typeof msg.description === "string" ? msg.description : "";
  const text = typeof msg.text === "string" ? msg.text.slice(0, 2000) : "";
  if (/skill-guidance/i.test(desc) || SKILLS_CATALOG_RE.test(text))
    return "skills";
  if (
    /mcp-guidance/i.test(desc) ||
    /codemode/i.test(desc) ||
    TOOL_CATALOG_RE.test(text)
  )
    return "catalog";
  if (/agents|claude\.md|gemini|instructions?|rules|\.cursorrules/i.test(desc))
    return "rules";
  return "system";
}

function asStringList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (value instanceof Set) {
    return [...value].filter((v): v is string => typeof v === "string");
  }
  return [];
}

/** Normalize for prefix comparison: dots/dashes become `_`, lowercase. */
function normId(value: string): string {
  return value.trim().toLowerCase().replace(/[.-]/g, "_");
}

/** Best-effort file-path text from a tool part's input/args fields. */
function argsText(part: Record<string, unknown>): string {
  const candidates = [
    part.input,
    part.args,
    (part.state as Record<string, unknown> | undefined)?.input,
    (part.state as Record<string, unknown> | undefined)?.args,
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (typeof c === "string") {
      if (c.length <= 2000) out.push(c);
    } else if (c && typeof c === "object") {
      try {
        out.push(JSON.stringify(c).slice(0, 2000));
      } catch {
        // ignore unstringifiable args
      }
    }
  }
  return out.join("\n");
}

/** Parsed args/input object of a tool part, when available. */
function partArgs(part: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    part.input,
    part.args,
    (part.state as Record<string, unknown> | undefined)?.input,
    (part.state as Record<string, unknown> | undefined)?.args,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      return c as Record<string, unknown>;
    }
  }
  return {};
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Short human label for one tool call — file path, command, URL, query,
 * or skill name — so the breakdown can show *what* was loaded, not just
 * which tool ran. Returns "" when nothing useful is present.
 */
export function toolLabel(name: string, part?: Record<string, unknown>): string {
  if (!part) return "";
  const args = partArgs(part);
  if (name.toLowerCase() === "skill") {
    return firstString(args.skill, args.name, args.id);
  }
  const file = firstString(
    args.filePath,
    args.path,
    args.file,
    args.filename,
    args.uri,
  );
  if (file) {
    const skill = skillNameFromPath(file);
    if (skill) return `skill:${skill}`;
    return file.length > 120 ? `…${file.slice(-119)}` : file;
  }
  const hint = firstString(
    args.command,
    args.cmd,
    args.url,
    args.query,
    args.pattern,
    args.text,
  );
  if (hint) {
    const oneLine = hint.replace(/\s+/g, " ");
    return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine;
  }
  return "";
}

/** Owning skill name of a `.../<name>/SKILL.md` path, or "". */
export function skillNameFromPath(file: string): string {
  const m = /([^/\\]+)[/\\]SKILL\.md$/i.exec(file);
  return m ? m[1] : "";
}

export function classifyTool(
  name: unknown,
  classifier?: ToolClassifier,
  part?: Record<string, unknown>,
): ToolCategory {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return "others";
  const lower = raw.toLowerCase();
  if (lower === "skill") return "skills";

  const servers = asStringList(classifier?.mcpServers)
    .map((s) => normId(s))
    .filter(Boolean);
  const tools = new Set(
    asStringList(classifier?.mcpTools).map((t) => normId(t)),
  );
  const nid = normId(raw);

  // 1. Exact registry matches win over every heuristic.
  if (tools.has(nid)) return "mcps";
  for (const server of servers) {
    if (
      nid === server ||
      nid.startsWith(`${server}_`) ||
      nid.startsWith(`mcp__${server}__`)
    ) {
      return "mcps";
    }
  }

  // 2. File-path hints beat name guessing (rule/skill file reads).
  if (part) {
    const hint = argsText(part);
    if (hint) {
      if (SKILL_FILE_RE.test(hint)) return "skills";
      if (RULE_FILE_RE.test(hint)) return "rules";
    }
  }

  // 3. Name heuristics — only trusted when the registry gave us nothing
  //    to match against (no servers and no tool ids). With a registry,
  //    an unmatched name is `others`, not a guessed MCP.
  const hasRegistry = servers.length > 0 || tools.size > 0;
  if (!hasRegistry) {
    if (MCP_WRAPPED_RE.test(raw) || MCP_ID_RE.test(raw)) return "mcps";
    const head = nid.split("_")[0].split("-")[0];
    if ((raw.includes("_") || raw.includes("-")) && !BUILTIN_TOOLS.has(head)) {
      return "mcps";
    }
  }
  return "others";
}

export interface SegmentDatum {
  key: string;
  label: string;
  color: string;
  tokens: number;
  /** Share of the attributable used-context total; null when used is 0. */
  pctOfUsed: number | null;
  /** Share of the model context window; null when the limit is unknown. */
  pctOfLimit: number | null;
}

/**
 * Tool I/O, tracked separately from context composition. `tokens` is the
 * tool's RETURNED output, which is not the same thing as "context this tool
 * caused": it counts as context only because the same bytes sit in the
 * transcript that was sent to the model.
 */
export interface ToolDatum {
  name: string;
  tokens: number;
  calls: number;
  category: ToolCategory;
  /** Calls whose output OpenCode truncated before the model saw it. */
  truncatedCalls: number;
}

export interface SkillDatum {
  id: string;
  name: string;
  tokens: number;
  count: number;
}

/** One loaded item: which tool call pulled what into context. */
export interface ToolDetailDatum {
  name: string;
  /** File path, command, URL, query, or `skill:<name>`. */
  label: string;
  tokens: number;
  calls: number;
  category: ToolCategory;
  /** Calls in this group whose output was truncated. */
  truncatedCalls: number;
}

/** One row in an expanded drill-down pane. */
export interface ContributorDatum {
  /** Tool that produced it. */
  name: string;
  /** File path, command, URL, query, or `skill:<name>`. */
  label: string;
  tokens: number;
  calls: number;
  category: ToolCategory;
  truncatedCalls: number;
  /** How this row was measured — never claim more precision than we have. */
  method: "provider" | "estimated";
  /** Whether this content is part of the transcript sent to the model. */
  inContext: boolean;
}

export interface WarnDatum {
  level: "warn" | "critical";
  text: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Session totals are CUMULATIVE across every request in the session, which is
 * a different thing from the live context window. The `scope` tag travels in
 * the payload so a consumer cannot read them as current usage.
 */
export interface SessionTotals extends TokenTotals {
  scope: "session-cumulative";
}

/** Context-window usage: the current snapshot, not a running total. */
export interface ContextUsage {
  used: number;
  limit: number | null;
  pct: number | null;
  remaining: number | null;
  /** `provider` = anchored to reported usage; `estimate` = chars/4 only. */
  method: "provider" | "estimate" | "unknown";
  /** True when a newer assistant message exists without usage metadata. */
  stale: boolean;
}

export interface SessionCounts {
  /** Transcript entries returned by session.context(). */
  messages: number;
  /** Assistant messages. Kept for compatibility with older consumers. */
  steps: number;
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
  syntheticMessages: number;
  compactionCount: number;
  /** idle / agent-switched / model-switched / anything else uncounted. */
  ignoredMessages: number;
  /** Entries dropped from the composition by the compaction fence. */
  excludedByCompaction: number;
}

export interface SummaryResult {
  model: string;
  /** Current context-window usage. The headline number. */
  context: ContextUsage;
  // Legacy aliases — kept populated so existing consumers keep working.
  /** @see context.limit */
  limit: number | null;
  /** @see context.used */
  used: number;
  /** @see context.pct */
  pct: number | null;
  /** @see context.method — true unless provider-anchored. */
  estimated: boolean;

  /** Mutually exclusive partition of `context.used`. */
  segments: SegmentDatum[];
  /** Residual inside the partition (rounding + non-text skips). */
  unaccounted: number;
  /** Non-text content parts deliberately not counted. */
  skippedParts: number;

  /** Every ranked tool, unsliced. */
  toolIO: ToolDatum[];
  topTools: ToolDatum[];
  topByCategory: Record<ToolCategory, ToolDatum[]>;
  toolTotals: Record<ToolCategory, { tokens: number; calls: number }>;
  topDetails: ToolDetailDatum[];
  /** Contributors for the `others` catch-all, so it cannot hide mass. */
  othersContributors: ContributorDatum[];
  /** Contributors keyed by segment key, for the drill-down panes. */
  contributors: Record<string, ContributorDatum[]>;
  topSkills: SkillDatum[];

  classifierSource: "registry" | "heuristic";
  counts: SessionCounts;
  warn: WarnDatum | null;
  cumulative: SessionTotals | null;
}

export interface SummarizeOptions {
  limit?: number | null;
  model?: string;
  /** Cumulative server-reported session tokens (session.tokens). */
  sessionTokens?: unknown;
  warnAt?: number;
  criticalAt?: number;
  /** Registry-derived MCP ground truth; omitted => pure name heuristics. */
  classifier?: ToolClassifier;
}

export function estimateTokens(text: unknown): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function textContentToString(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      out.push((item as { text: string }).text);
    }
  }
  return out.join("\n\n");
}

function toTotals(tokens: unknown): TokenTotals | null {
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  const cache =
    t.cache && typeof t.cache === "object"
      ? (t.cache as Record<string, unknown>)
      : {};
  const totals: TokenTotals = {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
  // An all-zero envelope means "shape present, no usage reported". Treating
  // that as telemetry used to zero every bucket and report an empty context,
  // so it is reported as "no telemetry" and the UI falls back to estimates.
  const any = (Object.keys(totals) as (keyof TokenTotals)[]).some(
    (k) => totals[k] > 0,
  );
  return any ? totals : null;
}

/**
 * The prompt actually sent with one request. `cache.read` is the reused
 * prefix and `input` is the new suffix — they partition the same prompt, so
 * they are ADDED, never summed with a second copy of the cache figure.
 * `output`/`reasoning` are deliberately absent: they are produced after the
 * request was sent and belong to the next request's context, not this one.
 */
function promptTotal(t: TokenTotals): number {
  return t.input + t.cacheRead + t.cacheWrite;
}

export function summarize(
  messages: unknown,
  opts: SummarizeOptions = {},
): SummaryResult {
  const list: unknown[] = Array.isArray(messages) ? messages : [];
  const warnAt = opts.warnAt ?? 0.7;
  const criticalAt = opts.criticalAt ?? 0.9;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : null;

  // Composition buckets. Seeded from SEGMENT_META so the partition can never
  // drift from the segment list the UI renders.
  const buckets: Record<string, number> = {};
  for (const meta of SEGMENT_META) buckets[meta.key] = 0;

  // --- compaction fence --------------------------------------------------
  // Compaction REPLACES the transcript: `summary` + `recent` stand in for
  // everything before it. Counting the replaced messages as well double-counts
  // content that is no longer in the request context, which skews the whole
  // composition even though the headline total survives scaling.
  let fence = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i] as { type?: unknown } | null;
    if (m && typeof m === "object" && m.type === "compaction") fence = i;
  }

  // Counts describe the FULL transcript (that is a fact about the transcript);
  // `excludedByCompaction` says how many entries the fence kept out of the
  // composition. Together the per-type counts reconcile with `messages`.
  const counts: SessionCounts = {
    messages: list.length,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    systemMessages: 0,
    syntheticMessages: 0,
    compactionCount: fence === -1 ? 0 : 1,
    ignoredMessages: 0,
    excludedByCompaction: fence === -1 ? 0 : fence,
  };

  const tools = new Map<
    string,
    {
      name: string;
      tokens: number;
      calls: number;
      category: ToolCategory;
      truncatedCalls: number;
    }
  >();
  const skills = new Map<string, { name: string; tokens: number; count: number }>();
  // Usage metadata per assistant message, in transcript order, so we can tell
  // "newest request" from "newest request that reported usage" — they differ
  // whenever the last turn is in flight or errored without usage.
  const telemetryInOrder: (TokenTotals | null)[] = [];
  /** Content parts we deliberately do not count (images, binary, base64). */
  let skippedParts = 0;

  const classifier = opts.classifier;
  const classifierSource: "registry" | "heuristic" =
    asStringList(classifier?.mcpServers).length > 0 ||
    asStringList(classifier?.mcpTools).length > 0
      ? "registry"
      : "heuristic";

  const addTool = (
    name: string,
    tokens: number,
    category?: ToolCategory,
    part?: Record<string, unknown>,
    truncated = false,
  ) => {
    const base = name || "tool";
    // Classify late when the caller did not: shell messages and other
    // non-part call sites pass no category of their own.
    const cat = category ?? classifyTool(base, classifier, part);
    // Key by category: the same tool (e.g. `read`) can load skill files
    // (skills) and normal files (others) — collapsing them under one row
    // would misattribute tokens in toolTotals.
    const key = `${cat}|${base}`;
    const entry = tools.get(key) ?? {
      tokens: 0,
      calls: 0,
      category: cat,
      name: base,
      truncatedCalls: 0,
    };
    entry.tokens += tokens;
    entry.calls += 1;
    if (truncated) entry.truncatedCalls += 1;
    tools.set(key, entry);
    return cat;
  };

  const addSkill = (id: string, name: string, tokens: number) => {
    const key = name || id || "skill";
    const entry = skills.get(key) ?? { name: key, tokens: 0, count: 0 };
    entry.tokens += tokens;
    entry.count += 1;
    skills.set(key, entry);
  };

  const details = new Map<
    string,
    {
      name: string;
      label: string;
      tokens: number;
      calls: number;
      category: ToolCategory;
      truncatedCalls: number;
    }
  >();
  const addDetail = (
    name: string,
    label: string,
    tokens: number,
    category: ToolCategory,
    truncated = false,
  ) => {
    if (!label || tokens <= 0) return;
    const key = `${category}|${name}|${label}`;
    const entry = details.get(key) ?? {
      name,
      label,
      tokens: 0,
      calls: 0,
      category,
      truncatedCalls: 0,
    };
    entry.tokens += tokens;
    entry.calls += 1;
    if (truncated) entry.truncatedCalls += 1;
    details.set(key, entry);
  };

  for (let index = 0; index < list.length; index++) {
    const raw = list[index];
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;

    // Type census runs over the whole transcript so the per-type counts add up
    // to `counts.messages`. `compaction` has its own counter and is therefore
    // not also counted as "ignored".
    switch (msg.type) {
      case "user":
        counts.userMessages += 1;
        break;
      case "assistant":
        counts.assistantMessages += 1;
        counts.steps = counts.assistantMessages;
        break;
      case "system":
        counts.systemMessages += 1;
        break;
      case "synthetic":
        counts.syntheticMessages += 1;
        break;
      case "compaction":
        break;
      default:
        counts.ignoredMessages += 1;
        break;
    }

    // Everything before the last compaction has been replaced and is no longer
    // part of the request context, so it cannot contribute to the composition.
    if (index < fence) continue;

    switch (msg.type) {
      case "user": {
        buckets.history += estimateTokens(msg.text);
        // Attachments are base64 blobs; they occupy context but we cannot
        // estimate them, so they are surfaced as an explicit residual rather
        // than silently ignored.
        if (Array.isArray(msg.files)) skippedParts += msg.files.length;
        break;
      }
      case "system": {
        // Most `system` entries are instruction injections (skills
        // catalog, tool catalog), not the base prompt — attribute them
        // so the bar shows what's actually loaded.
        buckets[systemBucket(msg)] += estimateTokens(msg.text);
        break;
      }
      case "synthetic": {
        buckets.history += estimateTokens(msg.text);
        break;
      }
      case "skill": {
        const id = String(msg.skill ?? msg.id ?? "skill");
        const name = String(msg.name ?? id);
        const tokens = estimateTokens(msg.text);
        buckets.skills += tokens;
        addSkill(id, name, tokens);
        break;
      }
      case "shell": {
        const output = msg.output as { output?: unknown } | undefined;
        const tokens = estimateTokens(output?.output);
        buckets.others += tokens;
        if (tokens > 0) {
          addTool("shell", tokens, "others");
          const cmd =
            typeof (msg as { command?: unknown }).command === "string"
              ? (msg as { command?: string }).command
              : "";
          addDetail("shell", cmd || "shell", tokens, "others");
        }
        break;
      }
      case "compaction": {
        // Compacted-away history: `summary` plus `recent` together
        // replace the pre-compaction transcript. Counting only the
        // summary starves history after every compaction.
        const c = msg as { summary?: unknown; recent?: unknown };
        buckets.history +=
          estimateTokens(c.summary) + estimateTokens(c.recent);
        break;
      }
      case "instruction":
      case "instructions":
      case "rule":
      case "rules": {
        // Session instruction entries (AGENTS.md updates, configured
        // instructions) — the only rules text separable from the
        // transcript. Ambient rules baked into the system prompt stay
        // in `system`, so this segment is a lower bound.
        buckets.rules += estimateTokens(
          (msg as { text?: unknown }).text ??
            (msg as { content?: unknown }).content,
        );
        break;
      }
      case "assistant": {
        // Usage metadata is per-request, not cumulative — so the newest entry
        // that actually reported usage describes the newest request we know
        // the size of. Keep the order so we can detect a turn that reported
        // nothing (in flight / errored) after it.
        telemetryInOrder.push(toTotals(msg.tokens));
        const content = msg.content;
        if (!Array.isArray(content)) break;
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "text") {
            buckets.assistant += estimateTokens(p.text);
          } else if (p.type === "reasoning") {
            buckets.reasoning += estimateTokens(p.text);
          } else if (p.type === "tool") {
            const state = (p.state ?? {}) as Record<string, unknown>;
            if (state.status === "completed" || state.status === "error") {
              const tokens = estimateTokens(
                textContentToString(
                  (state as { content?: unknown }).content,
                ),
              );
              // OpenCode offloads long tool output to disk and flags it. The
              // stored `content` is then only a placeholder, so the estimate
              // below is a floor for this call, not its real size.
              const metadata = (state.metadata ?? null) as {
                truncated?: unknown;
              } | null;
              const truncated = metadata?.truncated === true;
              const name = String(p.name ?? "tool");
              const cat = classifyTool(name, classifier, p);
              // `skill`-tool loads and SKILL.md reads fold into the skills
              // segment alongside skill activations; rule-file reads fold
              // into rules; everything else keeps its own segment.
              if (cat === "skills") buckets.skills += tokens;
              else buckets[cat] += tokens;
              // The call itself (name + input JSON) is model output tokens.
              // Without this, tool-heavy turns show ~0 assistant output.
              buckets.assistant += estimateTokens(
                `${name} ${argsText(p)}`.slice(0, 2000),
              );
              addTool(name, tokens, cat, p, truncated);
              const label = toolLabel(name, p);
              if (label) addDetail(name, label, tokens, cat, truncated);
              // Name skill loads so "Skills this session" identifies them
              // instead of showing a bare `skill` tool row.
              if (name.toLowerCase() === "skill") {
                if (label) addSkill(label, label, tokens);
              } else if (label.startsWith("skill:")) {
                const skillName = label.slice("skill:".length);
                if (skillName) addSkill(skillName, skillName, tokens);
              }
            }
          } else if (p.type !== undefined) {
            // Files, images, and any part shape we do not model. They occupy
            // context; counting them as zero would silently understate `used`.
            skippedParts += 1;
          }
        }
        break;
      }
      default:
        // agent-switched, model-switched, idle, location-switched, etc.
        break;
    }
  }

  // ---------------------------------------------------------------------
  // (A) Context-window utilization
  //
  // Per-message `tokens` describes ONE request, and the newest such envelope
  // describes the largest prompt in the transcript (it grows monotonically).
  // That is the context the next request must fit, so it is the headline.
  // Output/reasoning from that same envelope are NOT added: they were not in
  // the prompt that request sent, so adding them would double-count the tail.
  // ---------------------------------------------------------------------
  let latestTelemetry: TokenTotals | null = null;
  let latestIndex = -1;
  for (let i = 0; i < telemetryInOrder.length; i++) {
    if (telemetryInOrder[i]) {
      latestTelemetry = telemetryInOrder[i];
      latestIndex = i;
    }
  }
  // A turn after the newest reported one that reported nothing means the
  // snapshot predates the live session — the number is real but behind.
  const stale =
    latestTelemetry !== null &&
    telemetryInOrder.slice(latestIndex + 1).some((t) => t === null);

  // ---------------------------------------------------------------------
  // (B) Context composition
  //
  // EVERY content bucket participates in the scaling, including `assistant`
  // and `reasoning`: that text is part of the cached prefix the next request
  // re-sends, so it belongs to the same partition. `unaccounted` is the
  // residual and is excluded — it is derived from `used`, not the other way
  // around.
  // ---------------------------------------------------------------------
  const CONTENT_KEYS = SEGMENT_META.map((m) => m.key).filter(
    (k) => k !== "unaccounted",
  );
  const sumOf = (keys: readonly string[]) =>
    keys.reduce((sum, key) => sum + (buckets[key] ?? 0), 0);

  const measuredPrompt = latestTelemetry ? promptTotal(latestTelemetry) : 0;
  const estimatedPrompt = sumOf(CONTENT_KEYS);

  let method: ContextUsage["method"];
  let used: number;
  if (measuredPrompt > 0 && estimatedPrompt > 0) {
    // Scale uniformly so every category keeps its relative share of the
    // partition. Overwriting one bucket with server truth (as this used to do
    // for `assistant`) breaks the partition and smears the error elsewhere.
    const factor = measuredPrompt / estimatedPrompt;
    for (const key of CONTENT_KEYS) {
      buckets[key] = Math.max(0, Math.round(buckets[key] * factor));
    }
    method = "provider";
    used = measuredPrompt;
  } else if (measuredPrompt > 0) {
    // The provider reported a prompt we cannot attribute at all. Do not
    // invent a split — report the total and expose it as fully unaccounted.
    method = "unknown";
    used = measuredPrompt;
  } else {
    method = estimatedPrompt > 0 ? "estimate" : "unknown";
    used = estimatedPrompt;
  }

  // Reconcile to an exact partition of `used`. Independent rounding can leave
  // the scaled buckets a few tokens over; trim that from the largest buckets
  // (the least informative place to lose a token). Anything left below is a
  // genuine residual and is surfaced as `unaccounted` — never smeared into a
  // category to make the numbers look tidy.
  buckets.unaccounted = 0;
  let total = sumOf(CONTENT_KEYS);
  if (total > used) {
    let over = total - used;
    for (const key of [...CONTENT_KEYS].sort((a, b) => buckets[b] - buckets[a])) {
      if (over <= 0) break;
      const take = Math.min(buckets[key], over);
      buckets[key] -= take;
      over -= take;
    }
  }
  buckets.unaccounted = Math.max(0, used - sumOf(CONTENT_KEYS));

  const pct = limit ? (used / limit) * 100 : null;
  const estimated = method !== "provider";
  const context: ContextUsage = {
    used,
    limit,
    pct,
    remaining: limit === null ? null : Math.max(0, limit - used),
    method,
    stale,
  };

  const segments: SegmentDatum[] = SEGMENT_META.map((meta) => {
    const tokens = Math.max(0, buckets[meta.key] ?? 0);
    return {
      key: meta.key,
      label: meta.label,
      color: meta.color,
      tokens,
      // Always state the denominator: null, never a fabricated 0.
      pctOfUsed: used > 0 ? (tokens / used) * 100 : null,
      pctOfLimit: limit ? (tokens / limit) * 100 : null,
    };
  });

  // ---------------------------------------------------------------------
  // (C) + (D) Tool I/O and cumulative session accounting
  //
  // Tool rows are estimates over TRANSCRIPT text and are deliberately NOT
  // scaled: they answer "which tool moved the most bytes", not "what share of
  // the window". They are never summed against `used`.
  // ---------------------------------------------------------------------
  const rankedTools: ToolDatum[] = [...tools.values()]
    .map((entry) => ({
      name: entry.name,
      tokens: entry.tokens,
      calls: entry.calls,
      category: entry.category,
      truncatedCalls: entry.truncatedCalls,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const topTools: ToolDatum[] = rankedTools.slice(0, 5);
  const topByCategory = Object.fromEntries(
    TOOL_CATEGORIES.map((cat) => [
      cat,
      rankedTools.filter((t) => t.category === cat).slice(0, 10),
    ]),
  ) as Record<ToolCategory, ToolDatum[]>;
  const toolTotals = Object.fromEntries(
    TOOL_CATEGORIES.map((cat) => {
      const inCat = rankedTools.filter((t) => t.category === cat);
      return [
        cat,
        {
          tokens: inCat.reduce((sum, t) => sum + t.tokens, 0),
          calls: inCat.reduce((sum, t) => sum + t.calls, 0),
        },
      ];
    }),
  ) as Record<ToolCategory, { tokens: number; calls: number }>;

  const topSkills: SkillDatum[] = [...skills.values()]
    .map((entry) => ({
      id: entry.name,
      name: entry.name,
      tokens: entry.tokens,
      count: entry.count,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const detailRows: ToolDetailDatum[] = [...details.values()].sort(
    (a, b) => b.tokens - a.tokens,
  );
  const topDetails: ToolDetailDatum[] = detailRows.slice(0, 12);

  // Drill-down rows per tool segment. `others` is the catch-all, so it is
  // deliberately unsliced — a top-3 summary there is what made 64% of it look
  // unattributable in the old UI.
  const contributors: Record<string, ContributorDatum[]> = {};
  for (const cat of TOOL_CATEGORIES) {
    contributors[cat] = detailRows
      .filter((d) => d.category === cat)
      .map((d) => ({
        name: d.name,
        label: d.label,
        tokens: d.tokens,
        calls: d.calls,
        category: d.category,
        truncatedCalls: d.truncatedCalls,
        method: "estimated" as const,
        inContext: true,
      }));
  }
  const othersContributors = contributors.others ?? [];

  let warn: WarnDatum | null = null;
  if (pct !== null) {
    if (pct / 100 >= criticalAt) {
      warn = {
        level: "critical",
        text: `Context ${pct.toFixed(0)}% full — consider compacting this session soon.`,
      };
    } else if (pct / 100 >= warnAt) {
      warn = {
        level: "warn",
        text: `Context ${pct.toFixed(0)}% used — keep an eye on large tool outputs.`,
      };
    }
  }

  // `session.tokens*` columns are cumulative spend, not window occupancy.
  const cumulativeTotals = toTotals(opts.sessionTokens);

  return {
    model: opts.model ?? "unknown",
    context,
    // Legacy flat fields, kept populated for existing consumers.
    limit,
    used,
    pct,
    segments,
    unaccounted: buckets.unaccounted,
    skippedParts,
    toolIO: rankedTools,
    topTools,
    topByCategory,
    toolTotals,
    topDetails,
    contributors,
    othersContributors,
    topSkills,
    classifierSource,
    counts,
    warn,
    estimated,
    cumulative: cumulativeTotals
      ? { ...cumulativeTotals, scope: "session-cumulative" }
      : null,
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function barLine(
  label: string,
  tokens: number,
  pct: number | null,
  width = 24,
): string {
  const share = pct === null ? 0 : Math.max(0, Math.min(1, pct / 100));
  const filled = Math.round(share * width);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  const pctText = pct === null ? "  ?  " : `${pct.toFixed(1).padStart(5)}%`;
  return `${label.padEnd(9)} ${bar} ${pctText} (${formatNumber(tokens)})`;
}

/**
 * Plain-text rendering for tools / synthetic session messages.
 * Mirrors the TUI dialog: explicit denominators on every percentage,
 * tool I/O labeled as returned-output estimates (never summed against
 * `used`), and cumulative session spend in its own labeled block.
 */
export function renderSummaryText(summary: SummaryResult): string {
  const lines: string[] = [];
  const ctx = summary.context;
  const head =
    summary.limit && summary.pct !== null
      ? `${formatNumber(summary.used)} / ${formatNumber(summary.limit)} tokens (${summary.pct.toFixed(1)}% of window, ${summary.model})`
      : `${formatNumber(summary.used)} tokens (model limit unknown — ${summary.model})`;
  const methodLabel =
    ctx.method === "provider"
      ? "provider-anchored"
      : ctx.method === "estimate"
        ? "estimates"
        : "unattributed";
  const remaining =
    ctx.remaining !== null ? `, ${formatNumber(ctx.remaining)} remaining` : "";
  lines.push(`Context: ${head}${remaining} [${methodLabel}]${ctx.stale ? " [stale: newer turn reported no usage]" : ""}`);
  lines.push("");
  for (const seg of summary.segments) {
    if (seg.tokens === 0) continue;
    const ofWindow =
      seg.pctOfLimit !== null ? `${seg.pctOfLimit.toFixed(1)}% of window` : "window share unknown";
    const ofUsed =
      seg.pctOfUsed !== null ? `${seg.pctOfUsed.toFixed(1)}% of used` : "share of used unknown";
    lines.push(
      barLine(seg.label.toUpperCase(), seg.tokens, seg.pctOfLimit) +
        ` — ${ofWindow} (${ofUsed})`,
    );
  }
  if (summary.skippedParts > 0) {
    lines.push(
      `(${formatNumber(summary.skippedParts)} non-text parts skipped — images/files counted in "unaccounted", not silently dropped)`,
    );
  }
  if (summary.counts.excludedByCompaction > 0) {
    lines.push(
      `(${formatNumber(summary.counts.excludedByCompaction)} pre-compaction entries fenced out — replaced by the compaction summary)`,
    );
  }
  if (summary.topTools.length > 0) {
    lines.push("");
    lines.push(
      `Top tools, by RETURNED output, estimates (${summary.classifierSource === "registry" ? "registry-classified" : "name-heuristic; registry unavailable"} — not shares of used context):`,
    );
    for (const tool of summary.topTools) {
      const trunc =
        tool.truncatedCalls > 0 ? `, ${tool.truncatedCalls} truncated` : "";
      lines.push(`- ${tool.name} [${tool.category}]: ~${formatNumber(tool.tokens)} tokens returned, ${tool.calls} calls${trunc}`);
    }
  }
  if (summary.toolTotals) {
    const parts = (Object.keys(summary.toolTotals) as ToolCategory[])
      .filter((cat) => {
        const t = summary.toolTotals[cat];
        return t.tokens > 0 || t.calls > 0;
      })
      .map((cat) => {
        const t = summary.toolTotals[cat];
        return `${cat} ~${formatNumber(t.tokens)} returned/${t.calls} calls`;
      })
      .join(" · ");
    lines.push("");
    lines.push(`Tool output by source (returned, estimated): ${parts}`);
  }
  if (summary.topSkills.length > 0) {
    lines.push("");
    lines.push("Skills this session (estimated):");
    for (const skill of summary.topSkills) {
      lines.push(`- ${skill.name}: ~${formatNumber(skill.tokens)} tokens, ${skill.count}x`);
    }
  }
  if (summary.topDetails.length > 0) {
    lines.push("");
    lines.push("Loaded details (heaviest individual loads, estimated returned output):");
    for (const d of summary.topDetails) {
      const trunc = d.truncatedCalls > 0 ? `, ${d.truncatedCalls} truncated` : "";
      lines.push(`- ${d.name} [${d.category}] ${d.label}: ~${formatNumber(d.tokens)} tokens, ${d.calls} calls${trunc}`);
    }
  }
  if (summary.cumulative) {
    const c = summary.cumulative;
    lines.push("");
    lines.push(
      `Session totals (cumulative across requests — NOT current window): in ${formatNumber(c.input)}, out ${formatNumber(c.output)}, reasoning ${formatNumber(c.reasoning)}, cache read/write ${formatNumber(c.cacheRead)}/${formatNumber(c.cacheWrite)}`,
    );
  }
  {
    const c = summary.counts;
    lines.push("");
    lines.push(
      `Transcript: ${formatNumber(c.messages)} messages (${formatNumber(c.userMessages)} user, ${formatNumber(c.assistantMessages)} assistant, ${formatNumber(c.systemMessages)} system, ${formatNumber(c.syntheticMessages)} synthetic, ${formatNumber(c.compactionCount)} compaction, ${formatNumber(c.ignoredMessages)} ignored)`,
    );
  }
  if (summary.warn) {
    lines.push("");
    lines.push(summary.warn.text);
  }
  return lines.join("\n");
}

export interface GlobalSkillDatum {
  id: string;
  name: string;
  count: number;
  lastUsed: number;
  estTokens: number;
}

export function renderSkillsText(skills: GlobalSkillDatum[]): string {
  if (skills.length === 0) {
    return "No skill invocations recorded yet. Skills are tracked from the session.skill.activated event as you use them.";
  }
  const lines = ["Skill usage (all sessions):", ""];
  for (const skill of skills.slice(0, 20)) {
    const when = skill.lastUsed
      ? new Date(skill.lastUsed).toISOString().slice(0, 16).replace("T", " ")
      : "unknown";
    lines.push(
      `- ${skill.name}: ${skill.count}x, ~${formatNumber(skill.estTokens)} tokens, last ${when}`,
    );
  }
  return lines.join("\n");
}
