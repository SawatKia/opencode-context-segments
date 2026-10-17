/**
 * Fixtures for `analyze.test.ts`.
 *
 * These are SHAPES, not transcripts: every record mirrors the real field
 * layout observed in `opencode.db` (`session_message.data` merged with the
 * `type` column), but the text is synthetic filler sized so token estimates
 * are exact integers. `estimateTokens` is `ceil(trimmed.length / 4)`, so
 * `w(n)` produces exactly `n` estimated tokens.
 */

/** Text whose estimate is exactly `n` tokens (4n characters, no padding). */
export function w(n: number): string {
  return "x".repeat(4 * n);
}

/** Per-request usage envelope, as OpenCode stores it on assistant messages. */
export function usage(input: number, output: number, reasoning: number, read: number, write: number) {
  return {
    input,
    output,
    reasoning,
    cache: { read, write },
  };
}

export function userMsg(textTokens: number, files?: unknown[]): Record<string, unknown> {
  const msg: Record<string, unknown> = { type: "user", text: w(textTokens) };
  if (files) msg.files = files;
  return msg;
}

export function assistantMsg(opts: {
  text?: number;
  reasoning?: number;
  tools?: Record<string, unknown>[];
  tokens?: unknown;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (opts.text) content.push({ type: "text", text: w(opts.text) });
  if (opts.reasoning) content.push({ type: "reasoning", text: w(opts.reasoning) });
  if (opts.tools) content.push(...opts.tools);
  const msg: Record<string, unknown> = { type: "assistant", content };
  if (opts.tokens) msg.tokens = opts.tokens;
  return msg;
}

export function toolPart(opts: {
  name: string;
  output?: number;
  input?: unknown;
  status?: string;
  truncated?: boolean;
}): Record<string, unknown> {
  const part: Record<string, unknown> = {
    type: "tool",
    name: opts.name,
    input: opts.input ?? {},
    state: {
      status: opts.status ?? "completed",
      content: [{ type: "text", text: w(opts.output ?? 0) }],
    },
  };
  if (opts.truncated !== undefined) {
    (part.state as Record<string, unknown>).metadata = { truncated: opts.truncated };
  }
  return part;
}

export function systemMsg(desc: string, textTokens: number): Record<string, unknown> {
  return { type: "system", description: desc, text: w(textTokens) };
}

export function compactionMsg(summaryTokens: number, recentTokens: number): Record<string, unknown> {
  return { type: "compaction", summary: w(summaryTokens), recent: w(recentTokens) };
}

/** MCP-guidance / Code Mode catalog injection — a TOOL CATALOG, not MCP output. */
export function catalogSystemMsg(textTokens: number): Record<string, unknown> {
  return systemMsg("Instructions updated: core/codemode, core/mcp-guidance", textTokens);
}

/**
 * A session with a single provider-reported request. Used as the base for
 * "one clean turn" assertions.
 */
export function providerSession(cacheRead = 9000): Record<string, unknown>[] {
  return [
    userMsg(100),
    assistantMsg({
      text: 40,
      tools: [toolPart({ name: "read", output: 500, input: { filePath: "C:/repo/a.ts" } })],
      tokens: usage(1000, 500, 200, cacheRead, 100),
    }),
  ];
}

/** Same session with a later assistant turn that reported no usage (in flight). */
export function staleSession(): Record<string, unknown>[] {
  return [
    ...providerSession(9000),
    assistantMsg({ text: 20 }),
  ];
}

/** Pre-compaction history, a compaction record, then post-compaction history. */
export function compactionSession(): Record<string, unknown>[] {
  return [
    userMsg(1000),
    assistantMsg({ text: 500, tokens: usage(1200, 300, 0, 5000, 0) }),
    userMsg(2000),
    compactionMsg(700, 300),
    userMsg(400),
    assistantMsg({
      text: 300,
      tokens: usage(900, 250, 0, 8000, 0),
    }),
  ];
}

/** A session with no usage metadata anywhere — estimates only. */
export function estimateSession(): Record<string, unknown>[] {
  return [
    userMsg(50),
    assistantMsg({ text: 60, reasoning: 20 }),
  ];
}

/**
 * Many distinct `bash` invocations inside the `others` catch-all. Used to
 * prove the catch-all is not silently sliced to a top-3 summary.
 */
export function manyOthersSession(count: number): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    tools.push(
      toolPart({ name: "bash", output: 100 - i, input: { command: `echo run-${i}` } }),
    );
  }
  return [
    userMsg(20),
    assistantMsg({
      tools,
      tokens: usage(300, 100, 0, 4000, 0),
    }),
  ];
}

/** One MCP tool call (registry-free heuristic path). */
export function mcpSession(): Record<string, unknown>[] {
  return [
    userMsg(30),
    assistantMsg({
      tools: [
        toolPart({
          name: "context7_query-docs",
          output: 700,
          input: { libraryId: "/vercel/next.js" },
        }),
      ],
      tokens: usage(200, 80, 0, 3000, 0),
    }),
  ];
}

/** The catalog bug that motivated the `catalog` segment. */
export function catalogOnlySession(): Record<string, unknown>[] {
  return [
    userMsg(20),
    catalogSystemMsg(4000),
    assistantMsg({ text: 30, tokens: usage(150, 60, 0, 5000, 0) }),
  ];
}