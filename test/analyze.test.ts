/**
 * Contract tests for `analyze.ts`.
 *
 * Every test names the accounting invariant it protects, taken from the
 * "Accounting contract" block in `analyze.ts`'s header comment:
 *   A. context.used = newest assistant's input + cache.read + cache.write
 *      (output/reasoning excluded)
 *   B. segments are a mutually exclusive, EXACT partition of context.used
 *   C. session totals are cumulative and never mixed into context.used
 *   D. tool I/O is reported on its own, never summed against used
 *
 * Arithmetic in the compaction tests is spelled out because `w(n)` makes
 * `estimateTokens` exact: `w(n)` is 4n characters, so it estimates to n.
 *
 * Fixture inputs are plain JSON shapes; `analyze.ts` reads them defensively.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  summarize,
  renderSummaryText,
  estimateTokens,
  SEGMENT_META,
  TOOL_CATEGORIES,
} from "../analyze.ts";
import type {
  SegmentDatum,
  SummaryResult,
  ToolDatum,
} from "../analyze.ts";
import {
  w,
  usage,
  userMsg,
  assistantMsg,
  toolPart,
  systemMsg,
  compactionMsg,
  catalogSystemMsg,
  providerSession,
  staleSession,
  compactionSession,
  estimateSession,
  manyOthersSession,
  mcpSession,
  catalogOnlySession,
} from "./fixtures.ts";

// --- local assertion helpers -----------------------------------------------

/** Look up one segment by key, failing loudly if the key drifted away. */
const seg = (s: SummaryResult, key: string): SegmentDatum => {
  const found = s.segments.find((x) => x.key === key);
  assert.ok(found, `segment "${key}" is missing from s.segments`);
  return found;
};

/** Look up one tool row by name, failing loudly if it is absent. */
const toolRow = (s: SummaryResult, name: string): ToolDatum => {
  const found = s.toolIO.find((t) => t.name === name);
  assert.ok(found, `toolIO row "${name}" is missing`);
  return found;
};

/** Sum of every segment, including the `unaccounted` residual. */
const partitionSum = (s: SummaryResult): number =>
  s.segments.reduce((sum, x) => sum + x.tokens, 0);

// ===========================================================================
test.describe("fixture arithmetic", () => {
  test("w(n) estimates to exactly n tokens, so test arithmetic is exact", () => {
    // Invariant under test: every exact number below rests on this. If
    // estimateTokens ever changes, these assertions fail loudly rather than
    // silently re-basing every downstream expectation.
    for (const n of [0, 1, 7, 100, 400, 5000]) {
      assert.equal(estimateTokens(w(n)), n, `w(${n}) must estimate to ${n}`);
    }
  });
});

// ===========================================================================
test.describe("A. context.used — the headline number", () => {
  test("used excludes output and reasoning (input + cache.read + cache.write)", () => {
    // providerSession's telemetry is usage(1000, 500, 200, 9000, 100):
    //   input 1000 + cache.read 9000 + cache.write 100 = 10100
    //   output 500 and reasoning 200 were produced AFTER that prompt was
    //   sent, so they must not appear in the headline.
    const s = summarize(providerSession());

    assert.equal(s.context.used, 1000 + 9000 + 100);
    assert.equal(s.context.used, 10100);
    assert.equal(s.context.method, "provider");

    const withOutput = 10100 + 500 + 200;
    assert.notEqual(s.context.used, withOutput);
    assert.ok(s.context.used < withOutput);
  });

  test("newest telemetry wins; per-request usage is never cumulatively summed", () => {
    // Regression guard: `tokens` describes ONE request, not a running total.
    // Summing them (5000 + 9000 = 14000) would inflate the window every
    // turn. The newest envelope alone describes the newest prompt.
    const s = summarize([
      assistantMsg({ text: 30, tokens: usage(0, 0, 0, 5000, 0) }),
      assistantMsg({ text: 40, tokens: usage(0, 0, 0, 9000, 0) }),
    ]);

    assert.equal(s.context.used, 9000);
    assert.notEqual(s.context.used, 14000);
    assert.equal(s.context.method, "provider");
  });

  test("assistant bucket is scaled, not overwritten by telemetry output", () => {
    // Regression guard: the old implementation assigned
    // `buckets.assistant = tokens.output`, which broke the partition (B) and
    // smeared the difference into whichever bucket was largest. A 40k output
    // must not become a 40k segment inside a 10100-token context.
    const bigOutput = 40000;
    const s = summarize([
      userMsg(100),
      assistantMsg({
        text: 40,
        tools: [
          toolPart({
            name: "read",
            output: 500,
            input: { filePath: "C:/repo/a.ts" },
          }),
        ],
        tokens: usage(1000, bigOutput, 200, 9000, 100),
      }),
    ]);

    assert.equal(s.context.used, 10100);
    assert.notEqual(seg(s, "assistant").tokens, bigOutput);
    assert.ok(seg(s, "assistant").tokens < s.context.used);

    // Raw composition before scaling:
    //   history    = 100 (user text)
    //   assistant  = 40 (text) + 8 (the `read {…}` call line, 32 chars)
    //   others     = 500 (read output; `read` classifies as `others`)
    //   total      = 648
    // factor = measuredPrompt / estimatedPrompt = 10100 / 648
    const factor = 10100 / 648;
    assert.equal(seg(s, "assistant").tokens, Math.round(48 * factor));

    // Partition (B) still holds after the assistant bucket was scaled.
    assert.equal(partitionSum(s), s.context.used);
  });
});

