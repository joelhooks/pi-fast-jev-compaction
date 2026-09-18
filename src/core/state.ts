/**
 * Ported from tamaratran/fast-jev-compaction (MIT).
 * Copyright (c) 2025. See THIRD_PARTY_NOTICES.md for the upstream license.
 */

import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
} from "./types.ts";

export const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted from model context, but the assistant can re-run a tool or re-read a file.";

const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/gu;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.codePointAt(0) ?? 0;
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  for (const [index, message] of messages.entries()) {
    for (const result of message.toolResults) {
      results.set(result.toolCallId, { index, result });
    }
  }

  const calls: ToolCall[] = [];
  for (const [callIndex, message] of messages.entries()) {
    for (const tool of message.toolUses) {
      const found = results.get(tool.toolCallId);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        toolCallId: tool.toolCallId,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  }
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = "";
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text =
        typeof value === "string" ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replaceAll(/\s+/gu, " ")}`;
    })
    .join(" ");
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.resultChars}ch`;
}

function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (entry: HistoryEntry) => boolean
): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged.at(-1);
    const foldable = (candidate: HistoryEntry): boolean =>
      !pinned(candidate) &&
      candidate.text.length === 0 &&
      typeof candidate.tool_calls?.[0] === "string";
    if (
      previous &&
      foldable(previous) &&
      foldable(entry) &&
      previous.role === entry.role
    ) {
      previous.tool_calls = [
        ...(previous.tool_calls as string[]),
        ...(entry.tool_calls as string[]),
      ];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  for (const [index, message] of messages.entries()) {
    const toolCalls = (byMessage.get(index) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) continue;
    const entry: HistoryEntry = {
      i: index,
      role: message.role,
      text: message.text,
    };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  }
  return entries;
}

export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.text.trim().length > 0 &&
        message.toolResults.length === 0
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join("\n");
}

export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<
    ResolvedCompactOptions,
    "maxStateTokens" | "preserveRecentMessages" | "goal"
  >
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number =>
    estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (
    history: HistoryEntry[],
    tokens: number,
    stage: string
  ): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (
    index: number,
    change: (entry: HistoryEntry) => void
  ): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, "full");

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => {
      const entry = history[index];
      return entry ? !pinned(entry) : false;
    }),
    ...indices.filter((index) => {
      const entry = history[index];
      return entry ? pinned(entry) : false;
    }),
  ];

  for (const index of order) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (candidate) => {
      candidate.text = abridge(candidate.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }

  for (const index of order) {
    const entry = history[index];
    if (!entry || pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (candidate) => {
      candidate.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index];
    if (!entry) continue;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (candidate) => {
      candidate.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index];
    if (!entry || pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, currentIndex) => !left.has(currentIndex)),
        tokens,
        "old messages left out"
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, index) => !left.has(index)),
    pinned
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
  if (fits()) return fitted(history, tokens, "old calls merged");

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`
  );
}
