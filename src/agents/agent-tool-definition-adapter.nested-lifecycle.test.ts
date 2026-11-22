/**
 * Nested tool-search target calls: the transform runs inside the tool
 * lifecycle's execute, so the end event, observers (onAgentToolResult,
 * agent events, after_tool_call) and verbose tool output never see the raw
 * result or the raw error text.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { runNestedToolTransformed } from "./agent-tool-definition-adapter.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

const state = vi.hoisted(() => ({ runner: null as unknown }));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => state.runner,
}));

const SECRET = "FAKE-SECRET-777";
const redact = (event: unknown) => ({
  result: JSON.parse(
    JSON.stringify((event as { result: unknown }).result).replaceAll(SECRET, "<redacted>"),
  ),
});

let stopListening: (() => void) | undefined;
afterEach(() => {
  stopListening?.();
  stopListening = undefined;
  state.runner = null;
});

function setup() {
  const afterToolCall: unknown[] = [];
  const runner = createHookRunner(
    createMockPluginRegistry([
      { hookName: "tool_result_transform", handler: redact },
      {
        hookName: "after_tool_call",
        handler: (event) => {
          afterToolCall.push(event);
        },
      },
    ]),
    { logger: { warn: vi.fn(), error: vi.fn() } },
  );
  state.runner = runner;
  const seen: unknown[] = [];
  const unsubscribe = onAgentEvent((evt) => {
    seen.push(evt);
  });
  stopListening = typeof unsubscribe === "function" ? unsubscribe : undefined;
  const { session } = createStubSessionHarness();
  const subscription = subscribeEmbeddedAgentSession({
    session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
    runId: "run-nested",
    hookRunner: runner as never,
    verboseLevel: "full",
    onAgentToolResult: (event) => {
      seen.push(event);
    },
    onAgentEvent: (event) => {
      seen.push(event);
    },
    onToolResult: (payload) => {
      seen.push(payload);
    },
  });
  return { subscription, seen, afterToolCall };
}

describe("nested tool-search lifecycle sees only transformed results", () => {
  it("end events, observers and after_tool_call get the transformed result", async () => {
    const { subscription, seen, afterToolCall } = setup();
    const result = await subscription.runToolLifecycle({
      toolName: "read",
      toolCallId: "nested-ok",
      args: {},
      execute: async () =>
        await runNestedToolTransformed({
          toolName: "read",
          toolCallId: "nested-ok",
          input: {},
          run: async () => ({
            content: [{ type: "text", text: `file says ${SECRET}` }],
            details: { raw: SECRET },
          }),
        }),
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(afterToolCall.length).toBe(1);
    expect(JSON.stringify(afterToolCall)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).toContain("<redacted>");
  });

  it("a thrown nested error reaches the lifecycle and the caller only as transformed text", async () => {
    const { subscription, seen, afterToolCall } = setup();
    let thrown: unknown;
    try {
      await subscription.runToolLifecycle({
        toolName: "read",
        toolCallId: "nested-err",
        args: {},
        execute: async () =>
          await runNestedToolTransformed({
            toolName: "read",
            toolCallId: "nested-err",
            input: {},
            run: async () => {
              throw new Error(`login failed for ${SECRET}`);
            },
          }),
      });
    } catch (err) {
      thrown = err;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(SECRET);
    expect((thrown as Error).message).toContain("<redacted>");
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(afterToolCall)).not.toContain(SECRET);
  });

  it("rethrows an abort as it is", async () => {
    setup();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      runNestedToolTransformed({
        toolName: "read",
        toolCallId: "nested-abort",
        input: {},
        run: async () => {
          throw abort;
        },
      }),
    ).rejects.toBe(abort);
  });

  it("is wired into the tool-search executor's lifecycle execute", () => {
    // attempt.ts has no harness for the tool-search executor; guard the wiring
    // so the raw tool call cannot move back outside the transformed execute.
    const source = readFileSync(
      new URL("./embedded-agent-runner/run/attempt.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("toolSearchCatalogExecutor = async (toolParams) => {");
    const block = source.slice(start, source.indexOf("const abortActiveRunExternally", start));
    expect(start).toBeGreaterThan(0);
    expect(block).toMatch(/execute: async \(\) =>\s+await runNestedToolTransformed\(\{/);
    const rawCall = block.indexOf("toolParams.tool.execute(");
    expect(rawCall).toBeGreaterThan(block.indexOf("run: async () =>"));
    expect(block.indexOf("toolParams.tool.execute(", rawCall + 1)).toBe(-1);
  });
});
