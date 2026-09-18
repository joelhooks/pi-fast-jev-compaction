import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { adaptMessages } from "../src/adapter.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type FastJevConfig,
} from "../src/config.ts";
import { decide } from "../src/core/decide.ts";
import { JevClient, type JevClientOptions } from "../src/core/request.ts";
import { collectToolCalls } from "../src/core/state.ts";
import type { DecisionResult, JevAsker } from "../src/core/types.ts";
import { createKeyResolver, type KeyResolver } from "../src/key.ts";
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
  type LedgerRunStats,
} from "../src/ledger.ts";
import { CompactionLifecycle, type RunMode } from "../src/machine.ts";

export interface FastJevExtensionOptions {
  loadConfig?: (cwd: string, projectTrusted: boolean) => Promise<FastJevConfig>;
  createAsker?: (options: JevClientOptions) => JevAsker;
  keyResolver?: KeyResolver;
}

interface AppliedRun {
  outcome: "applied";
  result: DecisionResult;
  stats: LedgerRunStats;
}

interface SkippedRun {
  outcome: "skipped" | "failed";
}

type RunResult = AppliedRun | SkippedRun;

function fallbackCompaction(): undefined {
  return undefined;
}

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
  return ctx.sessionManager
    .buildContextEntries()
    .flatMap(sessionEntryToContextMessages);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function summary(stats: LedgerRunStats): string {
  return `${percent(stats.reductionRatio)} reduction; ${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped, ${stats.pinned} pinned; ${stats.requests} request(s)`;
}

function statusText(
  enabled: boolean,
  ledger: DecisionLedger,
  stats: LedgerRunStats | undefined
): string {
  if (!enabled) return "fast-jev: off";
  if (!stats) return `fast-jev: on; ledger ${ledger.size}; no run yet`;
  return `fast-jev: on; ledger ${ledger.size}; ${summary(stats)}`;
}

