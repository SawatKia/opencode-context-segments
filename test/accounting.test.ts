/**
 * Accounting invariants for `analyze.ts` — regression, dedup, provider
 * independence, invalid-input safety, and rounding honesty.
 *
 * Conventions mirror `analyze.test.ts`: `w(n)` estimates to exactly n
 * tokens, imports use explicit `.ts` extensions, every test carries one
 * comment naming the invariant plus the bug it guards.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../analyze.ts";
import type { SummaryResult } from "../analyze.ts";
import {
  usage,
  userMsg,
  assistantMsg,
  toolPart,
  systemMsg,
  catalogSystemMsg,
} from "./fixtures.ts";

// --- local assertion helpers -------------------------------------------------

/** Look up one segment by key, failing loudly if the key drifted away. */
const seg = (s: SummaryResult, key: string) => {
  const found = s.segments.find((x) => x.key === key);
  assert.ok(found, `segment "${key}" is missing from s.segments`);
  return found;
};

/** Collect every finite-or-not number in the payload for safety sweeps. */
const walkNumbers = (value: unknown, out: number[]): void => {
  if (typeof value === "number") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkNumbers(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) walkNumbers(v, out);
  }
};

// ===========================================================================
// 1. REGRESSION arithmetic — six-bucket exact partition (six-bucket version).
// ===========================================================================

test.describe("accounting regression — six-bucket exact partition", () => {
  test("six content buckets estimate exactly [198499, 55196, 18573, 113741, 26768, 11560] and partition used exactly", () => {
    // Invariant: segments are a mutually exclusive, EXACT partition of
    // context.used (contract B). Guards: bucket-routing drift and the
    // tool-call overhead (`name + input` counted as assistant output) being
    // forgotten — the `read` call below contributes estimateTokens("read {}")
    // = 2 assistant tokens, so the text is sized 26766 to land 26768.
    const buckets = [198499, 55196, 18573, 113741, 26768, 11560];
    assert.equal(
      buckets.reduce((a, b) => a + b, 0),
      424337,
    ); // 198499+55196+18573+113741+26768+11560 === 424337
    const s = summarize(
      [
        systemMsg("base prompt", 198499), // -> system (plain desc, no routing tag)
        catalogSystemMsg(55196), // -> catalog (codemode/mcp-guidance desc)
        userMsg(18573), // -> history
        assistantMsg({
          text: 26766, // -> assistant, plus 2 for the `read {}` call itself
          reasoning: 11560, // -> reasoning
          tools: [toolPart({ name: "read", output: 113741, input: {} })], // -> others
          // No telemetry: method "estimate", so used === estimated sum exactly.
        }),
      ],
      { limit: 2000000 },
    );
    assert.equal(s.context.method, "estimate");
    assert.equal(s.context.used, 424337);
    assert.equal(s.used, 424337);
    assert.equal(seg(s, "system").tokens, 198499);
    assert.equal(seg(s, "catalog").tokens, 55196);
    assert.equal(seg(s, "history").tokens, 18573);
    assert.equal(seg(s, "others").tokens, 113741);
    assert.equal(seg(s, "assistant").tokens, 26768);
    assert.equal(seg(s, "reasoning").tokens, 11560);
    assert.equal(seg(s, "skills").tokens, 0);
    assert.equal(seg(s, "mcps").tokens, 0);
    assert.equal(seg(s, "rules").tokens, 0);
    assert.equal(s.unaccounted, 0);
    assert.equal(
      s.segments.reduce((sum, x) => sum + x.tokens, 0),
      s.context.used,
    );
  });
});

// ===========================================================================
// 2. OVERLAPPING contributions are not double-counted (skill-read variant:
//    the generic single-bucket case already exists in analyze.test.ts).
// ===========================================================================