// ===========================================================================
test.describe("method — how `used` was obtained", () => {
  test("no telemetry anywhere => method 'estimate', estimated true", () => {
    const s = summarize(estimateSession());
    assert.equal(s.context.method, "estimate");
    assert.equal(s.estimated, true);
    assert.ok(s.context.used > 0);
  });

  test("telemetry with nothing attributable => method 'unknown', fully unaccounted", () => {
    // The provider measured a 5000-token prompt but the transcript is empty,
    // so there is nothing to split. Inventing a split would be a lie; the
    // whole total is surfaced as `unaccounted` instead.
    const s = summarize([
      assistantMsg({ tokens: usage(5000, 0, 0, 0, 0) }),
    ]);

    assert.equal(s.context.method, "unknown");
    assert.equal(s.context.used, 5000);
    assert.equal(s.unaccounted, 5000);
    assert.equal(seg(s, "unaccounted").tokens, 5000);

    for (const meta of SEGMENT_META) {
      if (meta.key === "unaccounted") continue;
      assert.equal(seg(s, meta.key).tokens, 0, `${meta.key} must be 0`);
    }
  });
});

// ===========================================================================
test.describe("stale — the newest turn reported no usage", () => {
  test("stale is true when a turn after the newest reported one has no usage", () => {
    const s = summarize(staleSession());
    assert.equal(s.context.stale, true);
  });

  test("stale is false when the usage-less turn came FIRST", () => {
    // `stale` means "a turn NEWER than the newest reported one reported
    // nothing". A usage-less turn that came before the newest reported turn
    // is simply the oldest turn; the snapshot is still the latest one.
    const withTokens = assistantMsg({
      text: 50,
      tokens: usage(1000, 0, 0, 1000, 0),
    });
    const withoutTokens = assistantMsg({ text: 50 });

    const reported = summarize([withTokens, withoutTokens]);
    assert.equal(reported.context.stale, true);

    const oldest = summarize([withoutTokens, withTokens]);
    assert.equal(oldest.context.stale, false);
    assert.equal(oldest.context.method, "provider");
  });

  test("a single usage-less assistant is not stale and is not provider-anchored", () => {
    const s = summarize([assistantMsg({ text: 20 })]);
    assert.equal(s.context.stale, false);
    assert.notEqual(s.context.method, "provider");
    assert.equal(s.context.used, 20);
  });
});