export function installFastJevCompaction(
  pi: ExtensionAPI,
  options: FastJevExtensionOptions = {}
): void {
  let config = { ...DEFAULT_CONFIG };
  let enabled = config.enabled;
  let ledger: DecisionLedger = new Map();
  let lifecycle = new CompactionLifecycle(config.cooldownTokens);
  let lastStats: LedgerRunStats | undefined;
  let activeController: AbortController | undefined;
  const resolveKey = options.keyResolver ?? createKeyResolver(pi);
  const configLoader = options.loadConfig ?? loadConfig;
  const createAsker =
    options.createAsker ??
    ((clientOptions: JevClientOptions) => new JevClient(clientOptions));

  const updateStatus = (ctx: ExtensionContext): void => {
    const pruned = lastStats
      ? lastStats.callsDropped + lastStats.resultsDropped
      : 0;
    ctx.ui.setStatus(
      "fast-jev",
      enabled && pruned > 0 ? `jev: ${pruned} pruned` : undefined
    );
  };

  const runDecision = async (
    ctx: ExtensionContext,
    messages: readonly AgentMessage[],
    tokens: number,
    mode: RunMode,
    signal: AbortSignal | undefined,
    force = false
  ): Promise<RunResult> => {
    if (!enabled || !lifecycle.begin(tokens, mode, force))
      return { outcome: "skipped" };
    try {
      signal?.throwIfAborted();
      const adapted = adaptMessages(
        applyLedger(messages, ledger, config.truncateHeadChars)
      );
      if (
        collectToolCalls(adapted, config.preserveRecentMessages).some(
          (call) => !call.pinned
        )
      ) {
        const apiKey = await resolveKey.resolve(config.apiKeyCommand, signal);
        signal?.throwIfAborted();
        const result = await decide(
          adapted,
          createAsker({ apiKey, model: config.model, baseUrl: config.baseUrl }),
          config,
          signal
        );
        signal?.throwIfAborted();
        return persistRun(ctx, messages, result);
      }
      const result = await decide(
        adapted,
        createAsker({
          apiKey: "",
          model: config.model,
          baseUrl: config.baseUrl,
        }),
        config,
        signal
      );
      return persistRun(ctx, messages, result);
    } catch {
      lifecycle.finish("failed");
      ctx.ui.notify(
        "fast-jev: decision failed; falling back to Pi compaction",
        "warning"
      );
      return { outcome: "failed" };
    }
  };

  const persistRun = (
    ctx: ExtensionContext,
    messages: readonly AgentMessage[],
    result: DecisionResult
  ): AppliedRun => {
    const staged = new Map(ledger);
    const persisted = persistedDecisions(result.decisions);
    mergeDecisions(staged, persisted);
    const before = applyLedger(messages, ledger, config.truncateHeadChars);
    const after = applyLedger(messages, staged, config.truncateHeadChars);
    const charsBefore = measureContextChars(before);
    const charsAfter = measureContextChars(after);
    let cacheRead = 0;
    let cacheWrite = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role === "assistant") {
        cacheRead = m.usage.cacheRead ?? 0;
        cacheWrite = m.usage.cacheWrite ?? 0;
        break;
      }
    }
    const stats: LedgerRunStats = {
      ...result.stats,
      messagesBefore: before.length,
      messagesAfter: after.length,
      charsBefore,
      charsAfter,
      reductionRatio: reductionRatio(charsBefore, charsAfter),
      cacheRead,
      cacheWrite,
    };
    const entry: DecisionEntryData = {
      version: 1,
      decisions: persisted,
      stats,
      ms: result.stats.ms,
    };
    pi.appendEntry(DECISION_ENTRY_TYPE, entry);
    ledger = staged;
    lastStats = stats;
    lifecycle.finish(
      stats.reductionRatio >= config.minReductionRatio ? "applied" : "fallback"
    );
    updateStatus(ctx);
    ctx.ui.notify(`fast-jev: ${summary(stats)}`, "info");
    return { outcome: "applied", result, stats };
  };

  pi.registerEntryRenderer<DecisionEntryData>(
    DECISION_ENTRY_TYPE,
    (entry, _renderOptions, theme) => {
      const stats = entry.data?.stats;
      const line = stats
        ? `jev: ${stats.callsDropped + stats.resultsDropped} pruned · ${percent(stats.reductionRatio)} reduction · ${stats.requests} request(s)`
        : "jev: decisions unavailable";
      return new Text(theme.fg("dim", line), 0, 0);
    }
  );

  pi.on("session_start", async (_event, ctx) => {
    config = await configLoader(ctx.cwd, ctx.isProjectTrusted());
    enabled = config.enabled;
    ledger = rebuildLedger(ctx.sessionManager.getBranch());
    lifecycle.stop();
    lifecycle = new CompactionLifecycle(config.cooldownTokens);
    lastStats = undefined;
    updateStatus(ctx);
  });

  pi.on("context", (_event, _ctx) => {
    if (!enabled || ledger.size === 0) return { messages: _event.messages };
    return {
      messages: applyLedger(_event.messages, ledger, config.truncateHeadChars),
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!enabled || usage?.percent === null || usage?.tokens === null) return;
    if (usage === undefined || usage.percent < config.compactAtPercent) return;
    activeController = new AbortController();
    try {
      await runDecision(
        ctx,
        branchMessages(ctx),
        usage.tokens,
        "proactive",
        activeController.signal
      );
    } finally {
      activeController = undefined;
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled) return fallbackCompaction();
    const run = await runDecision(
      ctx,
      branchMessages(ctx),
      event.preparation.tokensBefore,
      "compaction",
      event.signal,
      true
    );
    if (
      run.outcome !== "applied" ||
      run.stats.reductionRatio < config.minReductionRatio
    ) {
      ctx.ui.notify(
        "fast-jev: reduction too small; using Pi's built-in summary",
        "warning"
      );
      return fallbackCompaction();
    }
    const firstEntryId = event.branchEntries[0]?.id;
    if (!firstEntryId) return fallbackCompaction();
    return {
      compaction: {
        summary: `fast-jev-compaction: ${run.stats.callsDropped + run.stats.resultsDropped} tool results pruned, history kept verbatim.`,
        firstKeptEntryId: firstEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { fastJev: run.stats },
      },
    };
  });

  pi.registerCommand("fast-jev", {
    description: "Show or control fast Jev context pruning (run|on|off)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        enabled = true;
        updateStatus(ctx);
        ctx.ui.notify("fast-jev: enabled for this session", "info");
        return;
      }
      if (action === "off") {
        enabled = false;
        activeController?.abort();
        lifecycle.abort();
        updateStatus(ctx);
        ctx.ui.notify("fast-jev: disabled for this session", "info");
        return;
      }
      if (action === "run") {
        await ctx.waitForIdle();
        const usage = ctx.getContextUsage();
        activeController = new AbortController();
        try {
          await runDecision(
            ctx,
            branchMessages(ctx),
            usage?.tokens ?? 0,
            "manual",
            activeController.signal,
            true
          );
        } finally {
          activeController = undefined;
        }
        return;
      }
      const usage = ctx.getContextUsage();
      ctx.ui.notify(
        `${statusText(enabled, ledger, lastStats)}; context ${usage?.percent === null || usage?.percent === undefined ? "unknown" : `${Math.round(usage.percent)}%`}`,
        "info"
      );
    },
  });

  pi.on("session_shutdown", () => {
    activeController?.abort();
    lifecycle.abort();
    lifecycle.stop();
    resolveKey.clear();
  });
}

export default function fastJevCompaction(pi: ExtensionAPI): void {
  installFastJevCompaction(pi);
}
