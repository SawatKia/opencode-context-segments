/**
 * context-segments — index.ts (server entrypoint, auto-discovered).
 *
 * - RPC `context-segments`: getSummary / getSkills / startWeb / stopWeb
 *   (+ `stats` event) consumed by the TUI (`tui.tsx`).
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
      | { spawn?: (args: string[], opts?: unknown) => unknown }
      | undefined;
    if (spawned && typeof spawned.spawn === "function") {
      if (process.platform === "win32") {
        spawned.spawn(["cmd", "/c", "start", "", url], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } else if (process.platform === "darwin") {
        spawned.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
      } else {
        spawned.spawn(["xdg-open", url], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      }
      return true;
    }
  } catch {
    // fall through to child_process
  }
  try {
    void import("node:child_process").then(({ spawn }) => {
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
      child.unref();
    });
    return true;
  } catch {
    return false;
  }
}

export default Plugin.define({
  id: "context-segments",
  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const warnAt =
      typeof options.warnAt === "number" ? options.warnAt : 0.7;
    const criticalAt =
      typeof options.criticalAt === "number" ? options.criticalAt : 0.9;
    const skillTracking = options.skillTracking !== false;
    const webIdleMs =
      typeof options.webIdleMs === "number" ? options.webIdleMs : 5 * 60 * 1000;

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

    const buildSummary = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID });
      const sessionRecord = asRecord(session);
      const messages = await ctx.session.context({ sessionID });
      const list = Array.isArray(messages) ? messages : [];
      const { limit, label } = await resolveLimit(sessionRecord.model);

      // One-time backfill: fold this session's skill messages into the
      // global counters so stats survive restarts and missed events.
      if (skillTracking) {
        try {
          const flag = await ctx.storage.get(backfillKey(sessionID));
          if (!flag) {
            for (const raw of list) {
              const msg = asRecord(raw);
              if (msg.type === "skill") {
                await recordSkill(
                  sessionID,
                  String(msg.skill ?? msg.name ?? "skill"),
                  String(msg.name ?? msg.skill ?? "skill"),
                  msg.text,
                );
              }
            }
            await ctx.storage.set(backfillKey(sessionID), { at: Date.now() });
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
            const running = dashboardRunning();
            if (running) return { ok: true as const, url: running.url, opened: false };
            const handle = await startDashboard({
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
            await log("dashboard started", { port: handle.port });
            return { ok: true as const, url: handle.url, opened: true };
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
            "Show the colorized context-segment breakdown for a session: token usage per segment (system, skills, history, tools, assistant, reasoning) as a share of the model's context limit, plus top tools and skills. When this tool is called, summarize the key insights instead of pasting the raw output.",
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            additionalProperties: false,
          },
          output: { type: "string" },
          execute: async (input: unknown, toolCtx: any) => {
            const arg = asRecord(input).sessionID;
            const sessionID =
              (typeof arg === "string" && arg) || toolCtx?.sessionID;
            if (!sessionID) throw new Error("No session ID available.");
            const text = renderSummaryText(await buildSummary(String(sessionID)));
            return { output: text };
          },
        });
        editor.add({
          name: "skill_stats",
          description:
            "Show persistent skill-usage frequency statistics across all sessions: invocation counts, estimated tokens, and last-used time per skill.",
          input: { type: "object", properties: {}, additionalProperties: false },
          output: { type: "string" },
          execute: async () => {
            const result = await buildSkills();
            return { output: renderSkillsText(result.skills) };
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
            const text = renderSummaryText(
              await buildSummary(input.sessionID),
            );
            await ctx.session.synthetic({ sessionID: input.sessionID, text });
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
              const started = dashboardRunning()
                ? { ok: true as const, url: dashboardRunning()!.url }
                : await (async () => {
                    const handle = await startDashboard({
                      idleMs: webIdleMs,
                      openBrowser: openBrowserBestEffort,
                      getData: async (sid?: string) => ({
                        summary: sid
                          ? await buildSummary(sid).catch((error) => ({
                              ok: false as const,
                              error:
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                            }))
                          : null,
                        skills: await buildSkills(),
                        generatedAt: Date.now(),
                      }),
                    });
                    return { ok: true as const, url: handle.url };
                  })();
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `Skill dashboard: ${started.url}\nLoopback-only. Closing the tab stops the server automatically.`,
              });
              return;
            }
            const result = await buildSkills();
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: renderSkillsText(result.skills),
            });
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
