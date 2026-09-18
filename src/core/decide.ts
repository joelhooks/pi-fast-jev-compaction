/**
 * Ported from tamaratran/fast-jev-compaction (MIT).
 * Copyright (c) 2025. See LICENSE for the upstream notice.
 */

import { noulAnswer } from "./request.ts";
import { collectToolCalls, estimateTokens, fitState } from "./state.ts";
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactionState,
  DecisionResult,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
} from "./types.ts";

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
};

const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(
  options: CompactOptions = {}
): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(
          options.preserveRecentMessages,
          DEFAULT_OPTIONS.preserveRecentMessages
        )
      )
    ),
    maxStateTokens: Math.max(
      1,
      finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)
    ),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(
        finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)
      )
    ),
  };
}

export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, "maxRequestTokens">
): ToolCall[][] {
  const budget =
    options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, "toolCallId" | "tool" | "pinned">,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, "keepThreshold">
): CallDecision {
  const base = { toolCallId: call.toolCallId, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (answer.keepResult >= options.keepThreshold)
    return { ...base, action: "keep", reason: "kept" };
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: "drop_result", reason: "result_dropped" };
  }
  return { ...base, action: "drop_call", reason: "call_dropped" };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  signal?: AbortSignal
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions, signal);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ])
  );
}

function count(
  decisions: readonly CallDecision[],
  reason: CallDecision["reason"]
): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

export async function decide(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
  signal?: AbortSignal
): Promise<DecisionResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: "" };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    signal?.throwIfAborted();
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch, signal))
    );
    signal?.throwIfAborted();
    for (const map of answered) {
      for (const [id, answer] of map) answers.set(id, answer);
    }
  }

  const decisions = calls.map((call) =>
    decideCall(
      call,
      answers.get(call.id) ?? { keepCall: 1, keepResult: 1 },
      resolved
    )
  );
  return {
    decisions,
    calls,
    stats: {
      calls: calls.length,
      kept: count(decisions, "kept"),
      resultsDropped: count(decisions, "result_dropped"),
      callsDropped: count(decisions, "call_dropped"),
      pinned: count(decisions, "pinned"),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
