/**
 * Structural regression tests for the render-leak bug CLASS.
 *
 * THE BUG THAT PROMPTED THIS FILE
 * ------------------------------
 * `tui.tsx:1016` interpolated an arrow function without calling it:
 *
 *     header={`${seg.label} ${w()} (${u}) (${formatNumber(seg.tokens))`}
 *
 * `u` is `const u = () => ...`. Written as `${u}`, JS coerced the function
 * through `String(fn)` and rendered the literal source text
 * `() => seg.pctOfUsed !== null && ...` into user-visible text. Fixed to
 * `${u()}`.
 *
 * WHY A STRUCTURAL TEST AND NOT A RUNTIME TEST
 * --------------------------------------------
 * `test/analyze.test.ts` imports only `../analyze.ts`, so nothing exercised the
 * other two renderers. A runtime test is not available for them:
 *   - `tui.tsx` needs the Solid JSX runtime plus `@opencode/plugin/tui`;
 *   - `web.ts` builds an HTML page whose render lives inside a nested template
 *     literal that cannot be extracted under `node:test`.
 * So this file reads the renderer sources off disk and audits them directly.
 * That is deliberate: a leak is a *structural* defect (an interpolation missing
 * its call parens), and a structural defect has a structural detector.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. No uncalled-function interpolation — neither `${ident}` in a template
 *      literal nor `+ ident +` / `ident +` string concatenation, where the file
 *      declares `ident` as a function in the enclosing scope.
 *   2. No reverse leak — `${ident()}` / `ident()` where the enclosing scope
 *      declares `ident` only as a string/number const.
 *   3. `renderSummaryText` output exposes no implementation expression
 *      (`=>`, `${`, `??`, `?.`, `undefined`, `NaN`, `Infinity`,
 *      `[object Object]`, `void 0`).
 *   4. Every non-zero segment row states an explicit denominator.
 *
 * SCOPE HANDLING (and why it is not a cop-out)
 * -------------------------------------------
 * `tui.tsx` used to declare `w` and `u` twice: as string consts inside
 * `formatSummaryText` and as arrow functions inside `DetailBody`. The dialog
 * refactor removed the `DetailBody` arrow functions (segment rows now render
 * `Label tokens · X% of used`), so only the `formatSummaryText` string consts
 * remain. A naive file-wide scan would still find *both* `u`es "declared" for
 * historical sources with shadowing, and can only guess. Guessing wrong here
 * is the worst possible outcome: it either misses the real bug (silently
 * skipping every `${u}`) or invents a false positive on a legitimate `${w}`.
 *
 * So identifiers are resolved by BRACE SCOPE: every `{...}` is turned into a
 * range, every declaration records the chain of ranges that encloses it, and an
 * interpolation only sees the declarations whose whole chain encloses it. When
 * the deepest surviving declarations disagree, the name is genuinely ambiguous
 * and is SKIPPED — but the ambiguous names are reported in the failure message
 * so a human can eyeball them. Skipping-with-reporting is the conservative
 * branch; scope resolution is what makes the check sharp enough to actually
 * catch `tui.tsx:1016`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarize, renderSummaryText } from "../analyze.ts";
import {
  providerSession,
  catalogOnlySession,
  manyOthersSession,
  compactionSession,
  estimateSession,
} from "./fixtures.ts";

const ROOT = new URL("../", import.meta.url);

/** Every module that renders user-visible text. */
const RENDERERS = [
  "analyze.ts",
  "tui.tsx",
  "web.ts",
  "index.ts",
  "rpc-def.ts",
] as const;

// ---------------------------------------------------------------------------
// Minimal JS/TS scanner. No dependency, no parser — just enough fidelity to
// (a) blank comments without moving offsets, (b) find `{}` ranges, and (c) find
// `${...}` regions inside template literals.
// ---------------------------------------------------------------------------

/**
 * A JS single/double-quoted string cannot span a raw newline, so an unclosed
 * quote before EOL is treated as a prose apostrophe (JSX text like
 * `That's why`) rather than swallowing the rest of the file.
 */
function skipSimpleQuote(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    if (src[j] === "\n") return i + 1;
    j++;
  }
  return i + 1;
}

