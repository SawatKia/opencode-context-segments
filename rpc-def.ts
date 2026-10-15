/**
 * context-segments — rpc-def.ts
 *
 * Single source of truth for the plugin RPC surface. Plain object, zero
 * imports, so both the server entrypoint (`index.ts`) and the TUI
 * (`tui.tsx`, which keeps an inline copy to avoid cross-file imports)
 * stay in sync. Method names here MUST match the inline copy in tui.tsx.
 */

export const CSEG_RPC_ID = "context-segments";

const sessionObject = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

const anyObject = {
  type: "object",
} as const;

export const csegRpc = {
  id: CSEG_RPC_ID,
  methods: {
    getSummary: {
      input: sessionObject,
      output: anyObject,
    },
    getSkills: {
      input: anyObject,
      output: anyObject,
    },
    startWeb: {
      input: anyObject,
      output: anyObject,
    },
    stopWeb: {
      input: anyObject,
      output: anyObject,
    },
  },
  events: {
    stats: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          skill: { type: "string" },
        },
        required: ["sessionID", "skill"],
        additionalProperties: false,
      },
    },
  },
} as const;
