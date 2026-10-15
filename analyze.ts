/**
 * context-segments — analyze.ts
 *
 * Pure, dependency-free context math. Shared by the server entrypoint
 * (`index.ts`). Operates on plain JSON message shapes (defensive `any`
 * access) so it stays robust across minor OpenCode schema drift.
 *
 * Method (lightweight, per approved plan — no vendor tokenizers):
 *  1. Bucket visible transcript text into segments:
 *     system / skills / history(user) / mcps / rules / others /
 *     assistant / reasoning.
 *     NOTE: user file attachments (base64) and tool file contents (URIs)
 *     are deliberately skipped — only human-readable text is counted.
 *  2. Rough-count with ceil(chars / 4).
 *  3. When the newest assistant message carries server telemetry
 *     (`tokens: { input, output, reasoning, cache: { read, write } }`),
 *     scale the prompt-side buckets to input+cache and the
 *     assistant/reasoning buckets to output/reasoning (same idea as the
 *     reference context-analysis plugin's applyTokenTelemetry).
 *  4. Headline usage = sum of scaled segments; pct = used / model limit.
 */

export interface SegmentMeta {
  key: string;
  label: string;
  /** Default hex color, tuned for dark themes (vesper). */
  color: string;
}

export const SEGMENT_META: SegmentMeta[] = [
  { key: "system", label: "system", color: "#8b8fa3" },
  { key: "skills", label: "skills", color: "#a78bfa" },
  { key: "history", label: "history", color: "#60a5fa" },
  { key: "mcps", label: "mcps", color: "#fbbf24" },
  { key: "rules", label: "rules", color: "#2dd4bf" },
  { key: "others", label: "others", color: "#fb7185" },
  { key: "assistant", label: "assistant", color: "#34d399" },
  { key: "reasoning", label: "reasoning", color: "#f472b6" },
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
 * instruction blocks (skills catalog, tool catalog) as `type: "system"`
 * messages tagged `description: "Instructions updated: …"` — leaving
 * them all in `system` hides what's actually eating context, so the
 * skills catalog folds into `skills` and the tool catalog into `mcps`.
 */
function systemBucket(
  msg: Record<string, unknown>,
): "system" | "skills" | "mcps" | "rules" {
  const desc = typeof msg.description === "string" ? msg.description : "";
  const text = typeof msg.text === "string" ? msg.text.slice(0, 2000) : "";
  if (/skill-guidance/i.test(desc) || SKILLS_CATALOG_RE.test(text))
    return "skills";
  if (
    /mcp-guidance/i.test(desc) ||
    /codemode/i.test(desc) ||
    TOOL_CATALOG_RE.test(text)
  )
    return "mcps";
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
  /** Share of the model context limit (null when the limit is unknown). */
  pctOfLimit: number | null;
  /** Share of counted usage. */
  pctOfUsed: number;
}

export interface ToolDatum {
  name: string;
  tokens: number;
  calls: number;
  category: ToolCategory;
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

export interface SummaryResult {
  model: string;
  /** Model context limit; null when it could not be resolved. */
  limit: number | null;
  used: number;
  /** used / limit * 100; null when the limit is unknown. */
  pct: number | null;
  segments: SegmentDatum[];
  topTools: ToolDatum[];
  /** Skills observed in this session's transcript. */
  topSkills: SkillDatum[];
  /** Heaviest individual loads: what exactly was pulled in (top 12). */
  topDetails: ToolDetailDatum[];
  /** Per-category tool leaders (top 5 each, tokens desc). */
  topByCategory: Record<ToolCategory, ToolDatum[]>;
  /** Token/call totals per tool category. */
  toolTotals: Record<ToolCategory, { tokens: number; calls: number }>;
  /** Whether MCP attribution used the live registry or name heuristics. */
  classifierSource: "registry" | "heuristic";
  counts: { messages: number; steps: number };
  warn: WarnDatum | null;
  /** True when no server telemetry was available (pure estimates). */
  estimated: boolean;
  /** Cumulative server-reported session totals, when provided. */
  cumulative: TokenTotals | null;
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
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
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

  const buckets: Record<string, number> = {
    system: 0,
    skills: 0,
    history: 0,
    mcps: 0,
    rules: 0,
    others: 0,
    assistant: 0,
    reasoning: 0,
  };
  const tools = new Map<
    string,
    { name: string; tokens: number; calls: number; category: ToolCategory }
  >();
  const skills = new Map<string, { name: string; tokens: number; count: number }>();
  let steps = 0;
  let latestTelemetry: TokenTotals | null = null;

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
    };
    entry.tokens += tokens;
    entry.calls += 1;
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
    }
  >();
  const addDetail = (
    name: string,
    label: string,
    tokens: number,
    category: ToolCategory,
  ) => {
    if (!label || tokens <= 0) return;
    const key = `${category}|${name}|${label}`;
    const entry = details.get(key) ?? {
      name,
      label,
      tokens: 0,
      calls: 0,
      category,
    };
    entry.tokens += tokens;
    entry.calls += 1;
    details.set(key, entry);
  };

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    switch (msg.type) {
      case "user": {
        buckets.history += estimateTokens(msg.text);
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
        steps += 1;
        const telemetry = toTotals(msg.tokens);
        if (telemetry) latestTelemetry = telemetry;
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
              addTool(name, tokens, cat, p);
              const label = toolLabel(name, p);
              if (label) addDetail(name, label, tokens, cat);
              // Name skill loads so "Skills this session" identifies them
              // instead of showing a bare `skill` tool row.
              if (name.toLowerCase() === "skill") {
                if (label) addSkill(label, label, tokens);
              } else if (label.startsWith("skill:")) {
                const skillName = label.slice("skill:".length);
                if (skillName) addSkill(skillName, skillName, tokens);
              }
            }
          }
        }
        break;
      }
      default:
        // agent-switched, model-switched, idle, location-switched, etc.
        break;
    }
  }

  // Prompt-side buckets scale to input+cache; the old single `tools`
  // bucket is now three segments (mcps/rules/others) — the `skills`
  // segment already includes skill-tool outputs folded in above.
  const PROMPT_KEYS = [
    "system",
    "skills",
    "history",
    "mcps",
    "rules",
    "others",
  ] as const;
  let estimated = true;
  if (latestTelemetry) {
    const promptMeasured = PROMPT_KEYS.reduce(
      (sum, key) => sum + buckets[key],
      0,
    );
    const promptActual =
      latestTelemetry.input +
      latestTelemetry.cacheRead +
      latestTelemetry.cacheWrite;
    if (promptActual > 0 && promptMeasured > 0) {
      const factor = promptActual / promptMeasured;
      for (const key of PROMPT_KEYS) {
        buckets[key] = Math.round(buckets[key] * factor);
      }
      // Fix rounding drift on the largest prompt bucket.
      const scaled = PROMPT_KEYS.reduce((sum, key) => sum + buckets[key], 0);
      const drift = Math.round(promptActual - scaled);
      if (drift !== 0) {
        let biggest: (typeof PROMPT_KEYS)[number] = "history";
        for (const key of PROMPT_KEYS) {
          if (buckets[key] > buckets[biggest]) biggest = key;
        }
        buckets[biggest] += drift;
      }
      estimated = false;
    } else if (promptActual <= 0) {
      for (const key of PROMPT_KEYS) buckets[key] = 0;
    }
    if (latestTelemetry.output > 0 && (buckets.assistant > 0 || steps > 0)) {
      // Fall back to server truth when the transcript carries no text
      // (e.g. a pure tool-call turn): output tokens are real even when
      // our text estimate is 0.
      buckets.assistant = latestTelemetry.output;
      estimated = false;
    } else if (latestTelemetry.output <= 0) {
      buckets.assistant = 0;
    }
    if (
      latestTelemetry.reasoning > 0 &&
      (buckets.reasoning > 0 || steps > 0)
    ) {
      buckets.reasoning = latestTelemetry.reasoning;
      estimated = false;
    } else if (latestTelemetry.reasoning <= 0) {
      buckets.reasoning = 0;
    }
  }

  const used = SEGMENT_META.reduce((sum, meta) => sum + buckets[meta.key], 0);
  const pct = limit ? (used / limit) * 100 : null;

  const segments: SegmentDatum[] = SEGMENT_META.map((meta) => ({
    key: meta.key,
    label: meta.label,
    color: meta.color,
    tokens: buckets[meta.key],
    pctOfLimit: limit ? (buckets[meta.key] / limit) * 100 : null,
    pctOfUsed: used > 0 ? (buckets[meta.key] / used) * 100 : 0,
  }));

  const rankedTools: ToolDatum[] = [...tools.values()]
    .map((entry) => ({
      name: entry.name,
      tokens: entry.tokens,
      calls: entry.calls,
      category: entry.category,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const topTools: ToolDatum[] = rankedTools.slice(0, 5);
  const topByCategory = Object.fromEntries(
    TOOL_CATEGORIES.map((cat) => [
      cat,
      rankedTools.filter((t) => t.category === cat).slice(0, 5),
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

  const topDetails: ToolDetailDatum[] = [...details.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12);

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

  return {
    model: opts.model ?? "unknown",
    limit,
    used,
    pct,
    segments,
    topTools,
    topSkills,
    topDetails,
    topByCategory,
    toolTotals,
    classifierSource,
    counts: { messages: list.length, steps },
    warn,
    estimated,
    cumulative: toTotals(opts.sessionTokens),
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

/** Plain-text rendering for tools / synthetic session messages. */
export function renderSummaryText(summary: SummaryResult): string {
  const lines: string[] = [];
  const head =
    summary.limit && summary.pct !== null
      ? `${formatNumber(summary.used)} / ${formatNumber(summary.limit)} tokens (${summary.pct.toFixed(1)}% of ${summary.model})`
      : `${formatNumber(summary.used)} tokens (model limit unknown — ${summary.model})`;
  lines.push(`Context: ${head}${summary.estimated ? " [estimates]" : ""}`);
  lines.push("");
  for (const seg of summary.segments) {
    if (seg.tokens === 0) continue;
    lines.push(barLine(seg.label.toUpperCase(), seg.tokens, seg.pctOfLimit));
  }
  if (summary.topTools.length > 0) {
    lines.push("");
    lines.push(
      `Top tools (${summary.classifierSource === "registry" ? "registry-classified" : "name-heuristic; registry unavailable"}):`,
    );
    for (const tool of summary.topTools) {
      lines.push(`- ${tool.name} [${tool.category}]: ${formatNumber(tool.tokens)} tokens, ${tool.calls} calls`);
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
        return `${cat} ${formatNumber(t.tokens)} tokens/${t.calls} calls`;
      })
      .join(" · ");
    lines.push("");
    lines.push(`Tools by source: ${parts}`);
  }
  if (summary.topSkills.length > 0) {
    lines.push("");
    lines.push("Skills this session:");
    for (const skill of summary.topSkills) {
      lines.push(`- ${skill.name}: ${formatNumber(skill.tokens)} tokens, ${skill.count}x`);
    }
  }
  if (summary.topDetails.length > 0) {
    lines.push("");
    lines.push("Loaded details (heaviest individual loads):");
    for (const d of summary.topDetails) {
      lines.push(`- ${d.name} [${d.category}] ${d.label}: ${formatNumber(d.tokens)} tokens, ${d.calls} calls`);
    }
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