/** Index just past the closing backtick of the template literal at `start`. */
function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (depth === 0 && c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "`") {
        i = skipTemplate(src, i);
        continue;
      } else if (c === '"' || c === "'") {
        i = skipSimpleQuote(src, i);
        continue;
      }
    }
    i++;
  }
  return i;
}

/** 1-based line number of a character offset. */
function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

/**
 * Replace comment bodies with spaces, leaving every other character (and every
 * offset) untouched so findings can be reported as real line/column numbers.
 */
function maskComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(src.length, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipSimpleQuote(src, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    i++;
  }
  return out.join("");
}

interface Range {
  start: number;
  end: number;
}

/** Brace-delimited ranges, as scope containers. */
function findBlocks(masked: string): Range[] {
  const blocks: Range[] = [];
  const stack: number[] = [];
  let i = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      i = skipSimpleQuote(masked, i);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(masked, i);
      continue;
    }
    if (c === "{") stack.push(i);
    else if (c === "}") {
      const open = stack.pop();
      if (open !== undefined) blocks.push({ start: open, end: i });
    }
    i++;
  }
  return blocks.sort((a, b) => a.start - b.start);
}

/** Enclosing block ranges at `offset`, innermost (deepest) first. */
function chainAt(blocks: Range[], offset: number): Range[] {
  const hits: Range[] = [];
  for (const b of blocks) {
    if (b.start < offset && offset < b.end) hits.push(b);
  }
  hits.sort((a, b) => a.end - a.start - (b.end - b.start));
  return hits;
}

// ---------------------------------------------------------------------------
// Declaration scanning
// ---------------------------------------------------------------------------

type Kind = "function" | "primitive" | "other";

interface Decl {
  name: string;
  kind: Kind;
  offset: number;
  chain: Range[];
}

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const RE_FUNCTION = new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`, "g");
const RE_BINDING = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=`, "g");
const RE_ARROW = new RegExp(
  `^\\s*(?:async\\s+)?(?:function\\b|\\*\\s*function\\b|(?:async\\s*)?\\([^)]*\\)\\s*(?::\\s*[^=;]+?)?=>|${IDENT}\\s*=>)`,
);
const RE_PRIMITIVE = new RegExp(
  `^\\s*(?:"[^"\\n]*"|'[^'\\n]*'|\`[^\`]*\`|[-+]?(?:\\d[\\d_]*)?\\.?\\d+(?:[eE][-+]?\\d+)?)(?![\\w.])`,
);

/**
 * Split an initializer at its first depth-0 ternary `?:` (brackets, quotes and
 * template literals skipped). `tui.tsx`'s `const u = cond ? "…" : "…"` needs
 * this: its value does not *start* with a literal, but it is still a string.
 */
function topLevelTernary(v: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  let tick = false;
  let qPos = -1;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (tick) {
      if (c === "\\") i++;
      else if (c === "`") tick = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "`") {
      tick = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      if (c === "?" && v[i + 1] !== "." && v[i + 1] !== "?") qPos = i;
      else if (c === ":" && qPos >= 0) return [v.slice(qPos + 1, i), v.slice(i + 1)];
    }
  }
  return null;
}

/** Split an initializer at its first depth-0 `||` / `??`. */
function topLevelLogical(v: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  let tick = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (tick) {
      if (c === "\\") i++;
      else if (c === "`") tick = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "`") {
      tick = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      if (c === "|" && v[i + 1] === "|") return [v.slice(0, i), v.slice(i + 2)];
      if (c === "?" && v[i + 1] === "?" && v[i + 2] !== "=") {
        return [v.slice(0, i), v.slice(i + 2)];
      }
    }
  }
  return null;
}

/**
 * Classify a binding's initializer. Only two answers are trusted:
 * `function` and `primitive`. Anything the scanner cannot prove is `other`,
 * and `other` declarations are simply never matched by either invariant — an
 * honest "I don't know" rather than a guess.
 */
function classifyValue(value: string): Kind {
  const v = value.trim();
  if (RE_ARROW.test(v)) return "function";
  if (RE_PRIMITIVE.test(v)) return "primitive";
  for (const split of [topLevelTernary, topLevelLogical]) {
    const parts = split(v);
    if (!parts) continue;
    return classifyValue(parts[0]) === "primitive" &&
      classifyValue(parts[1]) === "primitive"
      ? "primitive"
      : "other";
  }
  return "other";
}

