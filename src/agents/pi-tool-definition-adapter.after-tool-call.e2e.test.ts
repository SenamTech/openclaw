import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner, TOOL_RESULT_WITHHELD_TEXT } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterToolCallWithOutcome: vi.fn(async () => ({ failed: false })),
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn(() => undefined),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: hookMocks.consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook: hookMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

describe("pi tool definition adapter after_tool_call", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.runAfterToolCallWithOutcome.mockReset();
    hookMocks.runner.runAfterToolCallWithOutcome.mockResolvedValue({ failed: false });
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReset();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockReset();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockReset();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("dispatches after_tool_call once on successful adapter execution", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
    hookMocks.runBeforeToolCallHook.mockResolvedValue({
      blocked: false,
      params: { mode: "safe" },
    });
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-ok", { path: "/tmp/file" }, undefined, undefined);

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: { mode: "safe" },
        result,
      },
      { toolName: "read" },
    );
  });

  it("uses wrapped-tool adjusted params for after_tool_call payload", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue({ mode: "safe" });
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute(
      "call-ok-wrapped",
      { path: "/tmp/file" },
      undefined,
      undefined,
    );

    expect(result.details).toMatchObject({ ok: true });
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledWith(
      {
        toolName: "read",
        params: { mode: "safe" },
        result,
      },
      { toolName: "read" },
    );
  });

  it("dispatches after_tool_call once on adapter error with normalized tool name", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err", { cmd: "ls" }, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "boom",
    });
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledWith(
      {
        toolName: "exec",
        params: { cmd: "ls" },
        result,
        error: "boom",
      },
      { toolName: "exec" },
    );
  });

  it("withholds the result when the after_tool_call runner throws", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
    hookMocks.runner.runAfterToolCallWithOutcome.mockRejectedValue(new Error("hook failed"));
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-ok2", { path: "/tmp/file" }, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "read",
      error: TOOL_RESULT_WITHHELD_TEXT,
    });
    expect(hookMocks.runner.runAfterToolCallWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("withholds the result when an after_tool_call handler failed", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "after_tool_call");
    hookMocks.runner.runAfterToolCallWithOutcome.mockResolvedValue({ failed: true });
    const tool = {
      name: "read",
      label: "Read",
      description: "reads",
      parameters: {},
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "raw secret-ish output" }],
        details: { ok: true },
      })),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-failed", {}, undefined, undefined);

    expect(JSON.stringify(result)).not.toContain("raw secret-ish output");
    expect(result.details).toMatchObject({ status: "error", error: TOOL_RESULT_WITHHELD_TEXT });
  });

  it("lets a real after_tool_call handler redact a thrown tool error before the agent sees it", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: (event) => {
            const result = (event as { result?: { content?: Array<{ text?: string }> } }).result;
            for (const block of result?.content ?? []) {
              block.text = block.text?.replaceAll("FAKE-SECRET-123", "<redacted>");
            }
          },
        },
      ]),
    );
    hookMocks.runner.hasHooks.mockImplementation((name: string) => runner.hasHooks(name as never));
    hookMocks.runner.runAfterToolCallWithOutcome.mockImplementation(
      runner.runAfterToolCallWithOutcome as never,
    );
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("login failed for password FAKE-SECRET-123");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err-redact", {}, undefined, undefined);

    const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("FAKE-SECRET-123");
  });

  it("withholds a thrown tool error when a real after_tool_call handler throws", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_tool_call",
          handler: () => {
            throw new Error("scrubber crashed");
          },
        },
      ]),
    );
    hookMocks.runner.hasHooks.mockImplementation((name: string) => runner.hasHooks(name as never));
    hookMocks.runner.runAfterToolCallWithOutcome.mockImplementation(
      runner.runAfterToolCallWithOutcome as never,
    );
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: vi.fn(async () => {
        throw new Error("login failed for password FAKE-SECRET-456");
      }),
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-err-withheld", {}, undefined, undefined);

    expect(JSON.stringify(result)).not.toContain("FAKE-SECRET-456");
    expect(result.details).toMatchObject({ status: "error", error: TOOL_RESULT_WITHHELD_TEXT });
  });
});
