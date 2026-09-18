import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { installFastJevCompaction } from "../extensions/pi-fast-jev-compaction.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { JevAsker, JevQuestions } from "../src/core/types.ts";
import { DECISION_ENTRY_TYPE } from "../src/ledger.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function transcript(): AgentMessage[] {
  const user: UserMessage = { role: "user", content: "Fix it.", timestamp: 1 };
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Reading." },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "large.ts" },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  };
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(5000) }],
    isError: false,
    timestamp: 3,
  };
  const final: AssistantMessage = {
    ...assistant,
    content: [{ type: "text", text: "Found it." }],
    stopReason: "stop",
    timestamp: 4,
  };
  return [user, assistant, result, final];
}

function messageEntries(messages: readonly AgentMessage[]): SessionEntry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `m${index + 1}`,
    parentId: index === 0 ? null : `m${index}`,
    timestamp: new Date(index).toISOString(),
    message,
  }));
}

function noop(): void {}

interface FakeHarness {
  entries: SessionEntry[];
  appended: { customType: string; data: unknown }[];
  commands: Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >;
  context: ExtensionCommandContext;
  emit: (name: string, event?: unknown) => Promise<unknown>;
  notify: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  answer?: number;
  fail?: boolean;
  keyFail?: boolean;
  delay?: Promise<void>;
  existingEntries?: SessionEntry[];
  minReductionRatio?: number;
}

function createHarness(options: HarnessOptions = {}): FakeHarness {
  const entries = options.existingEntries ?? messageEntries(transcript());
  const appended: { customType: string; data: unknown }[] = [];
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >();
  const notify = vi.fn();
  const setStatus = vi.fn();

  const sessionManager = {
    buildContextEntries: () => [...entries],
    getBranch: () => [...entries],
  };
  const context = {
    cwd: process.cwd(),
    getContextUsage: () => ({
      tokens: 70_000,
      contextWindow: 100_000,
      percent: 70,
    }),
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager,
    ui: { notify, setStatus },
    waitForIdle: async () => {
      await Promise.resolve();
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      const previous = entries.at(-1);
      const custom: CustomEntry = {
        type: "custom",
        customType,
        data,
        id: `e${appended.length}`,
        parentId: previous?.id ?? null,
        timestamp: new Date().toISOString(),
      };
      entries.push(custom);
    },
    exec: vi.fn(),
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown
    ) => {
      handlers.set(name, handler);
    },
    registerCommand: (
      name: string,
      definition: {
        handler: (
          args: string,
          ctx: ExtensionCommandContext
        ) => Promise<void> | void;
      }
    ) => {
      commands.set(name, definition.handler);
    },
    registerEntryRenderer: vi.fn(),
  };

  const asker: JevAsker = {
    async ask(_state, questions: JevQuestions) {
      if (options.delay) await options.delay;
      if (options.fail) throw new Error("TOPSECRET provider failure");
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: "noul", noul: options.answer ?? 0.1 },
          ])
        ),
      };
    },
  };

  installFastJevCompaction(pi as unknown as ExtensionAPI, {
    loadConfig: async () => ({
      ...DEFAULT_CONFIG,
      apiKeyCommand: "generic-command",
      preserveRecentMessages: 0,
      minReductionRatio: options.minReductionRatio ?? 0.1,
    }),
    createAsker: () => asker,
    keyResolver: {
      resolve: async () => {
        if (options.keyFail) throw new Error("missing key");
        return "TOPSECRET";
      },
      clear: noop,
    },
  });

  return {
    entries,
    appended,
    commands,
    context,
    notify,
    setStatus,
    emit: async (name, event) => {
      const payload = event ?? { type: name };
      return await Promise.resolve(handlers.get(name)?.(payload, context));
    },
  };
}

async function start(harness: FakeHarness, reason = "startup"): Promise<void> {
  await harness.emit("session_start", { type: "session_start", reason });
}

describe("Pi extension wiring", () => {
  it("runs proactively above the threshold, persists a ledger, and honors cooldown", async () => {
    const harness = createHarness();
    await start(harness);
    await harness.emit("turn_end");
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.customType).toBe(DECISION_ENTRY_TYPE);
    expect(JSON.stringify(harness.appended)).not.toContain("TOPSECRET");
    expect(JSON.stringify(harness.notify.mock.calls)).not.toContain(
      "TOPSECRET"
    );
    await harness.emit("turn_end");
    expect(harness.appended).toHaveLength(1);
  });

  it("guards against an overlapping proactive run", async () => {
    let release = noop;
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({ delay });
    await start(harness);
    const first = harness.emit("turn_end");
    const second = harness.emit("turn_end");
    release();
    await Promise.all([first, second]);
    expect(harness.appended).toHaveLength(1);
  });

  it("applies the ledger on context and rebuilds it after reload", async () => {
    const first = createHarness();
    await start(first);
    await first.emit("turn_end");
    const before = transcript();
    const contextResult = (await first.emit("context", {
      type: "context",
      messages: before,
    })) as {
      messages: AgentMessage[];
    };
    expect(contextResult.messages.length).toBeLessThan(before.length);

    const second = createHarness({ existingEntries: first.entries });
    await start(second, "reload");
    const rebuiltResult = (await second.emit("context", {
      type: "context",
      messages: before,
    })) as {
      messages: AgentMessage[];
    };
    expect(rebuiltResult.messages).toEqual(contextResult.messages);
  });

  it("returns a verbatim compaction entry when reduction is sufficient", async () => {
    const harness = createHarness();
    await start(harness);
    const result = (await harness.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [...harness.entries],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    })) as
      | {
          compaction?: {
            summary: string;
            firstKeptEntryId: string;
            tokensBefore: number;
          };
        }
      | undefined;
    expect(result?.compaction).toMatchObject({
      summary: expect.stringContaining("history kept verbatim"),
      firstKeptEntryId: "m1",
      tokensBefore: 70_000,
    });
  });

  it("falls through without ledger mutation on Jev failure and on low reduction", async () => {
    const failed = createHarness({ fail: true });
    await start(failed);
    const failure = await failed.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [...failed.entries],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(failure).toBeUndefined();
    expect(failed.appended).toHaveLength(0);
    expect(JSON.stringify(failed.notify.mock.calls)).not.toContain("TOPSECRET");

    const missingKey = createHarness({ keyFail: true });
    await start(missingKey);
    const missingKeyResult = await missingKey.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [...missingKey.entries],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(missingKeyResult).toBeUndefined();
    expect(missingKey.appended).toHaveLength(0);

    const low = createHarness({ answer: 0.9, minReductionRatio: 0.25 });
    await start(low);
    const lowResult = await low.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [...low.entries],
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(lowResult).toBeUndefined();
    expect(low.appended).toHaveLength(1);
  });

  it("supports status, on, off, and forced run commands", async () => {
    const harness = createHarness();
    await start(harness);
    const command = harness.commands.get("fast-jev");
    if (!command) throw new Error("command not registered");
    await command("", harness.context);
    await command("off", harness.context);
    await command("on", harness.context);
    await command("run", harness.context);
    expect(harness.appended).toHaveLength(1);
    expect(harness.notify).toHaveBeenCalled();
  });
});
