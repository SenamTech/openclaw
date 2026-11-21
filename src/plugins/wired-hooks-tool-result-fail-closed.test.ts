/**
 * Test: result hooks fail closed (after_tool_call outcome, tool_result_persist).
 * A handler that throws must not let unprocessed tool output through.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createHookRunner, TOOL_RESULT_WITHHELD_TEXT } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

const toolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  isError: false,
  content: [{ type: "text", text: "raw output FAKE-SECRET-789" }],
  details: { stdout: "raw output FAKE-SECRET-789" },
} as unknown as AgentMessage;

describe("after_tool_call outcome", () => {
  it("reports success and keeps in-place changes from handlers", async () => {
    const result = { content: [{ type: "text", text: "FAKE-SECRET-789" }] };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: (event) => {
            (event as { result: typeof result }).result.content[0].text = "<redacted>";
          },
        },
      ]),
    );

    const outcome = await runner.runAfterToolCallWithOutcome(
      { toolName: "read", params: {}, result },
      { toolName: "read" },
    );

    expect(outcome).toEqual({ failed: false });
    expect(result.content[0].text).toBe("<redacted>");
  });

  it("reports failed when a handler throws, and logs it", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "after_tool_call", handler: vi.fn() },
        {
          hookName: "after_tool_call",
          handler: () => {
            throw new Error("boom");
          },
        },
      ]),
      { logger },
    );

    const outcome = await runner.runAfterToolCallWithOutcome(
      { toolName: "read", params: {}, result: {} },
      { toolName: "read" },
    );

    expect(outcome).toEqual({ failed: true });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("after_tool_call handler"));
  });

  it("reports no failure without handlers", async () => {
    const runner = createHookRunner(createMockPluginRegistry([]));
    await expect(
      runner.runAfterToolCallWithOutcome({ toolName: "read", params: {} }, { toolName: "read" }),
    ).resolves.toEqual({ failed: false });
  });
});

describe("tool_result_persist fails closed", () => {
  it("still applies a working handler's change", () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          handler: (event) => ({
            message: {
              ...(event as { message: AgentMessage }).message,
              content: [{ type: "text", text: "<redacted>" }],
            },
          }),
        },
      ]),
    );

    const out = runner.runToolResultPersist({ message: toolResult }, {});

    expect((out!.message as { content: Array<{ text: string }> }).content[0].text).toBe(
      "<redacted>",
    );
  });

  it("withholds content and drops details when a handler throws", () => {
    const later = vi.fn((event: unknown) => ({
      message: (event as { message: AgentMessage }).message,
    }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          handler: () => {
            throw new Error("scrubber crashed");
          },
        },
        { hookName: "tool_result_persist", handler: later },
      ]),
      { logger: { warn: vi.fn(), error: vi.fn() } },
    );

    const out = runner.runToolResultPersist({ message: toolResult }, {});

    expect(JSON.stringify(out)).not.toContain("FAKE-SECRET-789");
    expect(out?.message).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: TOOL_RESULT_WITHHELD_TEXT }],
    });
    expect((out!.message as { details?: unknown }).details).toBeUndefined();
    expect(later).not.toHaveBeenCalled();
  });

  it("withholds content when a handler returns a Promise", () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          handler: async () => ({ message: { role: "toolResult", content: [] } }),
        },
      ]),
      { logger: { warn: vi.fn(), error: vi.fn() } },
    );

    const out = runner.runToolResultPersist({ message: toolResult }, {});

    expect(JSON.stringify(out)).not.toContain("FAKE-SECRET-789");
    expect((out!.message as { content: Array<{ text: string }> }).content[0].text).toBe(
      TOOL_RESULT_WITHHELD_TEXT,
    );
  });
});
