/**
 * context-segments — index.ts (server entrypoint, auto-discovered).
 *
 * - RPC `context-segments`: getSummary / getSkills / startWeb / stopWeb
 *   / postSummary (+ `stats` event) consumed by the TUI (`tui.tsx`).
 * - Agent tools: `context_usage`, `skill_stats`.
 * - Slash commands: `/context`, `/context-skills` (append `web` for the
 *   loopback dashboard).
 * - Skill tracking: `session.skill.activated` events + one-time transcript
 *   backfill per session, persisted in `ctx.storage`.
 */

import { Plugin } from "@opencode/plugin";
import { csegRpc } from "./rpc-def.js";
import {
  summarize,
  renderSummaryText,
  renderSkillsText,
  estimateTokens,
  type GlobalSkillDatum,
} from "./analyze.js";
import {
  startDashboard,
  stopDashboard,
  dashboardRunning,
} from "./web.js";

const GLOBAL_KEY = "cseg:skills:global:v1";
const backfillKey = (sessionID: string) => `cseg:backfill:${sessionID}:v1`;

interface GlobalStore {
  skills: Record<string, { id: string; name: string; count: number; lastUsed: number; estTokens: number }>;
  updated: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function openBrowserBestEffort(url: string): boolean {
  try {
    const spawned = (globalThis as Record<string, unknown>).Bun as
      | {
          spawn?: (args: string[], opts?: unknown) => unknown;
          spawnSync?: unknown;
        }
      | undefined;
    if (spawned && typeof spawned.spawn === "function") {
      try {
        const proc = spawned.spawn(
          process.platform === "win32"
            ? ["cmd", "/c", "start", "", url]
            : process.platform === "darwin"
              ? ["open", url]
              : ["xdg-open", url],
          {
            stdio: ["ignore", "ignore", "ignore"],
          },
        ) as unknown as { unref?: unknown; on?: unknown };
        if (proc && typeof proc.unref === "function") {
          (proc as { unref: () => void }).unref();
        }
      } catch {
        return false;
      }
      return true;
    }
  } catch {
    // fall through to child_process
  }
  try {
    // A floating promise with no rejection handler can take the server down
    // as an unhandled rejection — the .catch + in-callback guards close it.
    void import("node:child_process")
      .then(({ spawn }) => {
        try {
          const args =
            process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : process.platform === "darwin"
                ? ["open", url]
                : ["xdg-open", url];
          const [cmd, ...rest] = args;
          const child = spawn(cmd, rest, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.on("error", () => {});
          child.unref();
        } catch {
          // best-effort only
        }
      })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "context-segments",
  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const numOpt = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : fallback;
    const warnAt = numOpt(options.warnAt, 0.7);
    // criticalAt below warnAt would invert the warn/critical bands — clamp.
    const criticalAt = Math.max(warnAt, numOpt(options.criticalAt, 0.9));
    const skillTracking = options.skillTracking !== false;
    const webIdleMs = numOpt(options.webIdleMs, 5 * 60 * 1000);

    const log = async (message: string, extra?: unknown) => {
      try {
        await ctx.app.log({
          body: { service: "context-segments", level: "info", message, extra },
        });
      } catch {
        // logging must never break the plugin
      }
    };

    const readGlobal = async (): Promise<GlobalStore> => {
      try {
        const raw = await ctx.storage.get(GLOBAL_KEY);
        const record = asRecord(raw);
        const skills = asRecord(record.skills);
        return {
          skills: skills as GlobalStore["skills"],
          updated:
            typeof record.updated === "number" ? record.updated : 0,
        };
      } catch {
        return { skills: {}, updated: 0 };
      }
    };

    const recordSkill = async (
      sessionID: string,
      id: string,
      name: string,
      text: unknown,
    ) => {
      if (!skillTracking) return;
      const store = await readGlobal();
      const key = name || id || "skill";
      const entry = store.skills[key] ?? {
        id: key,
        name: key,
        count: 0,
        lastUsed: 0,
        estTokens: 0,
      };
      entry.count += 1;
      entry.lastUsed = Date.now();
      entry.estTokens += estimateTokens(text);
      store.skills[key] = entry;
      store.updated = Date.now();
      try {
        await ctx.storage.set(GLOBAL_KEY, store);
      } catch {
        // persistence is best-effort
      }
    };

    const resolveLimit = async (
      modelRef: unknown,
    ): Promise<{ limit: number | null; label: string }> => {
      const ref = asRecord(modelRef);
      const id = typeof ref.id === "string" ? ref.id : "";
      const providerID =
        typeof ref.providerID === "string" ? ref.providerID : "";
      const label = id ? `${providerID}/${id}`.replace(/^\//, "") : "unknown";
      if (!id) return { limit: null, label };
      try {
        const models = await ctx.model.list();
        const arr: unknown[] = Array.isArray(models)
          ? models
          : Array.isArray((models as { data?: unknown }).data)
            ? (models as { data: unknown[] }).data
            : [];
        const hit =
          arr.find((m) => {
            const r = asRecord(m);
            return r.id === id && r.providerID === providerID;
          }) ?? arr.find((m) => asRecord(m).id === id);
        const limit = asRecord(hit).limit as { context?: unknown } | undefined;
        const context =
          typeof limit?.context === "number" && limit.context > 0
            ? limit.context
            : null;
        return { limit: context, label };
      } catch {
        return { limit: null, label };
      }
    };

    // --- Tool classifier (registry first, heuristics fallback) ------------
    // MCP server names + tool ids come from the live registries so MCP
    // attribution is exact. Reads are cached for 30s and never throw:
    // on any failure summarize() falls back to pure name heuristics.
    let classifierCache: {
      at: number;
      servers: string[];
      tools: string[];
    } | null = null;
    const extractNames = (value: unknown): string[] => {
      const out: string[] = [];
      const push = (v: unknown) => {
        if (typeof v === "string" && v) out.push(v);
      };
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") push(item);
          else if (Array.isArray(item)) push(item[0]);
          else if (item && typeof item === "object") {
            const r = item as Record<string, unknown>;
            push(r.id ?? r.name ?? r.server ?? r.serverName);
          }
        }
      } else if (value && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          push(key);
        }
      }
      return [...new Set(out)];
    };
    const getToolClassifier = async (): Promise<{
      mcpServers: string[];
      mcpTools: string[];
    }> => {
      if (classifierCache && Date.now() - classifierCache.at < 30_000) {
        return {
          mcpServers: classifierCache.servers,
          mcpTools: classifierCache.tools,
        };
      }
      let servers: string[] = classifierCache?.servers ?? [];
      let tools: string[] = classifierCache?.tools ?? [];
      try {
        const mcpList = await ctx.mcp.list();
        const mcpServers = extractNames(
          Array.isArray(mcpList)
            ? mcpList
            : asRecord(mcpList).servers ?? asRecord(mcpList).data ?? mcpList,
        );
        const toolList = await ctx.tool.list();
        const toolIds = extractNames(
          Array.isArray(toolList)
            ? toolList
            : asRecord(toolList).tools ?? asRecord(toolList).data ?? toolList,
        );
        const norm = (s: string) =>
          s.trim().toLowerCase().replace(/[.-]/g, "_");
        const serverSet = new Set(mcpServers.map(norm));
        const mcpTools = toolIds.filter((id) => {
          const nid = norm(id);
          for (const s of serverSet) {
            if (nid === s || nid.startsWith(`${s}_`)) return true;
          }
          return false;
        });
        servers = mcpServers;
        tools = mcpTools;
        classifierCache = { at: Date.now(), servers, tools };
      } catch {
        // keep last-known (or empty) classifier; heuristics take over
      }
      return { mcpServers: servers, mcpTools: tools };
    };

    const buildSummary = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID });
      const sessionRecord = asRecord(session);
      const messages = await ctx.session.context({ sessionID });
      const list = Array.isArray(messages) ? messages : [];
      const { limit, label } = await resolveLimit(sessionRecord.model);
      const classifier = await getToolClassifier();

      // One-time backfill: fold this session's skill messages into the
      // global counters so stats survive restarts and missed events.
      // Batched into a single storage read + write (the old per-message
      // get/set round-trips stalled the first summary of long sessions).
      if (skillTracking) {
        try {
          const flag = await ctx.storage.get(backfillKey(sessionID));
          if (!flag) {
            const agg = new Map<string, { count: number; tokens: number }>();
            for (const raw of list) {
              const msg = asRecord(raw);
              if (msg.type !== "skill") continue;
              const key = String(msg.name ?? msg.skill ?? "skill");
              const entry = agg.get(key) ?? { count: 0, tokens: 0 };
              entry.count += 1;
              entry.tokens += estimateTokens(msg.text);
              agg.set(key, entry);
            }
            if (agg.size > 0) {
              const store = await readGlobal();
              for (const [key, total] of agg) {
                const entry = store.skills[key] ?? {
                  id: key,
                  name: key,
                  count: 0,
                  lastUsed: 0,
                  estTokens: 0,
                };
                entry.count += total.count;
                entry.lastUsed = Date.now();
                entry.estTokens += total.tokens;
                store.skills[key] = entry;
              }
              store.updated = Date.now();
              try {
                await ctx.storage.set(GLOBAL_KEY, store);
              } catch {
                // persistence is best-effort
              }
            }
            try {
              await ctx.storage.set(backfillKey(sessionID), { at: Date.now() });
            } catch {
              // persistence is best-effort
            }
          }
        } catch {
          // backfill is best-effort
        }
      }

      return {
        ok: true as const,
        ...summarize(list, {
          limit,
          model: label,
          sessionTokens: sessionRecord.tokens,
          warnAt,
          criticalAt,
          classifier,
        }),
      };
    };

    const buildSkills = async () => {
      const store = await readGlobal();
      const skills: GlobalSkillDatum[] = Object.values(store.skills)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          count: entry.count,
          lastUsed: entry.lastUsed,
          estTokens: entry.estTokens,
        }))
        .sort((a, b) => b.count - a.count || b.estTokens - a.estTokens);
      return {
        ok: true as const,
        skills,
        totals: {
          skills: skills.length,
          invocations: skills.reduce((sum, s) => sum + s.count, 0),
          estTokens: skills.reduce((sum, s) => sum + s.estTokens, 0),
        },
      };
    };

    // --- RPC (consumed by the TUI) -------------------------------------
    // Shared dashboard starter: concurrent callers share one in-flight
    // start instead of racing to bind two servers (the loser used to leak
    // a server + timer that nothing could stop).
    let dashboardStarting: Promise<{ url: string; opened: boolean }> | null =
      null;
    const dashboardCallbacks = () => ({
      idleMs: webIdleMs,
      openBrowser: openBrowserBestEffort,
      getData: async (sid?: string) => ({
        summary: sid
          ? await buildSummary(sid).catch((error) => ({
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            }))
          : null,
        skills: await buildSkills().catch(() => ({
          ok: false as const,
          error: "unavailable",
        })),
        generatedAt: Date.now(),
      }),
    });
    const ensureDashboard = (): Promise<{ url: string; opened: boolean }> => {
      const running = dashboardRunning();
      if (running) return Promise.resolve({ url: running.url, opened: false });
      if (!dashboardStarting) {
        dashboardStarting = startDashboard(dashboardCallbacks())
          .then((handle) => {
            // log() never throws; floating it keeps startup latency down.
            void log("dashboard started", { port: handle.port });
            return { url: handle.url, opened: true };
          })
          .finally(() => {
            dashboardStarting = null;
          });
      }
      return dashboardStarting;
    };
    let emitStats: ((sessionID: string, skill: string) => Promise<void>) | null =
      null;
    try {
      const registration = await ctx.rpc.register(csegRpc as never, {
        getSummary: async (input: unknown) => {
          const { sessionID } = asRecord(input) as { sessionID?: unknown };
          if (typeof sessionID !== "string" || !sessionID) {
            throw new Error("getSummary requires sessionID");
          }
          try {
            return await buildSummary(sessionID);
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
        getSkills: async () => {
          try {
            return await buildSkills();
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
        startWeb: async () => {
          try {
            return { ok: true as const, ...(await ensureDashboard()) };
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
        stopWeb: async () => {
          const stopped = stopDashboard();
          return { ok: true as const, stopped };
        },
        postSummary: async (input: unknown) => {
          // Posts the plain-text breakdown into the session as a synthetic
          // message so the model can investigate it. Never throws: failures
          // come back as { ok: false } like every other method here.
          try {
            const { sessionID } = asRecord(input) as { sessionID?: unknown };
            if (typeof sessionID !== "string" || !sessionID) {
              throw new Error("postSummary requires sessionID");
            }
            const text = renderSummaryText(await buildSummary(sessionID));
            try {
              await ctx.session.synthetic({ sessionID, text });
            } catch {
              // posting must never break the call
            }
            return { ok: true as const };
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
      emitStats = async (sessionID: string, skill: string) => {
        try {
          await registration.events.emit("stats", { sessionID, skill });
        } catch {
          // events are best-effort
        }
      };
    } catch (error) {
      await log("rpc registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- Skill tracking --------------------------------------------------
    const controller = new AbortController();
    if (skillTracking) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            signal: controller.signal,
          })) {
            try {
              const type = (event as { type?: unknown })?.type;
              if (type !== "session.skill.activated") continue;
              const data = asRecord((event as { data?: unknown })?.data);
              const sessionID =
                typeof data.sessionID === "string" ? data.sessionID : "";
              const name =
                typeof data.name === "string" ? data.name : "skill";
              const id = typeof data.id === "string" ? data.id : name;
              if (!sessionID) continue;
              await recordSkill(sessionID, id, name, data.text);
              await emitStats?.(sessionID, name);
            } catch {
              // per-event errors must never kill the subscription
            }
          }
        } catch {
          // aborted on unload
        }
      })();
    }

    // --- Agent tools ------------------------------------------------------
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "context_usage",
          description:
            "Show the colorized context-segment breakdown for a session: token usage per segment (system, skills, history, mcps, rules, others, assistant, reasoning) as a share of the model's context limit, plus top tools and skills. When this tool is called, summarize the key insights instead of pasting the raw output.",
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            additionalProperties: false,
          },
          output: { type: "string" },
          execute: async (input: unknown, toolCtx: any) => {
            // Never throw: a throwing tool executor fails the whole model
            // turn, so degradation is returned as text instead.
            try {
              const arg = asRecord(input).sessionID;
              const sessionID =
                (typeof arg === "string" && arg) || toolCtx?.sessionID;
              if (!sessionID) return { output: "Context unavailable: no session ID." };
              const text = renderSummaryText(await buildSummary(String(sessionID)));
              return { output: text };
            } catch (error) {
              return {
                output: `Context unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          },
        });
        editor.add({
          name: "skill_stats",
          description:
            "Show persistent skill-usage frequency statistics across all sessions: invocation counts, estimated tokens, and last-used time per skill.",
          input: { type: "object", properties: {}, additionalProperties: false },
          output: { type: "string" },
          execute: async () => {
            try {
              const result = await buildSkills();
              return { output: renderSkillsText(result.skills) };
            } catch (error) {
              return {
                output: `Skill stats unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          },
        });
      });
    } catch (error) {
      await log("tool registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- Slash commands ----------------------------------------------------
    try {
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "context",
          description: "Post this session's context-segment breakdown.",
          execute: async (input: any) => {
            // Never throw: post the degradation as text instead of failing
            // the turn that invoked the command.
            let text: string;
            try {
              text = renderSummaryText(await buildSummary(input.sessionID));
            } catch (error) {
              text = `Context unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            try {
              await ctx.session.synthetic({ sessionID: input.sessionID, text });
            } catch {
              // posting must never break the command
            }
          },
        });
        editor.add({
          name: "context-skills",
          description:
            "Post skill-usage statistics. Append 'web' to start the loopback dashboard instead.",
          execute: async (input: any) => {
            const rawText =
              typeof input?.prompt?.text === "string" ? input.prompt.text : "";
            if (/\bweb\b/i.test(rawText)) {
              let text: string;
              try {
                const started = await ensureDashboard();
                text =
                  `Skill dashboard: ${started.url}\n` +
                  `Loopback-only. Closing the tab stops the server automatically.`;
              } catch (error) {
                text = `Could not start skill dashboard: ${error instanceof Error ? error.message : String(error)}`;
              }
              try {
                await ctx.session.synthetic({
                  sessionID: input.sessionID,
                  text,
                });
              } catch {
                // posting must never break the command
              }
              return;
            }
            let text: string;
            try {
              const result = await buildSkills();
              text = renderSkillsText(result.skills);
            } catch (error) {
              text = `Skill stats unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            try {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text,
              });
            } catch {
              // posting must never break the command
            }
          },
        });
      });
    } catch (error) {
      await log("command registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return () => {
      controller.abort();
      stopDashboard();
    };
  },
});
