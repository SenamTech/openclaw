/**
 * tool_result_transform runner and fail-closed tool_result_persist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { PLUGIN_HOOK_NAMES } from "./hook-types.js";
import { createHookRunner, TOOL_RESULT_WITHHELD_TEXT } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-helpers.js";

const ctx = { toolName: "read" };
const toolResultMessage = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  isError: false,
  content: [{ type: "text", text: "raw output FAKE-SECRET-789" }],
  details: { stdout: "raw output FAKE-SECRET-789" },
} as never;

afterEach(() => {
  resetGlobalHookRunner();
});

describe("tool_result_transform", () => {
  it("is a known hook name", () => {
    expect(PLUGIN_HOOK_NAMES).toContain("tool_result_transform");
  });

  it("chains handlers in priority order and returns the last result", async () => {
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "first",
      hookName: "tool_result_transform",
      priority: 10,
      handler: (event: unknown) => ({ result: `${(event as { result: string }).result}+a` }),
    });
    addTestHook({
      registry,
      pluginId: "second",
      hookName: "tool_result_transform",
      priority: 1,
      handler: (event: unknown) => ({ result: `${(event as { result: string }).result}+b` }),
    });
    const runner = createHookRunner(registry);
    await expect(
      runner.runToolResultTransform({ toolName: "read", params: {}, result: "r" }, ctx),
    ).resolves.toEqual({ result: "r+a+b", failed: false });
  });

  it("keeps the result when a handler returns nothing", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([{ hookName: "tool_result_transform", handler: () => undefined }]),
    );
    await expect(
      runner.runToolResultTransform({ toolName: "read", params: {}, result: "r" }, ctx),
    ).resolves.toEqual({ result: "r", failed: false });
  });

  it("reports failed and stops when a handler throws, whatever the failure policy", async () => {
    const later = vi.fn(() => ({ result: "later" }));
    const logger = { warn: vi.fn(), error: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_transform",
          handler: () => {
            throw new Error("boom");
          },
        },
        { hookName: "tool_result_transform", handler: later },
      ]),
      { logger, failurePolicyByHook: { tool_result_transform: "fail-open" } },
    );
    await expect(
      runner.runToolResultTransform({ toolName: "read", params: {}, result: "raw" }, ctx),
    ).resolves.toEqual({ result: "raw", failed: true });
    expect(later).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("result withheld"));
  });
});

describe("tool_result_persist failure policy", () => {
  const throwing = {
    hookName: "tool_result_persist",
    handler: () => {
      throw new Error("scrubber crashed");
    },
  };

  it("withholds content and drops details when fail-closed and a handler throws", () => {
    const later = vi.fn((event: unknown) => ({ message: (event as { message: unknown }).message }));
    const runner = createHookRunner(
      createMockPluginRegistry([throwing, { hookName: "tool_result_persist", handler: later }]),
      {
        logger: { warn: vi.fn(), error: vi.fn() },
        failurePolicyByHook: { tool_result_persist: "fail-closed" },
      },
    );
    const out = runner.runToolResultPersist({ message: toolResultMessage }, {});
    expect(JSON.stringify(out)).not.toContain("FAKE-SECRET-789");
    expect(out!.message).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: TOOL_RESULT_WITHHELD_TEXT }],
    });
    expect((out!.message as { details?: unknown }).details).toBeUndefined();
    expect(later).not.toHaveBeenCalled();
  });

  it("withholds content when fail-closed and a handler returns a Promise", () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "tool_result_persist", handler: async () => ({ message: toolResultMessage }) },
      ]),
      {
        logger: { warn: vi.fn(), error: vi.fn() },
        failurePolicyByHook: { tool_result_persist: "fail-closed" },
      },
    );
    const out = runner.runToolResultPersist({ message: toolResultMessage }, {});
    expect(JSON.stringify(out)).not.toContain("FAKE-SECRET-789");
  });

  it("keeps the old fail-open behaviour by default", () => {
    const runner = createHookRunner(createMockPluginRegistry([throwing]), {
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const out = runner.runToolResultPersist({ message: toolResultMessage }, {});
    expect(out!.message).toBe(toolResultMessage);
  });

  it("is fail-closed in the global hook runner", async () => {
    initializeGlobalHookRunner(createMockPluginRegistry([throwing]));
    const out = getGlobalHookRunner()!.runToolResultPersist({ message: toolResultMessage }, {});
    expect(JSON.stringify(out)).not.toContain("FAKE-SECRET-789");
  });
});
