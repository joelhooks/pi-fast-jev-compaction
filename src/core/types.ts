/**
 * Ported from tamaratran/fast-jev-compaction (MIT).
 * Copyright (c) 2025. See THIRD_PARTY_NOTICES.md for the upstream license.
 */

export type Role = "user" | "assistant";

export interface ToolUse {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  text: string;
  isError: boolean;
}

export interface Message {
  sourceIndex: number;
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults: ToolResult[];
}

export interface ToolCall {
  id: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  pinned: boolean;
}

export interface CallAnswer {
  keepCall: number;
  keepResult: number;
}

export type CallAction = "keep" | "drop_result" | "drop_call";

export interface CallDecision extends CallAnswer {
  toolCallId: string;
  tool: string;
  action: CallAction;
  reason: "pinned" | "kept" | "result_dropped" | "call_dropped";
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  tool_calls?: HistoryToolCall[] | string[];
}

export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  stage: string;
}

export interface CompactOptions {
  goal?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface DecisionStats {
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
}

export interface DecisionResult {
  decisions: CallDecision[];
  calls: ToolCall[];
  stats: DecisionStats;
}

export type JevState = string | object;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export type JevQuestions = Record<string, NoulQuestion>;

export interface JevResponse {
  model?: string;
  answers: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface JevAsker {
  ask: (
    state: JevState,
    questions: JevQuestions,
    signal?: AbortSignal
  ) => Promise<JevResponse>;
}