function collectDecls(masked: string, blocks: Range[]): Decl[] {
  const decls: Decl[] = [];
  const push = (name: string, kind: Kind, offset: number) => {
    decls.push({ name, kind, offset, chain: chainAt(blocks, offset) });
  };

  for (const m of masked.matchAll(RE_FUNCTION)) {
    push(m[1], "function", m.index);
  }
  for (const m of masked.matchAll(RE_BINDING)) {
    const eq = m.index + m[0].length - 1;
    const value = masked.slice(eq + 1, eq + 400);
    const kind = classifyValue(value);
    // Kinds we cannot classify are recorded as "other" and simply never match,
    // which keeps the audit honest about what it does and does not know.
    if (kind !== "other") push(m[1], kind, m.index);
  }
  return decls;
}

type Resolution =
  | { kind: "function" }
  | { kind: "primitive" }
  | { kind: "unresolved" }
  | { kind: "ambiguous"; offsets: number[] };

/**
 * Resolve `name` as seen from `offset`: keep only declarations whose ENTIRE
 * enclosing brace chain also encloses `offset`, then take the deepest
 * survivors. Disagreement at the deepest level is genuine ambiguity.
 */
function resolve(
  decls: Decl[],
  offset: number,
  name: string,
): Resolution {
  const inScope = decls.filter(
    (d) =>
      d.name === name &&
      d.chain.every((r) => r.start < offset && offset < r.end),
  );
  if (inScope.length === 0) return { kind: "unresolved" };
  const deepest = Math.max(...inScope.map((d) => d.chain.length));
  const survivors = inScope.filter((d) => d.chain.length === deepest);
  const kinds = new Set(survivors.map((d) => d.kind));
  if (kinds.size > 1) {
    return { kind: "ambiguous", offsets: survivors.map((d) => d.offset) };
  }
  return { kind: survivors[0].kind };
}

// ---------------------------------------------------------------------------
// Interpolation / concatenation scanning
// ---------------------------------------------------------------------------

interface Site {
  ident: string;
  offset: number;
  expr: string;
}

/** Every `${...}` region in `masked`, including regions nested in sub-templates. */
function templateSites(masked: string): Site[] {
  const sites: Site[] = [];

  const walk = (start: number) => {
    let i = start + 1;
    while (i < masked.length) {
      const c = masked[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") return;
      if (c === "$" && masked[i + 1] === "{") {
        const exprStart = i + 2;
        let j = exprStart;
        let depth = 0;
        while (j < masked.length) {
          const d = masked[j];
          if (d === "{") depth++;
          else if (d === "}") {
            if (depth === 0) break;
            depth--;
          } else if (d === "`") {
            walk(j);
            j = skipTemplate(masked, j);
            continue;
          } else if (d === '"' || d === "'") {
            j = skipSimpleQuote(masked, j);
            continue;
          }
          j++;
        }
        sites.push({
          ident: "",
          offset: exprStart,
          expr: masked.slice(exprStart, j),
        });
        i = j + 1;
        continue;
      }
      i++;
    }
  };

  let i = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      i = skipSimpleQuote(masked, i);
      continue;
    }
    if (c === "`") {
      walk(i);
      i = skipTemplate(masked, i);
      continue;
    }
    i++;
  }
  return sites;
}

/** Split each interpolation into (root identifier, is-it-called). */
function readRoot(expr: string): { ident: string; called: boolean } | null {
  const m = new RegExp(`^\\s*(${IDENT})`).exec(expr);
  if (!m) return null; // `${(() => …)()}`, `${a + b}`-style starts, literals…
  const rest = expr.slice(m[0].length);
  const cleaned = /^\s*!*[\s!]*/.exec(rest)![0];
  const tail = rest.slice(cleaned.length);
  return { ident: m[1], called: tail.startsWith("(") || tail.startsWith("?.") };
}