// ===========================================================================
test.describe("B. the partition", () => {
  test("segments sum EXACTLY to context.used for every fixture", () => {
    // Invariant B: a mutually exclusive partition of `used`. Independent
    // rounding must never leave a gap or an overhang.
    const sessions: Record<string, unknown[]> = {
      provider: providerSession(),
      stale: staleSession(),
      compaction: compactionSession(),
      estimate: estimateSession(),
      manyOthers: manyOthersSession(6),
      mcp: mcpSession(),
      catalogOnly: catalogOnlySession(),
    };

    for (const [name, messages] of Object.entries(sessions)) {
      const s = summarize(messages);
      assert.equal(
        partitionSum(s),
        s.context.used,
        `${name}: partition ${partitionSum(s)} !== used ${s.context.used}`,
      );
      // `unaccounted` is a segment too, so the flat field must agree with it.
      assert.equal(s.unaccounted, seg(s, "unaccounted").tokens, name);
    }
  });

  test("no negative numbers anywhere in the payload", () => {
    // The scale factor is applied to every bucket, and `used` can end up
    // smaller than the raw estimate. A negative bar segment would render as
    // garbage and a negative `unaccounted` would break the partition.
    const sessions: Record<string, unknown[]> = {
      provider: providerSession(),
      compaction: compactionSession(),
      manyOthers: manyOthersSession(6),
      mcp: mcpSession(),
      catalogOnly: catalogOnlySession(),
      empty: [],
    };

    for (const [name, messages] of Object.entries(sessions)) {
      const s = summarize(messages);
      for (const d of s.segments) {
        assert.ok(d.tokens >= 0, `${name}/${d.key}.tokens = ${d.tokens}`);
      }
      assert.ok(s.unaccounted >= 0, `${name}: unaccounted = ${s.unaccounted}`);
      assert.ok(s.used >= 0, `${name}: used = ${s.used}`);
      for (const row of s.toolIO) {
        assert.ok(row.tokens >= 0, `${name}/${row.name}.tokens`);
        assert.ok(row.calls >= 0, `${name}/${row.name}.calls`);
      }
    }
  });

  test("percentages always state their denominator, or say null", () => {
    // A bare "0%" is a fabricated denominator. When the denominator is
    // unknown the field must be null so the UI can print "unknown".

    // used === 0 => pctOfUsed null for EVERY segment, including non-zero ones.
    const empty = summarize([], { limit: 200000 });
    assert.equal(empty.context.used, 0);
    for (const d of empty.segments) {
      assert.equal(d.pctOfUsed, null, `${d.key}.pctOfUsed should be null`);
    }

    // No limit => pctOfLimit null for every segment, even when used > 0.
    const noLimit = summarize(providerSession());
    assert.ok(noLimit.context.used > 0);
    assert.equal(noLimit.context.limit, null);
    for (const d of noLimit.segments) {
      assert.equal(d.pctOfLimit, null, `${d.key}.pctOfLimit should be null`);
      assert.notEqual(d.pctOfUsed, null, `${d.key}.pctOfUsed should be set`);
    }

    // With a limit, the two percentages describe the same share of two
    // different denominators: pctOfUsed = pctOfLimit * limit / used.
    const limit = 200000;
    const limited = summarize(providerSession(), { limit });
    assert.equal(limited.context.limit, limit);
    assert.notEqual(limited.context.pct, null);
    for (const d of limited.segments) {
      assert.notEqual(d.pctOfLimit, null, `${d.key}.pctOfLimit should be set`);
      assert.notEqual(d.pctOfUsed, null, `${d.key}.pctOfUsed should be set`);
      const expected =
        (d.pctOfLimit as number) * (limit / (limited.context.used as number));
      assert.ok(
        Math.abs((d.pctOfUsed as number) - expected) < 1e-9,
        `${d.key}: pctOfUsed ${d.pctOfUsed} !== pctOfLimit*limit/used ${expected}`,
      );
    }
  });
});

