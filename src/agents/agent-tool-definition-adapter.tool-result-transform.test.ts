/**
 * tool_result_transform in the tool adapter: awaited before the agent gets a
 * tool result (also for a thrown tool error), and fail closed.
 */
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner, TOOL_RESULT_WITHHELD_TEXT } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";

const state = vi.hoisted(() => ({ runner: null as unknown }));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => state.runner,
}));

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function useHooks(
  hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
  options: Parameters<typeof createHookRunner>[1] = {},
) {
  const runner = createHookRunner(createMockPluginRegistry(hooks), {
    logger: { warn: vi.fn(), error: vi.fn() },
    ...options,
  });
  state.runner = runner;
  return runner;
}

function textTool(text: string) {
  return {
    name: "read",
    label: "Read",
    description: "reads",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text }], details: { text } })),
  } satisfies AgentTool;
}

function throwingTool(message: string) {
  return {
    name: "bash",
    label: "Bash",
    description: "throws",
    parameters: Type.Object({}),
    execute: vi.fn(async () => {
      throw new Error(message);
    }),
  } satisfies AgentTool;
}

async function run(tool: AgentTool) {
  const def = toToolDefinitions([tool])[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute("call-1", {}, undefined, undefined, extensionContext);
}

const redact = (event: unknown) => ({
  result: JSON.parse(
    JSON.stringify((event as { result: unknown }).result).replaceAll(
      "FAKE-SECRET-123",
      "<redacted>",
    ),
  ),
});

describe("agent tool definition adapter tool_result_transform", () => {
  beforeEach(() => {
    state.runner = null;
  });

  it("returns the tool result unchanged when no hook is registered", async () => {
    useHooks([]);
    const result = await run(textTool("plain output"));
    expect(result.content).toEqual([{ type: "text", text: "plain output" }]);
  });

  it("gives the agent the transformed result", async () => {
    useHooks([{ hookName: "tool_result_transform", handler: redact }]);
    const result = await run(textTool("token FAKE-SECRET-123 here"));
    expect(JSON.stringify(result.content)).toContain("<redacted>");
    expect(JSON.stringify(result.content)).not.toContain("FAKE-SECRET-123");
  });

  it("runs on a thrown tool error with the error result the agent receives", async () => {
    const seen: unknown[] = [];
    useHooks([
      {
        hookName: "tool_result_transform",
        handler: (event) => {
          seen.push(event);
          return redact(event);
        },
      },
    ]);
    const result = await run(throwingTool("login failed for password FAKE-SECRET-123"));
    const text = JSON.stringify(result);
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("FAKE-SECRET-123");
    expect(seen[0]).toMatchObject({
      toolName: "exec",
      toolCallId: "call-1",
      error: "login failed for password FAKE-SECRET-123",
    });
  });

  it("withholds the result when a handler throws", async () => {
    useHooks([
      {
        hookName: "tool_result_transform",
        handler: () => {
          throw new Error("scrubber crashed");
        },
      },
    ]);
    const result = await run(textTool("token FAKE-SECRET-123 here"));
    expect(JSON.stringify(result)).not.toContain("FAKE-SECRET-123");
    expect(result.details).toMatchObject({ status: "error", error: TOOL_RESULT_WITHHELD_TEXT });
  });

  it("withholds a thrown tool error when a handler throws", async () => {
    useHooks([
      {
        hookName: "tool_result_transform",
        handler: () => {
          throw new Error("scrubber crashed");
        },
      },
    ]);
    const result = await run(throwingTool("login failed for password FAKE-SECRET-456"));
    expect(JSON.stringify(result)).not.toContain("FAKE-SECRET-456");
    expect(result.details).toMatchObject({ status: "error", error: TOOL_RESULT_WITHHELD_TEXT });
  });

  it("withholds the result when a handler times out", async () => {
    useHooks([{ hookName: "tool_result_transform", handler: () => new Promise(() => {}) }], {
      modifyingHookTimeoutMsByHook: { tool_result_transform: 20 },
    });
    const result = await run(textTool("token FAKE-SECRET-789 here"));
    expect(JSON.stringify(result)).not.toContain("FAKE-SECRET-789");
    expect(result.details).toMatchObject({ error: TOOL_RESULT_WITHHELD_TEXT });
  });
});