/** `+ ident +`, `ident +`, `+ ident` — the string-concatenation spelling. */
function concatSites(masked: string): Site[] {
  const out: Site[] = [];
  const seen = new Set<number>();
  const add = (ident: string, offset: number, expr: string) => {
    if (seen.has(offset)) return;
    seen.add(offset);
    out.push({ ident, offset, expr });
  };
  const right = new RegExp(`\\+(?!\\+)\\s*(${IDENT})(?![\w$])`, "g");
  for (const m of masked.matchAll(right)) {
    add(m[1], m.index, `+ ${m[1]}`);
  }
  const left = new RegExp(`(${IDENT})(?![\w$])\\s*\\+(?!\\+)`, "g");
  for (const m of masked.matchAll(left)) {
    add(m[1], m.index + m[1].length, `${m[1]} +`);
  }
  return out;
}

/** Every `ident(` call site whose callee is a bare identifier. */
function callSites(masked: string): Site[] {
  const out: Site[] = [];
  const re = new RegExp(`(${IDENT})(?![\\w$.])\\s*\\(`, "g");
  for (const m of masked.matchAll(re)) {
    out.push({ ident: m[1], offset: m.index, expr: `${m[1]}(` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-file audit
// ---------------------------------------------------------------------------

interface Audit {
  file: string;
  src: string;
  masked: string;
  decls: Decl[];
}

function audit(file: string): Audit {
  const src = readFileSync(new URL(file, ROOT), "utf8");
  const masked = maskComments(src);
  const blocks = findBlocks(masked);
  return { file, src, masked, decls: collectDecls(masked, blocks) };
}

const AUDITS = RENDERERS.map(audit);
const ALL = AUDITS.map((a) => a.file);

const at = (a: Audit, offset: number) =>
  `${a.file}:${lineOf(a.src, offset)}`;

// ---------------------------------------------------------------------------
// Invariant 1 — no uncalled-function interpolation
// ---------------------------------------------------------------------------

test.describe("invariant 1: no uncalled-function interpolation", () => {
  /** Protects the `${u}` bug class: an interpolated function without `()`. */
  test("no renderer interpolates or concatenates a function without calling it", () => {
    const leaks: string[] = [];
    const ambiguousByFile = new Map<string, Set<string>>();

    for (const a of AUDITS) {
      for (const site of [...templateSites(a.masked), ...concatSites(a.masked)]) {
        const root = readRoot(site.expr);
        if (!root || root.called) continue;
        const res = resolve(a.decls, site.offset, root.ident);
        if (res.kind === "function") {
          leaks.push(
            `LEAK ${at(a, site.offset)}: ${root.ident} is a function here but ` +
              `is interpolated/concatenated without (). JS coerces it via ` +
              `String(fn) and renders its source text to the user.\n` +
              `      expression: ${site.expr.trim()}`,
          );
        } else if (res.kind === "ambiguous") {
          const set = ambiguousByFile.get(a.file) ?? new Set<string>();
          set.add(root.ident);
          ambiguousByFile.set(a.file, set);
        }
      }
    }

    const report = [
      ...ambiguousByFile.entries().map(
        ([file, names]) =>
          `\n  ambiguous in ${file} (skipped, eyeball these): ${[...names].sort().join(", ")}`,
      ),
    ].join("");

    assert.deepEqual(
      leaks,
      [],
      `Found ${leaks.length} uncalled-function interpolation(s) in: ${ALL.join(", ")}` +
        report,
    );
  });

  /**
   * Guards the scope resolver itself. If this breaks, invariant 1 silently
   * degrades into a no-op wherever a name is shadowed (every `${u}`/`${w}`
   * skipped as ambiguous) — exactly the failure mode that let the bug ship.
   */
  test("tui.tsx `u`/`w` resolve per enclosing scope, not file-wide", () => {
    const tui = AUDITS[ALL.indexOf("tui.tsx")];
    assert.ok(tui, "tui.tsx must be part of the audit");

    // The dialog refactor removed DetailBody's arrow-function `u`/`w`
    // (segment rows now render `Label tokens · X% of used` via `pctOfUsed`),
    // so no production shadowing is left to anchor on. Pin the resolver with
    // a minimal synthetic case instead: one brace scope declares `u` as a
    // string const, a sibling scope declares `u` as an arrow function, and
    // resolve() must distinguish the two use sites.
    const synth = [
      "function outer() {",
      '  { const u = "share unknown"; console.log(`${u}`); }',
      "  { const u = () => 42; console.log(`${u()}`); }",
      "}",
    ].join("\n");
    const synthMasked = maskComments(synth);
    const synthBlocks = findBlocks(synthMasked);
    const synthDecls = collectDecls(synthMasked, synthBlocks);
    const useStr = synth.indexOf("`${u}`");
    const useFn = synth.indexOf("`${u()}`");
    assert.ok(useStr >= 0 && useFn >= 0, "synthetic anchors must exist");
    assert.equal(resolve(synthDecls, useStr, "u").kind, "primitive");
    assert.equal(resolve(synthDecls, useFn, "u").kind, "function");

    // `${w}` / `${u}` in formatSummaryText are string consts — not leaks.
    const text = tui.src.indexOf("- ${seg.label} ${w} (${u})");
    assert.ok(text >= 0, "expected to locate the formatSummaryText segment row");
    assert.equal(resolve(tui.decls, text, "u").kind, "primitive");
    assert.equal(resolve(tui.decls, text, "w").kind, "primitive");
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — no reverse leak
// ---------------------------------------------------------------------------

test.describe("invariant 2: no reverse leak (calling a string/number const)", () => {
  /** `${w()}` where `w` is `"window share unknown"` must fail, not render "". */
  test("no renderer calls a name that the enclosing scope declares as a const", () => {
    const leaks: string[] = [];
    for (const a of AUDITS) {
      for (const site of callSites(a.masked)) {
        if (resolve(a.decls, site.offset, site.ident).kind === "primitive") {
          leaks.push(
            `REVERSE LEAK ${at(a, site.offset)}: ${site.ident}() is called but ` +
              `the enclosing scope declares ${site.ident} as a string/number const.`,
          );
        }
      }
    }
    assert.deepEqual(
      leaks,
      [],
      `Found ${leaks.length} call(s) on string/number consts in: ${ALL.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariants 3 & 4 — rendered output
// ---------------------------------------------------------------------------

const FIXTURES: [string, () => unknown[]][] = [
  ["providerSession", providerSession],
  ["catalogOnlySession", catalogOnlySession],
  ["manyOthersSession(7)", () => manyOthersSession(7)],
  ["compactionSession", compactionSession],
  ["estimateSession", estimateSession],
];

/** Render each fixture twice: no model limit, and with one (both code paths). */
function renderAll(): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, make] of FIXTURES) {
    for (const [variant, opts] of [
      ["no-limit", {}],
      ["with-limit", { limit: 200_000, model: "test-model" }],
    ] as const) {
      const summary = summarize(make(), opts as never);
      out.push([`${name} / ${variant}`, renderSummaryText(summary)]);
    }
  }
  return out;
}

/** Substrings that can only appear if an implementation expression leaked. */
const IMPLEMENTATION_LEAKS = [
  "=>", // String(arrowFn)
  "() =>", // String(arrowFn), spelled out
  "void 0", // `${undefined}`
  "${", // un-interpolated template source
  "??", // raw nullish coalescing operator
  "?.", // raw optional chain
  "[object Object]", // String({})
  "NaN",
  "undefined",
  "Infinity",
];

/** Rows produced by `barLine`, identified by their block-drawing characters. */
function segmentRows(text: string): string[] {
  return text.split("\n").filter((l) => l.includes("█") || l.includes("░"));
}

test.describe("invariant 3: rendered output exposes no implementation expression", () => {
  /** Guards against a value that renders source text instead of a number. */
  test("renderSummaryText never emits a leaked JS expression", () => {
    const offenders: string[] = [];
    for (const [label, text] of renderAll()) {
      for (const sub of IMPLEMENTATION_LEAKS) {
        if (text.includes(sub)) {
          const at2 = text.indexOf(sub);
          offenders.push(
            `${label}: found ${JSON.stringify(sub)} at offset ${at2}: ` +
              `…${text.slice(Math.max(0, at2 - 40), at2 + 40).replace(/\n/g, "\\n")}…`,
          );
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  /** The full proposed set is kept: all ten hold on every fixture today. */
  test("the forbidden-substring set is exactly the one the fixtures tolerate", () => {
    assert.deepEqual(IMPLEMENTATION_LEAKS, [
      "=>",
      "() =>",
      "void 0",
      "${",
      "??",
      "?.",
      "[object Object]",
      "NaN",
      "undefined",
      "Infinity",
    ]);
  });
});

test.describe("invariant 4: every renderer states a denominator", () => {
  /**
   * A bare `NN.N%` with no denominator is a reader trap: 15% of what? The
   * segment rows must name `of window` or `of used` every time.
   */
  test("each non-zero segment row carries an explicit denominator", () => {
    const offenders: string[] = [];
    for (const [label, text] of renderAll()) {
      const rows = segmentRows(text);
      if (rows.length === 0) offenders.push(`${label}: rendered zero segment rows`);
      for (const row of rows) {
        if (!/of window|of used/.test(row)) {
          offenders.push(`${label}: row has no denominator: ${JSON.stringify(row)}`);
          continue;
        }
        // The post-label tail must carry an explicit `NN.N% of window|used`.
        const tail = row.slice(row.lastIndexOf("—") + 1);
        if (!/\d+\.\d% of (window|used)/.test(tail)) {
          offenders.push(
            `${label}: row ends without a denominated percentage: ${JSON.stringify(row)}`,
          );
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  /** Ties the row count to the data so the denominator check cannot vacuously pass. */
  test("segment row count equals the number of non-zero segments", () => {
    for (const [name, make] of FIXTURES) {
      for (const opts of [{}, { limit: 200_000, model: "test-model" }]) {
        const summary = summarize(make(), opts as never);
        const expected = summary.segments.filter((s) => s.tokens > 0).length;
        const actual = segmentRows(renderSummaryText(summary)).length;
        assert.equal(
          actual,
          expected,
          `${name} (${JSON.stringify(opts)}): expected ${expected} segment rows, got ${actual}`,
        );
        assert.ok(expected > 0, `${name}: fixture produced no non-zero segments`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Dialog-copy regression: the dialog refactor removed a set of default-view
// prose strings. If any of them reappears, the refactor has regressed.
// ---------------------------------------------------------------------------

test.describe("dialog-copy regression: removed default-view prose stays gone", () => {
  /**
   * NOTE on the three candidate strings deliberately NOT in BANNED:
   *   - "provider-anchored" remains as legitimate user-visible copy: the
   *     copy-text `[provider-anchored]` method tag (formatSummaryText) and
   *     the assistant-segment sub-line in DetailBody
   *     ("provider-anchored total when available").
   *   - "registry-classified" / "name-heuristic" remain in the
   *     formatSummaryText top-tools header, mirroring the server's
   *     renderSummaryText (analyze.ts) classifier-source labels.
   * None of the three is removed default-view prose, so none is asserted here.
   */
  test("masked tui.tsx source contains none of the removed prose strings", () => {
    const tui = AUDITS[ALL.indexOf("tui.tsx")];
    assert.ok(tui, "tui.tsx must be part of the audit");
    const BANNED = [
      "partition of used context",
      "not window shares",
      "do not read as window",
      "No per-item rows recorded",
    ];
    // Assert on the comment-stripped source so a banned string hiding inside
    // a comment cannot slip past (and so comments cannot trip the check).
    const found = BANNED.filter((s) => tui.masked.includes(s));
    assert.deepEqual(
      found,
      [],
      `removed default-view prose reappeared in tui.tsx: ${found.join(", ")}`,
    );
  });

  /** The DetailBody segment header must keep its explicit `% of used` denominator. */
  test("DetailBody segment header template contains '% of used'", () => {
    const tui = AUDITS[ALL.indexOf("tui.tsx")];
    assert.ok(tui, "tui.tsx must be part of the audit");
    const forAnchor = tui.src.indexOf("<For each={s().segments");
    assert.ok(forAnchor >= 0, "expected to locate the DetailBody segment For loop");
    const region = tui.src.slice(forAnchor, forAnchor + 3000);
    const headerLine = region
      .split("\n")
      .find((l) => l.includes("const header ="));
    assert.ok(headerLine, "expected to locate the DetailBody segment header template");
    assert.ok(
      headerLine.includes("pctOfUsed"),
      `segment header template must interpolate the used-share: ${headerLine.trim()}`,
    );
    assert.ok(
      region.includes("% of used"),
      "segment header denominator must read '% of used'",
    );
  });
});