// ===========================================================================
test.describe("compaction fence", () => {
  test("everything strictly before the compaction entry is fenced out of the composition", () => {
    // compactionSession layout (index: entry)
    //   0: user 1000   <- fenced out
    //   1: assistant   <- fenced out (also loses its telemetry)
    //   2: user 2000   <- fenced out
    //   3: compaction(summary 700, recent 300)  <- the fence itself
    //   4: user 400    <- counted
    //   5: assistant   <- counted, reports the newest telemetry
    //
    // Composition after the fence:
    //   history   = 700 (summary) + 300 (recent) + 400 (post user) = 1400
    //   assistant = 300
    //   estimated = 1700
    // measuredPrompt = input 900 + cache.read 8000 + cache.write 0 = 8900
    // factor = 8900 / 1700
    //   history   ~= round(1400 * factor) = 7329
    //   assistant ~= round(300  * factor) = 1571
    //   sum       == 8900 == used, unaccounted == 0
    //
    // The pre-compaction user message contributed 1000 tokens. If it had NOT
    // been fenced, raw history would be 2400 and it would scale to
    // round(2400 * factor) = 12565 instead — so the two are distinguishable.
    const s = summarize(compactionSession());
    const factor = 8900 / 1700;

    assert.equal(s.counts.messages, 6);
    assert.equal(s.counts.compactionCount, 1);
    assert.equal(s.counts.excludedByCompaction, 3);

    assert.equal(seg(s, "history").tokens, Math.round(1400 * factor));
    assert.equal(seg(s, "assistant").tokens, Math.round(300 * factor));
    assert.ok(
      seg(s, "history").tokens < Math.round(2400 * factor),
      "history must NOT include the fenced-out pre-compaction 1000-token user text",
    );
    assert.equal(s.context.used, 8900);
  });

  test("compaction summary AND recent both count; either alone would differ", () => {
    // Two runs whose ONLY difference is how the same 1000 tokens of
    // post-compaction history are shaped. If `recent` were ignored, run A
    // would be 1700 raw and run B 1400 raw; if `summary` were ignored, run A
    // would be 1300 and run B 1600. Only summary+recent together gives 2000
    // in both, so the segment tokens must be identical.
    const tail = assistantMsg({
      text: 300,
      tokens: usage(900, 250, 0, 8000, 0),
    });

    const asUserText = summarize([
      userMsg(1000),
      compactionMsg(700, 300),
      userMsg(1000),
      tail,
    ]);
    const asCompaction = summarize([
      userMsg(1000),
      compactionMsg(400, 600),
      userMsg(1000),
      tail,
    ]);

    assert.deepEqual(
      asUserText.segments.map((d) => [d.key, d.tokens]),
      asCompaction.segments.map((d) => [d.key, d.tokens]),
      "summary+recent must be counted together, in either shape",
    );
    assert.equal(seg(asUserText, "history").tokens, seg(asCompaction, "history").tokens);
    // raw history = 700 + 300 + 1000 = 2000 in both runs.
    const factor = 8900 / 2300; // estimated = 2000 history + 300 assistant
    assert.equal(seg(asUserText, "history").tokens, Math.round(2000 * factor));
  });
});

// ===========================================================================
test.describe("segment routing — catalog vs mcps", () => {
  test("an injected Code Mode catalog routes to `catalog`, never `mcps`", () => {
    // The original bug: OpenCode injects the Code Mode tool catalog as a
    // `system` message, and folding it into `mcps` made the bar claim tens
    // of thousands of MCP output tokens for sessions where no MCP tool ever
    // ran (`toolTotals.mcps` was 0 while the segment showed 4000).
    const s = summarize(catalogOnlySession());

    assert.ok(seg(s, "catalog").tokens > 0);
    assert.equal(seg(s, "mcps").tokens, 0);
    assert.equal(s.toolTotals.mcps.tokens, 0);
    assert.equal(s.toolTotals.mcps.calls, 0);
    assert.equal(s.othersContributors.length, 0);

    // Raw: catalog 4000, history 20, assistant 30 => 4050.
    // measured = input 150 + cache.read 5000 = 5150.
    const factor = 5150 / 4050;
    assert.equal(seg(s, "catalog").tokens, Math.round(4000 * factor));
  });

  test("a `system` message whose text carries the '# Code Mode' heading routes to `catalog`", () => {
    // Routing must not depend on the `description` field alone: the heading
    // is in the body, and a plain/empty description is the realistic case.
    const s = summarize([
      {
        type: "system",
        description: "",
        text: `# Code Mode\n${w(2000)}`,
      },
    ]);

    assert.ok(seg(s, "catalog").tokens > 0);
    assert.equal(seg(s, "system").tokens, 0);
    assert.equal(seg(s, "mcps").tokens, 0);
  });

  test("`mcps` gets real MCP output when an MCP tool actually ran", () => {
    const s = summarize(mcpSession());

    assert.ok(seg(s, "mcps").tokens > 0);
    assert.ok(s.toolTotals.mcps.tokens > 0);
    assert.equal(s.toolTotals.mcps.calls, 1);
    assert.equal(toolRow(s, "context7_query-docs").category, "mcps");
  });

  test("`contributors.mcps` is populated once the MCP call is labelable", () => {
    // NOTE: `mcpSession()`'s MCP call only passes `libraryId`, which is not
    // one of toolLabel's hint keys (command/cmd/url/query/pattern/text), so
    // toolLabel returns "" and there is nothing to put in a drill-down row.
    // A real context7 call also carries `query`, which IS a hint key — so the
    // mcps drill-down is populated for real traffic. Asserted here so the
    // `mcps` pane is proven reachable rather than silently always empty.
    const s = summarize([
      userMsg(30),
      assistantMsg({
        tools: [
          toolPart({
            name: "context7_query-docs",
            output: 700,
            input: { libraryId: "/vercel/next.js", query: "app router caching" },
          }),
        ],
        tokens: usage(200, 80, 0, 3000, 0),
      }),
    ]);

    assert.ok(s.contributors.mcps.length >= 1);
    const row = s.contributors.mcps[0];
    assert.equal(row.category, "mcps");
    assert.equal(row.inContext, true);
    assert.equal(row.method, "estimated");
    assert.ok(row.tokens > 0);
  });
});