test.describe("accounting dedup — a SKILL.md read lands in skills only", () => {
  test("read of a SKILL.md path routes to skills and is absent from others (control: plain path routes to others)", () => {
    // Invariant: every tool output lands in exactly one tool category
    // (contract D). Guards: classifying by tool NAME alone (`read` always
    // -> others), which would hide skill loads and double-count them if a
    // second heuristic also claimed them.
    const skillMsgs = [
      userMsg(30),
      assistantMsg({
        tools: [
          toolPart({
            name: "read",
            output: 700,
            input: { filePath: "C:/skills/my-skill/SKILL.md" },
          }),
        ],
      }),
    ];
    const controlMsgs = [
      userMsg(30),
      assistantMsg({
        tools: [
          toolPart({
            name: "read",
            output: 700,
            input: { filePath: "C:/repo/a.ts" },
          }),
        ],
      }),
    ];
    const skill = summarize(skillMsgs, {});
    const control = summarize(controlMsgs, {});
    // The same call is counted once: exactly one `read` row in toolIO.
    assert.equal(
      skill.toolIO.filter((t) => t.name === "read").length,
      1,
    );
    // Skill session: the 700 output tokens sit in skills, nowhere else.
    assert.equal(skill.toolTotals.skills.tokens, 700);
    assert.equal(skill.toolTotals.skills.calls, 1);
    assert.equal(skill.toolTotals.others.tokens, 0);
    assert.equal(skill.toolTotals.others.calls, 0);
    assert.equal(seg(skill, "skills").tokens, 700);
    assert.equal(seg(skill, "others").tokens, 0);
    // Control session: the same 700 tokens sit in others, skills stays empty.
    assert.equal(control.toolTotals.others.tokens, 700);
    assert.equal(control.toolTotals.skills.tokens, 0);
    assert.equal(seg(control, "others").tokens, 700);
    assert.equal(seg(control, "skills").tokens, 0);
  });
});

// ===========================================================================
// 3. PROVIDER independence — telemetry moves the headline, not the shape.
// ===========================================================================

test.describe("accounting provider independence", () => {
  test("different cache.read envelopes change used but preserve relative segment shares", () => {
    // Invariant: buckets are scaled uniformly to the provider total, so the
    // composition SHAPE is telemetry-independent (contract B). Guards: a
    // bucket being overwritten with server truth (e.g. assistant := output),
    // which would rewrite shares whenever the envelope changes.
    const transcript = (cacheRead: number) => [
      userMsg(100),
      assistantMsg({
        text: 40,
        tools: [toolPart({ name: "read", output: 500, input: { filePath: "C:/repo/a.ts" } })],
        tokens: usage(1000, 500, 200, cacheRead, 100),
      }),
    ];
    const a = summarize(transcript(9000), {});
    const b = summarize(transcript(15000), {});
    assert.equal(a.context.method, "provider");
    assert.equal(b.context.method, "provider");
    assert.equal(a.context.used, 10100); // 1000 + 9000 + 100
    assert.equal(b.context.used, 16100); // 1000 + 15000 + 100
    assert.equal(b.context.used - a.context.used, 6000);
    for (const meta of ["system", "history", "others", "assistant"] as const) {
      const shareA = seg(a, meta).tokens / a.context.used;
      const shareB = seg(b, meta).tokens / b.context.used;
      assert.ok(
        Math.abs(shareA - shareB) < 0.005,
        `${meta}: share moved with telemetry (${shareA} vs ${shareB})`,
      );
    }
  });
});

// ===========================================================================
// 4. INVALID inputs — never NaN/Infinity/negative, never throws.
// ===========================================================================

