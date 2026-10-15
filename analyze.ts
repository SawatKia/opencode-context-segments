/**
 * context-segments — analyze.ts
 *
 * Pure, dependency-free context math. Shared by the server entrypoint
 * (`index.ts`). Operates on plain JSON message shapes (defensive `any`
 * access) so it stays robust across minor OpenCode schema drift.
 *
 * Method (lightweight, per approved plan — no vendor tokenizers):
 *  1. Bucket visible transcript text into segments:
 *     system / skills / history(user) / tools / assistant / reasoning.
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
  { key: "tools", label: "tools", color: "#fbbf24" },
  { key: "assistant", label: "assistant", color: "#34d399" },
  { key: "reasoning", label: "reasoning", color: "#f472b6" },
];

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
}

export interface SkillDatum {
  id: string;
  name: string;
  tokens: number;
  count: number;
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
    tools: 0,
    assistant: 0,
    reasoning: 0,
  };
  const tools = new Map<string, { tokens: number; calls: number }>();
  const skills = new Map<string, { name: string; tokens: number; count: number }>();
  let steps = 0;
  let latestTelemetry: TokenTotals | null = null;

  const addTool = (name: string, tokens: number) => {
    const key = name || "tool";
    const entry = tools.get(key) ?? { tokens: 0, calls: 0 };
    entry.tokens += tokens;
    entry.calls += 1;
    tools.set(key, entry);
  };

  const addSkill = (id: string, name: string, tokens: number) => {
    const key = name || id || "skill";
    const entry = skills.get(key) ?? { name: key, tokens: 0, count: 0 };
    entry.tokens += tokens;
    entry.count += 1;
    skills.set(key, entry);
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
        buckets.system += estimateTokens(msg.text);
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
        buckets.tools += tokens;
        if (tokens > 0) addTool("shell", tokens);
        break;
      }
      case "compaction": {
        // msg.summary is the compacted-away history in one line.
        buckets.history += estimateTokens(
          (msg as { summary?: unknown }).summary,
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
              buckets.tools += tokens;
              addTool(String(p.name ?? "tool"), tokens);
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

  // Scale estimates to server telemetry when available.
  let estimated = true;
  if (latestTelemetry) {
    const promptMeasured =
      buckets.system + buckets.skills + buckets.history + buckets.tools;
    const promptActual =
      latestTelemetry.input +
      latestTelemetry.cacheRead +
      latestTelemetry.cacheWrite;
    if (promptActual > 0 && promptMeasured > 0) {
      const factor = promptActual / promptMeasured;
      for (const key of ["system", "skills", "history", "tools"]) {
        buckets[key] = Math.round(buckets[key] * factor);
      }
      // Fix rounding drift on the largest prompt bucket.
      const keys = ["system", "skills", "history", "tools"] as const;
      const scaled = keys.reduce((sum, key) => sum + buckets[key], 0);
      const drift = Math.round(promptActual - scaled);
      if (drift !== 0) {
        let biggest: (typeof keys)[number] = "history";
        for (const key of keys) {
          if (buckets[key] > buckets[biggest]) biggest = key;
        }
        buckets[biggest] += drift;
      }
      estimated = false;
    } else if (promptActual <= 0) {
      buckets.system = 0;
      buckets.skills = 0;
      buckets.history = 0;
      buckets.tools = 0;
    }
    if (latestTelemetry.output > 0 && buckets.assistant > 0) {
      buckets.assistant = latestTelemetry.output;
      estimated = false;
    } else if (latestTelemetry.output <= 0) {
      buckets.assistant = 0;
    }
    if (latestTelemetry.reasoning > 0 && buckets.reasoning > 0) {
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

  const topTools: ToolDatum[] = [...tools.entries()]
    .map(([name, entry]) => ({ name, tokens: entry.tokens, calls: entry.calls }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const topSkills: SkillDatum[] = [...skills.values()]
    .map((entry) => ({
      id: entry.name,
      name: entry.name,
      tokens: entry.tokens,
      count: entry.count,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

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
    lines.push("Top tools:");
    for (const tool of summary.topTools) {
      lines.push(`- ${tool.name}: ${formatNumber(tool.tokens)} tokens, ${tool.calls} calls`);
    }
  }
  if (summary.topSkills.length > 0) {
    lines.push("");
    lines.push("Skills this session:");
    for (const skill of summary.topSkills) {
      lines.push(`- ${skill.name}: ${formatNumber(skill.tokens)} tokens, ${skill.count}x`);
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
