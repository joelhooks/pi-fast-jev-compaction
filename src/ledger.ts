import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CallAction, CallDecision, DecisionStats } from "./core/types.ts";

export const DECISION_ENTRY_TYPE = "fast-jev-decisions";

export interface PersistedDecision {
  toolCallId: string;
  tool: string;
  action: CallAction;
  keepCall: number;
  keepResult: number;
}

export interface LedgerRunStats extends DecisionStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  reductionRatio: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface DecisionEntryData {
  version: 1;
  decisions: PersistedDecision[];
  stats: LedgerRunStats;
  ms: number;
}

export type DecisionLedger = Map<string, PersistedDecision>;

const ACTION_RANK: Record<CallAction, number> = {
  keep: 0,
  drop_result: 1,
  drop_call: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDecision(value: unknown): PersistedDecision | undefined {
  if (!isRecord(value)) return undefined;
  const { toolCallId, tool, action, keepCall, keepResult } = value;
  if (typeof toolCallId !== "string" || typeof tool !== "string")
    return undefined;
  if (action !== "keep" && action !== "drop_result" && action !== "drop_call")
    return undefined;
  if (typeof keepCall !== "number" || !Number.isFinite(keepCall))
    return undefined;
  if (typeof keepResult !== "number" || !Number.isFinite(keepResult))
    return undefined;
  return { toolCallId, tool, action, keepCall, keepResult };
}

export function persistedDecisions(
  decisions: readonly CallDecision[]
): PersistedDecision[] {
  return decisions.map(
    ({ toolCallId, tool, action, keepCall, keepResult }) => ({
      toolCallId,
      tool,
      action,
      keepCall,
      keepResult,
    })
  );
}

export function mergeDecisions(
  ledger: DecisionLedger,
  decisions: readonly PersistedDecision[]
): void {
  for (const decision of decisions) {
    const previous = ledger.get(decision.toolCallId);
    if (
      !previous ||
      ACTION_RANK[decision.action] > ACTION_RANK[previous.action]
    ) {
      ledger.set(decision.toolCallId, decision);
    }
  }
}

export function rebuildLedger(branch: readonly SessionEntry[]): DecisionLedger {
  const ledger: DecisionLedger = new Map();
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== DECISION_ENTRY_TYPE ||
      !isRecord(entry.data)
    )
      continue;
    if (entry.data.version !== 1 || !Array.isArray(entry.data.decisions))
      continue;
    mergeDecisions(
      ledger,
      entry.data.decisions.flatMap((value) => {
        const parsed = parseDecision(value);
        return parsed ? [parsed] : [];
      })
    );
  }
  return ledger;
}

function resultText(
  message: Extract<AgentMessage, { role: "toolResult" }>
): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function truncateResult(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  headChars: number
): Extract<AgentMessage, { role: "toolResult" }> {
  const text = resultText(message);
  const alreadyTruncated = text.includes("[fast-jev-compaction truncated ");
  const hasImages = message.content.some((block) => block.type === "image");
  if (alreadyTruncated || (!hasImages && text.length <= headChars + 120))
    return message;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  const note = `[fast-jev-compaction truncated ${Math.max(0, text.length - headChars)} chars of this tool result${message.isError ? " (error)" : ""}; re-run the tool if needed]`;
  return { ...message, content: [{ type: "text", text: `${head}${note}` }] };
}

export function applyLedger(
  messages: readonly AgentMessage[],
  ledger: ReadonlyMap<string, PersistedDecision>,
  truncateHeadChars: number
): AgentMessage[] {
  const filteredCalls = messages.flatMap((message): AgentMessage[] => {
    if (message.role !== "assistant") return [message];
    const content = message.content.filter((block) => {
      if (block.type !== "toolCall") return true;
      return ledger.get(block.id)?.action !== "drop_call";
    });
    if (content.length === 0) return [];
    if (!content.some((b) => b.type === "text" || b.type === "toolCall"))
      return [];
    return content.length === message.content.length
      ? [message]
      : [{ ...message, content }];
  });

  const survivingCalls = new Set<string>();
  for (const message of filteredCalls) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") survivingCalls.add(block.id);
    }
  }

  return filteredCalls.flatMap((message): AgentMessage[] => {
    if (message.role !== "toolResult") return [message];
    if (!survivingCalls.has(message.toolCallId)) return [];
    const action = ledger.get(message.toolCallId)?.action;
    if (action === "drop_call") return [];
    return action === "drop_result"
      ? [truncateResult(message, truncateHeadChars)]
      : [message];
  });
}

export function measureContextChars(messages: readonly AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

export function reductionRatio(
  charsBefore: number,
  charsAfter: number
): number {
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}
