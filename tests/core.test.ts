import { describe, expect, it } from "vitest";

import {
  batchCalls,
  buildJevRequest,
  collectToolCalls,
  decide,
  decideCall,
  estimateTokens,
  fitState,
  JevClient,
  parseJevResponse,
  resolveOptions,
  type HistoryToolCall,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from "../src/core/index.ts";

function message(
  role: Message["role"],
  text: string,
  extra: Partial<Message> = {}
): Message {
  return {
    sourceIndex: 0,
    role,
    text,
    toolUses: [],
    toolResults: [],
    ...extra,
  };
}

function call(
  id: string,
  tool: string,
  input: Record<string, unknown>
): Message {
  return message("assistant", "", {
    toolUses: [{ toolCallId: id, tool, input }],
  });
}

function result(id: string, text: string, isError = false): Message {
  return message("user", "", {
    toolResults: [{ toolCallId: id, text, isError }],
  });
}

const fileA = "export const a = 1;\n".repeat(50);
const fileB = "export const b = 2;\n".repeat(50);

function transcript(): Message[] {
  return [
    message(
      "user",
      "Never edit anything under src/generated. Fix the failing test."
    ),
    call("tool-1", "read", { path: "src/a.ts" }),
    result("tool-1", fileA),
    message("assistant", "a.ts looks fine; checking b.ts"),
    call("tool-2", "read", { path: "src/b.ts" }),
    result("tool-2", fileB),
    call("tool-3", "bash", { command: "npm test" }),
    result("tool-3", "FAIL b.test.ts: expected 2 to be 3", true),
    message("assistant", "The failure is in b.test.ts; fixing now."),
    message("user", "go ahead"),
  ].map((entry, sourceIndex) => ({ ...entry, sourceIndex }));
}

interface Seen {
  state: unknown;
  questions: string[];
}

function fakeJev(
  answer: (name: string) => number,
  seen: Seen[] = []
): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: "noul", noul: answer(key) },
          ])
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: "fix the test",
};

describe("vendored options and token estimate", () => {
  it("fills defaults and ignores non-finite values", () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    });
    expect(
      resolveOptions({ preserveRecentMessages: 2.7, truncateHeadChars: -1 })
    ).toMatchObject({
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });

  it("charges words, digits, and symbols separately", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(2);
    expect(estimateTokens("internationalization")).toBe(4);
    expect(estimateTokens("12345678")).toBe(4);
  });
});