test.describe("accounting invalid inputs", () => {
  test("sessionTokens with NaN/negative values yields null or clamped cumulative, never NaN", () => {
    // Invariant: cumulative session totals are defensive (contract C).
    // Guards: NaN poisoning the cumulative block (or the whole payload) when
    // the server reports a malformed tokens envelope.
    const allBad = summarize([userMsg(10)], {
      sessionTokens: {
        input: NaN,
        output: -5,
        reasoning: NaN,
        cache: { read: -1, write: NaN },
      },
    });
    assert.equal(allBad.cumulative, null);
    const mixed = summarize([userMsg(10)], {
      sessionTokens: {
        input: 100,
        output: NaN,
        reasoning: -3,
        cache: { read: 50, write: -2 },
      },
    });
    assert.deepEqual(mixed.cumulative, {
      input: 100,
      output: 0,
      reasoning: 0,
      cacheRead: 50,
      cacheWrite: 0,
      scope: "session-cumulative",
    });
    for (const s of [allBad, mixed]) {
      const nums: number[] = [];
      walkNumbers(s, nums);
      for (const n of nums) assert.ok(Number.isFinite(n), `non-finite: ${n}`);
    }
  });

  test("limit -5 and NaN are treated as unknown: pct null everywhere, never throws or negative", () => {
    // Invariant: percentages always state their denominator or say null.
    // Guards: a garbage limit producing NaN/negative headline pcts or a
    // throw in the pct/remaining math.
    for (const limit of [-5, NaN]) {
      const s = summarize(
        [
          userMsg(100),
          assistantMsg({
            text: 40,
            tokens: usage(1000, 500, 200, 9000, 100),
          }),
        ],
        { limit },
      );
      assert.equal(s.context.limit, null);
      assert.equal(s.context.pct, null);
      assert.equal(s.pct, null);
      assert.equal(s.context.remaining, null);
      for (const d of s.segments) assert.equal(d.pctOfLimit, null);
      const nums: number[] = [];
      walkNumbers(s, nums);
      assert.ok(nums.length > 0);
      for (const n of nums) {
        assert.ok(Number.isFinite(n), `limit ${String(limit)}: non-finite ${n}`);
        assert.ok(n >= 0, `limit ${String(limit)}: negative ${n}`);
      }
    }
  });

  test("tokens envelope with negative numbers is clamped to >= 0 everywhere", () => {
    // Invariant: the partition contains no negative numbers (contract B).
    // Guards: a negative provider envelope leaking into used, segments,
    // unaccounted, or toolIO rows.
    const s = summarize(
      [
        userMsg(100),
        assistantMsg({
          text: 40,
          tools: [toolPart({ name: "read", output: 500, input: { filePath: "C:/repo/a.ts" } })],
          tokens: usage(1000, -50, -10, -9000, -5),
        }),
      ],
      { limit: 200000 },
    );
    // Negatives clamp to 0, so used === input only.
    assert.equal(s.context.used, 1000);
    assert.ok(s.context.used >= 0);
    assert.ok(s.unaccounted >= 0);
    for (const d of s.segments) assert.ok(d.tokens >= 0, `${d.key} negative`);
    for (const t of s.toolIO) assert.ok(t.tokens >= 0, `${t.name} negative`);
    for (const cat of Object.keys(s.toolTotals)) {
      assert.ok(s.toolTotals[cat].tokens >= 0, `${cat} negative`);
    }
    const nums: number[] = [];
    walkNumbers(s, nums);
    for (const n of nums) {
      assert.ok(Number.isFinite(n), `non-finite: ${n}`);
      assert.ok(n >= 0, `negative: ${n}`);
    }
  });
});

// ===========================================================================
// 5. ROUNDING honesty — percentages are lossy display, tokens authoritative.
// ===========================================================================

test.describe("accounting rounding honesty", () => {
  test("one-decimal pctOfUsed cannot reconstruct tokens: tokens are integers, percentages lossy", () => {
    // Invariant: token counts are authoritative integers; pctOfUsed is a
    // lossy display value. Guards: replacing stored counts with
    // percentage-derived rounded values (which would silently drift by
    // ~10 tokens here: 33.3% of 30000 is 9990, not 10000).
    const s = summarize([userMsg(10000), assistantMsg({ text: 20000 })], {});
    assert.equal(s.context.used, 30000);
    for (const d of s.segments) {
      assert.ok(Number.isInteger(d.tokens), `${d.key} not an integer`);
    }
    const history = seg(s, "history");
    assert.equal(history.tokens, 10000);
    assert.ok(history.pctOfUsed !== null);
    const reconstructed = Math.round(
      (Number((history.pctOfUsed as number).toFixed(1)) / 100) * s.context.used,
    );
    assert.notEqual(
      reconstructed,
      history.tokens,
    );
  });
});
