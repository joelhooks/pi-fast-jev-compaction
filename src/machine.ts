import { assign, createActor, setup } from "xstate";

export type RunMode = "proactive" | "compaction" | "manual";
export type RunOutcome = "applied" | "fallback" | "failed";

interface LifecycleContext {
  cooldownTokens: number;
  lastRunTokens: number | null;
  pendingTokens: number;
  mode: RunMode | null;
  lastOutcome: RunOutcome | null;
}

type LifecycleEvent =
  | { type: "START"; tokens: number; mode: RunMode; force: boolean }
  | { type: "APPLIED" }
  | { type: "FALLBACK" }
  | { type: "FAILED" }
  | { type: "ABORT" };

function startTransition() {
  return { guard: "canStart", target: "deciding", actions: "begin" } as const;
}

export function createLifecycleMachine(cooldownTokens: number) {
  return setup({
    types: {
      context: {} as LifecycleContext,
      events: {} as LifecycleEvent,
    },
    guards: {
      canStart: ({ context, event }) => {
        if (event.type !== "START") return false;
        if (
          event.force ||
          event.mode !== "proactive" ||
          context.lastRunTokens === null
        )
          return true;
        return event.tokens - context.lastRunTokens >= context.cooldownTokens;
      },
    },
    actions: {
      begin: assign(({ event }) => {
        if (event.type !== "START") return {};
        return { pendingTokens: event.tokens, mode: event.mode };
      }),
      applied: assign(({ context }) => ({
        lastRunTokens: context.pendingTokens,
        lastOutcome: "applied" as const,
        mode: null,
      })),
      fallback: assign(({ context }) => ({
        lastRunTokens: context.pendingTokens,
        lastOutcome: "fallback" as const,
        mode: null,
      })),
      failed: assign(({ context }) => ({
        lastRunTokens: context.pendingTokens,
        lastOutcome: "failed" as const,
        mode: null,
      })),
      abort: assign({ mode: null }),
    },
  }).createMachine({
    id: "fastJevCompaction",
    initial: "idle",
    context: {
      cooldownTokens,
      lastRunTokens: null,
      pendingTokens: 0,
      mode: null,
      lastOutcome: null,
    },
    states: {
      idle: { on: { START: startTransition() } },
      deciding: {
        on: {
          APPLIED: { target: "applied", actions: "applied" },
          FALLBACK: { target: "fallback", actions: "fallback" },
          FAILED: { target: "failed", actions: "failed" },
          ABORT: { target: "idle", actions: "abort" },
        },
      },
      applied: { on: { START: startTransition() } },
      fallback: { on: { START: startTransition() } },
      failed: { on: { START: startTransition() } },
    },
  });
}

export class CompactionLifecycle {
  readonly #actor;

  constructor(cooldownTokens: number) {
    this.#actor = createActor(createLifecycleMachine(cooldownTokens));
    this.#actor.start();
  }

  begin(tokens: number, mode: RunMode, force = false): boolean {
    if (this.#actor.getSnapshot().matches("deciding")) return false;
    this.#actor.send({ type: "START", tokens, mode, force });
    return this.#actor.getSnapshot().matches("deciding");
  }

  finish(outcome: RunOutcome): void {
    if (outcome === "applied") {
      this.#actor.send({ type: "APPLIED" });
      return;
    }
    if (outcome === "fallback") {
      this.#actor.send({ type: "FALLBACK" });
      return;
    }
    this.#actor.send({ type: "FAILED" });
  }

  abort(): void {
    this.#actor.send({ type: "ABORT" });
  }

  isDeciding(): boolean {
    return this.#actor.getSnapshot().matches("deciding");
  }

  snapshot() {
    return this.#actor.getSnapshot();
  }

  stop(): void {
    this.#actor.stop();
  }
}