describe("vendored call collection and state fitting", () => {
  it("pairs calls with results and pins the first and recent messages", () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(
      calls.map((entry) => [
        entry.id,
        entry.tool,
        entry.callIndex,
        entry.resultIndex,
        entry.pinned,
      ])
    ).toEqual([
      ["t1", "read", 1, 2, false],
      ["t2", "read", 4, 5, false],
      ["t3", "bash", 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
  });

  it("ignores calls without a result", () => {
    expect(
      collectToolCalls([message("user", "hi"), call("x", "read", {})], 0)
    ).toHaveLength(0);
  });

  it("omits tool results from state and defaults goal to recent prompts", () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      goal: "",
    });
    expect(stage).toBe("full");
    const json = JSON.stringify(state);
    expect(json).not.toContain("export const a = 1;");
    expect(json).toContain("Never edit anything under src/generated");
    expect(state.goal).toContain("go ahead");
    const firstToolCall = state.history[1]?.tool_calls?.[0] as
      | HistoryToolCall
      | undefined;
    expect(firstToolCall?.result).toBe(`ok, ${fileA.length} chars (omitted)`);
  });

  it("shrinks inputs, old calls, and then merged call runs", () => {
    const inputMessages = [
      message("user", "start"),
      call("w", "write", { path: "x.ts", content: "x".repeat(5000) }),
      result("w", "ok"),
      message("assistant", "written"),
    ];
    const inputFit = fitState(
      inputMessages,
      collectToolCalls(inputMessages, 0),
      { ...fit, maxStateTokens: 300 }
    );
    expect(inputFit.stage).toBe("inputs<=200");

    const many = [message("user", "start")];
    for (let index = 0; index < 40; index += 1) {
      many.push(
        call(`c${index}`, "read", { path: `/repo/src/module-${index}.ts` }),
        result(`c${index}`, "x")
      );
    }
    many.push(message("assistant", "done"));
    const calls = collectToolCalls(many, 1);
    const full = fitState(many, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(many, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe("old calls compacted");
    const merged = fitState(many, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe("old calls merged");
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
  });

  it("throws when state cannot fit", () => {
    const messages = [
      message("user", "a".repeat(2000)),
      message("assistant", "b"),
    ];
    expect(() =>
      fitState(messages, [], { ...fit, maxStateTokens: 50 })
    ).toThrow(/too large/u);
  });
});

describe("vendored batching and decisions", () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, index) => ({
    id: `t${index + 1}`,
    toolCallId: `tool-${index + 1}`,
    tool: "read",
    input: {},
    callIndex: index * 2 + 1,
    resultIndex: index * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));

  it("batches under the request ceiling and rejects an impossible batch", () => {
    expect(batchCalls(calls, 1000, { maxRequestTokens: 30_000 })).toHaveLength(
      1
    );
    expect(
      batchCalls(calls, 29_600, { maxRequestTokens: 30_000 }).length
    ).toBeGreaterThan(1);
    expect(() =>
      batchCalls(calls, 29_990, { maxRequestTokens: 30_000 })
    ).toThrow(/no room/u);
  });

  it("maps probabilities to keep, truncate, and drop", () => {
    const candidate = { toolCallId: "x", tool: "read", pinned: false };
    expect(
      decideCall(
        candidate,
        { keepCall: 0.9, keepResult: 0.7 },
        { keepThreshold: 0.5 }
      ).action
    ).toBe("keep");
    expect(
      decideCall(
        candidate,
        { keepCall: 0.9, keepResult: 0.2 },
        { keepThreshold: 0.5 }
      ).action
    ).toBe("drop_result");
    expect(
      decideCall(
        candidate,
        { keepCall: 0.1, keepResult: 0.2 },
        { keepThreshold: 0.5 }
      ).action
    ).toBe("drop_call");
  });

  it("resends full state across batches and merges answers", async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: "",
      preserveRecentMessages: 1,
    }).tokens;
    const output = await decide(
      messages,
      fakeJev((name) => (name.startsWith("call_") ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 }
    );
    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen.map((entry) => JSON.stringify(entry.state))).size).toBe(
      1
    );
    expect(output.decisions.map((entry) => entry.action)).toEqual([
      "drop_result",
      "drop_result",
      "drop_result",
    ]);
  });

  it("rejects malformed answers and aborts", async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { type: "noul", noul: 0.5 } } }),
    };
    await expect(
      decide(transcript(), broken, { preserveRecentMessages: 1 })
    ).rejects.toThrow(/Invalid Jev answer/u);

    const controller = new AbortController();
    controller.abort();
    await expect(
      decide(
        transcript(),
        fakeJev(() => 1),
        { preserveRecentMessages: 1 },
        controller.signal
      )
    ).rejects.toThrow(/abort/iu);
  });
});

describe("TypeSafe HTTP contract", () => {
  it("builds the documented System One request", () => {
    const request = buildJevRequest(
      { apiKey: "secret-value" },
      { a: 1 },
      {
        q: { type: "noul", instructions: "x" },
      }
    );
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(request.body)).toEqual({
      model: "jev-latest",
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "x" } },
    });
  });

  it("rejects failed and malformed responses without echoing response bodies", () => {
    expect(() => parseJevResponse(500, false, "secret-value")).toThrow(
      "Jev request failed (500)"
    );
    expect(() => parseJevResponse(200, true, "not json")).toThrow(/malformed/u);
    expect(() => parseJevResponse(200, true, "{}")).toThrow(/missing answers/u);
  });

  it("uses injected fetch and refuses a missing key", async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: "k",
      model: "jev-test",
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Response.json(
          { answers: { q: { type: "noul", noul: 0.4 } } },
          { status: 200 }
        );
      },
    });
    const response = await client.ask("state", {
      q: { type: "noul", instructions: "x" },
    });
    expect(response.answers.q).toEqual({ type: "noul", noul: 0.4 });
    expect(JSON.parse(bodies[0] ?? "{}").model).toBe("jev-test");
    await expect(
      new JevClient({ apiKey: "" }).ask("state", {})
    ).rejects.toThrow(/not configured/u);
  });
});