// ===========================================================================
test.describe("census, truncation, and skipped parts", () => {
  test("per-type counts reconcile with counts.messages, and steps mirrors assistants", () => {
    const c = summarize(compactionSession()).counts;

    assert.equal(
      c.userMessages +
        c.assistantMessages +
        c.systemMessages +
        c.syntheticMessages +
        c.compactionCount +
        c.ignoredMessages,
      c.messages,
    );
    assert.equal(c.steps, c.assistantMessages);
  });

  test("an unknown message type is counted as ignored, and the census still reconciles", () => {
    // An unrecognized `type` must not silently vanish from the census —
    // otherwise the per-type counts stop adding up to `messages`.
    const c = summarize([
      ...compactionSession(),
      { type: "mystery" },
    ]).counts;

    assert.equal(c.ignoredMessages, 1);
    assert.equal(c.messages, 7);
    assert.equal(
      c.userMessages +
        c.assistantMessages +
        c.systemMessages +
        c.syntheticMessages +
        c.compactionCount +
        c.ignoredMessages,
      c.messages,
    );
  });

  test("truncatedCalls counts calls OpenCode offloaded to disk", () => {
    const truncated = summarize([
      userMsg(10),
      assistantMsg({
        tools: [toolPart({ name: "read", output: 500, truncated: true })],
      }),
    ]);
    const row = toolRow(truncated, "read");
    assert.equal(row.calls, 1);
    assert.equal(row.truncatedCalls, 1);

    const notTruncated = summarize([
      userMsg(10),
      assistantMsg({
        tools: [toolPart({ name: "read", output: 500, truncated: false })],
      }),
    ]);
    const row2 = toolRow(notTruncated, "read");
    assert.equal(row2.calls, 1);
    assert.equal(row2.truncatedCalls, 0);
  });

  test("skippedParts counts non-text parts, and pending tool calls count for nothing", () => {
    const baseline = summarize([userMsg(10)]);
    assert.equal(baseline.skippedParts, 0);

    // User attachments (base64 blobs) occupy context but cannot be estimated,
    // so they are surfaced rather than silently dropped.
    const files = summarize([userMsg(10, ["a", "b"])]);
    assert.equal(files.skippedParts, 2);
    assert.equal(files.context.used, baseline.context.used);

    // An unmodelled content part inside an assistant message (images, files,
    // base64) is the same situation.
    const part = summarize([
      userMsg(10),
      assistantMsg({ tools: [{ type: "file", name: "x.png" }] }),
    ]);
    assert.equal(part.skippedParts, 1);

    // A tool call that has not completed has no output to count. It must NOT
    // be bucketed AND must not be reported as a skipped part — otherwise
    // every in-flight tool call would inflate `skippedParts`.
    const pending = summarize([
      userMsg(10),
      assistantMsg({
        tools: [
          toolPart({ name: "read", output: 500, status: "pending" }),
        ],
      }),
    ]);
    assert.equal(pending.skippedParts, 0);
    assert.equal(pending.toolIO.length, 0);
    assert.equal(pending.topTools.length, 0);
    assert.equal(partitionSum(pending), 10); // only the 10-token user text
  });
});

