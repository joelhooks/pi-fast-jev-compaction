import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { toolTranscript } from "../examples/tool-transcript.ts";
import { adaptMessages } from "../src/adapter.ts";
import {
  applyLedger,
  DECISION_ENTRY_TYPE,
  measureContextChars,
  mergeDecisions,
  persistedDecisions,
  rebuildLedger,
  reductionRatio,
  type DecisionEntryData,
  type DecisionLedger,
  type PersistedDecision,
} from "../src/ledger.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(
  content: AssistantMessage["content"],
  timestamp = 2
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(
  toolCallId: string,
  text: string,
  timestamp = 3,
  isError = false
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

function decision(
  toolCallId: string,
  action: PersistedDecision["action"]
): PersistedDecision {
  return { toolCallId, tool: "read", action, keepCall: 0.1, keepResult: 0.1 };
}

function messages(): AgentMessage[] {
  return [
    user("Fix the test exactly."),
    assistant([
      { type: "thinking", thinking: "Need both files." },
      { type: "text", text: "Checking files." },
      {
        type: "toolCall",
        id: "call-a",
        name: "read",
        arguments: { path: "a.ts" },
      },
      {
        type: "toolCall",
        id: "call-b",
        name: "read",
        arguments: { path: "b.ts" },
      },
    ]),
    toolResult("call-a", "A".repeat(1000)),
    toolResult("call-b", "B".repeat(1000), 4),
    assistant([{ type: "text", text: "The bug is in b.ts." }], 5),
    user("go", 6),
  ];
}

function entry(
  id: string,
  decisions: PersistedDecision[]
): CustomEntry<DecisionEntryData> {
  return {
    type: "custom",
    customType: DECISION_ENTRY_TYPE,
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    data: {
      version: 1,
      decisions,
      stats: {
        calls: decisions.length,
        kept: 0,
        resultsDropped: 0,
        callsDropped: 0,
        pinned: 0,
        stateTokens: 1,
        stateStage: "full",
        requests: 1,
        ms: 1,
        messagesBefore: 1,
        messagesAfter: 1,
        charsBefore: 1,
        charsAfter: 1,
        reductionRatio: 0,
      },
      ms: 1,
    },
  };
}

describe("Pi message adapter", () => {
  it("pairs assistant calls and tool results while exposing text and thinking to Jev", () => {
    const adapted = adaptMessages(messages());
    expect(adapted).toHaveLength(6);
    expect(adapted[1]).toMatchObject({
      role: "assistant",
      text: "[thinking]\nNeed both files.\nChecking files.",
      toolUses: [
        { toolCallId: "call-a", tool: "read", input: { path: "a.ts" } },
        { toolCallId: "call-b", tool: "read", input: { path: "b.ts" } },
      ],
    });
    expect(adapted[2]?.toolResults[0]).toMatchObject({
      toolCallId: "call-a",
      isError: false,
    });
  });
});

describe("decision ledger", () => {
  it("merges monotonically so later keep decisions cannot restore pruned context", () => {
    const ledger: DecisionLedger = new Map();
    mergeDecisions(ledger, [decision("x", "drop_result")]);
    mergeDecisions(ledger, [decision("x", "keep")]);
    expect(ledger.get("x")?.action).toBe("drop_result");
    mergeDecisions(ledger, [decision("x", "drop_call")]);
    expect(ledger.get("x")?.action).toBe("drop_call");
  });

  it("rebuilds the same ledger from current-branch entries in order", () => {
    const inMemory: DecisionLedger = new Map();
    mergeDecisions(inMemory, [decision("a", "drop_result")]);
    mergeDecisions(inMemory, [
      decision("a", "keep"),
      decision("b", "drop_call"),
    ]);
    const rebuilt = rebuildLedger([
      entry("e1", [decision("a", "drop_result")]),
      entry("e2", [decision("a", "keep"), decision("b", "drop_call")]),
    ]);
    expect([...rebuilt.entries()]).toEqual([...inMemory.entries()]);
    expect(
      rebuildLedger([entry("other-branch", [decision("z", "drop_call")])]).has(
        "a"
      )
    ).toBe(false);
  });

  it("persists only the public decision fields", () => {
    expect(
      persistedDecisions([
        {
          toolCallId: "x",
          tool: "read",
          action: "drop_call",
          reason: "call_dropped",
          keepCall: 0.1,
          keepResult: 0.2,
        },
      ])
    ).toEqual([
      {
        toolCallId: "x",
        tool: "read",
        action: "drop_call",
        keepCall: 0.1,
        keepResult: 0.2,
      },
    ]);
  });
});

describe("ledger application", () => {
  it("filters the before/after demo fixture deterministically", () => {
    const ledger: DecisionLedger = new Map([
      ["fixture-call", decision("fixture-call", "drop_result")],
    ]);
    const applied = applyLedger(toolTranscript, ledger, 80);
    expect(applied).toHaveLength(toolTranscript.length);
    expect(measureContextChars(applied)).toBeLessThan(
      measureContextChars(toolTranscript)
    );
    expect(JSON.stringify(applied)).toContain("important header");
    expect(JSON.stringify(applied)).toContain("fast-jev-compaction truncated");
  });

  it("drops a call with its result and truncates another result only", () => {
    const original = messages();
    const ledger: DecisionLedger = new Map([
      ["call-a", decision("call-a", "drop_call")],
      ["call-b", decision("call-b", "drop_result")],
    ]);
    const applied = applyLedger(original, ledger, 50);

    expect(applied.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    const changedAssistant = applied[1];
    expect(changedAssistant?.role).toBe("assistant");
    if (changedAssistant?.role !== "assistant")
      throw new Error("expected assistant");
    expect(changedAssistant.content).toEqual([
      { type: "thinking", thinking: "Need both files." },
      { type: "text", text: "Checking files." },
      {
        type: "toolCall",
        id: "call-b",
        name: "read",
        arguments: { path: "b.ts" },
      },
    ]);
    const changedResult = applied[2];
    expect(changedResult?.role).toBe("toolResult");
    if (changedResult?.role !== "toolResult")
      throw new Error("expected result");
    expect(changedResult.content[0]).toMatchObject({
      type: "text",
      text: `${"B".repeat(50)}\n[fast-jev-compaction truncated 950 chars of this tool result; re-run the tool if needed]`,
    });

    expect(original[0]).toBe(applied[0]);
    expect(original[4]).toBe(applied[3]);
    expect(original[5]).toBe(applied[4]);
    expect(JSON.stringify(original)).toContain("call-a");
  });

  it("is idempotent and removes orphan results left by an already-compacted context", () => {
    const ledger: DecisionLedger = new Map([
      ["call-b", decision("call-b", "drop_result")],
    ]);
    const once = applyLedger(messages(), ledger, 25);
    const twice = applyLedger(once, ledger, 25);
    expect(twice).toEqual(once);

    const orphan = applyLedger(
      [user("kept"), toolResult("missing", "orphan")],
      new Map(),
      25
    );
    expect(orphan).toEqual([user("kept")]);
  });

  it("never changes user text, assistant text, thinking, or relative order", () => {
    const original = messages();
    const applied = applyLedger(
      original,
      new Map([
        ["call-a", decision("call-a", "drop_call")],
        ["call-b", decision("call-b", "drop_call")],
      ]),
      10
    );
    expect(applied).toEqual([
      user("Fix the test exactly."),
      assistant([
        { type: "thinking", thinking: "Need both files." },
        { type: "text", text: "Checking files." },
      ]),
      assistant([{ type: "text", text: "The bug is in b.ts." }], 5),
      user("go", 6),
    ]);
  });

  it("reports a positive character reduction without exposing message content", () => {
    const original = messages();
    const applied = applyLedger(
      original,
      new Map([["call-a", decision("call-a", "drop_call")]]),
      50
    );
    const before = measureContextChars(original);
    const after = measureContextChars(applied);
    expect(after).toBeLessThan(before);
    expect(reductionRatio(before, after)).toBeGreaterThan(0);
  });
});