// ===========================================================================
test.describe("legacy aliases and cumulative session totals", () => {
  test("legacy flat fields mirror `context` exactly", () => {
    // Existing consumers still read `used` / `pct` / `limit` / `estimated`
    // off the top level. If they ever drift from `context`, two parts of the
    // UI would disagree about the same session.
    const cases: [string, SummaryResult][] = [
      ["provider", summarize(providerSession(), { limit: 200000, model: "m" })],
      ["estimate", summarize(estimateSession())],
      ["unknown", summarize([assistantMsg({ tokens: usage(5000, 0, 0, 0, 0) })])],
      ["empty", summarize([])],
    ];

    for (const [name, s] of cases) {
      assert.equal(s.used, s.context.used, name);
      assert.equal(s.pct, s.context.pct, name);
      assert.equal(s.limit, s.context.limit, name);
      assert.equal(s.estimated, s.context.method !== "provider", name);
    }
  });

  test("cumulative is null for an all-zero envelope and tagged when populated", () => {
    // Contract C: session totals are cumulative across every request and are
    // never mixed into `used`. An all-zero envelope means "no usage reported",
    // not "zero used" — reporting it would print a misleading 0-row block.
    const zero = summarize(providerSession(), {
      sessionTokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    assert.equal(zero.cumulative, null);

    const populated = summarize(providerSession(), {
      sessionTokens: {
        input: 12345,
        output: 6789,
        reasoning: 111,
        cache: { read: 22222, write: 333 },
      },
    });
    assert.ok(populated.cumulative);
    assert.equal(populated.cumulative!.scope, "session-cumulative");
    assert.equal(populated.cumulative!.input, 12345);
    assert.equal(populated.cumulative!.cacheRead, 22222);

    // And it stays separate from the window total.
    assert.equal(populated.context.used, 10100);
    assert.notEqual(populated.context.used, populated.cumulative!.input);
  });
});

// ===========================================================================
test.describe("attribution breadth", () => {
  test("othersContributors is unsliced so the catch-all cannot hide mass", () => {
    // The original bug: `others` was summarized with a top-3, which is why
    // 64% of it read as "unattributable" in the old UI. The drill-down must
    // list every distinct load, even when the top-level list is capped at 5.
    const s = summarize(manyOthersSession(6));

    assert.equal(s.othersContributors.length, 6);
    const labels = s.othersContributors.map((c) => c.label);
    for (let i = 0; i < 6; i++) {
      assert.ok(labels.includes(`echo run-${i}`), `missing contributor run-${i}`);
    }
    assert.ok(s.topTools.length <= 5);
  });
});

// ===========================================================================
test.describe("renderSummaryText — denominators and caveats", () => {
  test("every percentage states its denominator and tool I/O is labeled as an estimate", () => {
    const s = summarize(providerSession(), { limit: 200000, model: "test-model" });
    const text = renderSummaryText(s);

    // Headline: the exact string renderSummaryText builds for a known limit.
    // Asserted against the summary's own pct so the test pins the renderer's
    // wiring, not a hand-computed percentage.
    assert.notEqual(s.pct, null);
    assert.ok(
      text.includes(`(${s.pct!.toFixed(1)}% of window, test-model)`),
      `headline missing "of window" pct in:\n${text}`,
    );

    // Segment lines carry BOTH denominators explicitly.
    assert.ok(text.includes("of window"), `missing "of window" in:\n${text}`);
    assert.ok(text.includes("of used"), `missing "of used" in:\n${text}`);

    // Method is stated, never implied.
    assert.ok(text.includes("[provider-anchored]"), text);

    // Tool I/O must be labeled as returned-output estimates and explicitly
    // NOT presented as a share of used context (contract D).
    assert.ok(text.includes("Top tools, by RETURNED output, estimates"), text);
    assert.ok(text.includes("not shares of used context"), text);
    assert.ok(text.includes("Tool output by source (returned, estimated)"), text);
  });

  test("unknown denominators print 'unknown', not a fabricated 0%", () => {
    // No limit passed => the segment line must say the window share is
    // unknown rather than printing 0.0%.
    const text = renderSummaryText(summarize(providerSession()));
    assert.ok(text.includes("window share unknown"), text);
    assert.ok(text.includes("of used"), text);
    assert.ok(text.includes("model limit unknown"), text);
  });

  test("a stale provider session is marked stale in the rendered text", () => {
    const text = renderSummaryText(summarize(staleSession(), { limit: 200000 }));
    assert.ok(
      text.includes("[stale: newer turn reported no usage]"),
      `stale marker missing in:\n${text}`,
    );
    assert.ok(text.includes("[provider-anchored]"), text);
  });

  test("compaction and skipped-part caveats are stated explicitly", () => {
    const s = summarize([
      ...compactionSession(),
      userMsg(5, ["blob.png"]),
    ]);
    const text = renderSummaryText(s);

    assert.ok(
      text.includes("pre-compaction entries fenced out"),
      `compaction caveat missing in:\n${text}`,
    );
    assert.ok(
      text.includes("non-text parts skipped"),
      `skipped-parts caveat missing in:\n${text}`,
    );
  });

  test("cumulative totals are labeled as NOT the current window", () => {
    const text = renderSummaryText(
      summarize(providerSession(), {
        sessionTokens: {
          input: 12345,
          output: 6789,
          reasoning: 111,
          cache: { read: 22222, write: 333 },
        },
      }),
    );
    assert.ok(
      text.includes("cumulative across requests — NOT current window"),
      text,
    );
  });

  test("an 'estimate' session is labeled as estimates, an 'unknown' one as unattributed", () => {
    assert.ok(
      renderSummaryText(summarize(estimateSession())).includes("[estimates]"),
    );
    assert.ok(
      renderSummaryText(
        summarize([assistantMsg({ tokens: usage(5000, 0, 0, 0, 0) })]),
      ).includes("[unattributed]"),
    );
  });
});

// ===========================================================================
test.describe("D. tool-table coherence", () => {
  test("every toolIO row lands in exactly one topByCategory bucket, and totals agree", () => {
    // Invariant D: the tool breakdown must partition the same data the
    // segment buckets and the per-category totals describe. A row that is
    // missing from (or duplicated across) buckets means two views of the same
    // session disagree.
    const sessions: Record<string, SummaryResult> = {
      provider: summarize(providerSession()),
      manyOthers: summarize(manyOthersSession(6)),
      mcp: summarize(mcpSession()),
    };

    for (const [name, s] of Object.entries(sessions)) {
      // Each category bucket is capped at 10 rows; every fixture stays under
      // that, so the bucket sets must equal the toolIO sets exactly.
      const bucketed: { name: string; category: string }[] = [];
      for (const cat of TOOL_CATEGORIES) {
        for (const row of s.topByCategory[cat]) {
          assert.equal(row.category, cat, `${name}: row ${row.name} in wrong bucket`);
          bucketed.push({ name: row.name, category: row.category });
        }
      }

      assert.equal(
        bucketed.length,
        s.toolIO.length,
        `${name}: ${bucketed.length} bucketed rows vs ${s.toolIO.length} toolIO rows`,
      );
      for (const row of s.toolIO) {
        const matches = bucketed.filter(
          (b) => b.name === row.name && b.category === row.category,
        );
        assert.equal(
          matches.length,
          1,
          `${name}: ${row.name} [${row.category}] appears ${matches.length} times in topByCategory`,
        );
      }

      // And the per-category totals equal the sum over that category's rows.
      for (const cat of TOOL_CATEGORIES) {
        const fromRows = s.toolIO
          .filter((t) => t.category === cat)
          .reduce((sum, t) => sum + t.tokens, 0);
        const callsFromRows = s.toolIO
          .filter((t) => t.category === cat)
          .reduce((sum, t) => sum + t.calls, 0);
        assert.equal(s.toolTotals[cat].tokens, fromRows, `${name}/${cat}.tokens`);
        assert.equal(s.toolTotals[cat].calls, callsFromRows, `${name}/${cat}.calls`);
      }
    }
  });

  test("tool I/O tokens are not part of the context partition", () => {
    // Contract D: `toolIO` is reported on its own. Summing it against `used`
    // would double-count, because the same bytes already sit inside the
    // segment buckets via the transcript.
    const s = summarize(providerSession());
    const toolTokens = s.toolIO.reduce((sum, t) => sum + t.tokens, 0);
    assert.ok(toolTokens > 0);
    assert.notEqual(partitionSum(s), s.context.used + toolTokens);
    assert.equal(partitionSum(s), s.context.used);
  });
});