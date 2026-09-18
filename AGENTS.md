# Contributor notes

This package is a stock Pi 0.85.1 extension. Keep it layer 1: prune stale tool calls and results from model context without rewriting user or assistant prose, creating summaries, or mutating the session JSONL.

## Non-negotiable invariants

- Persist decisions only as append-only `fast-jev-decisions` custom entries.
- Rebuild the ledger from `ctx.sessionManager.getBranch()`.
- Merge decisions monotonically: `keep < drop_result < drop_call`.
- Never leave a tool result without its matching call.
- Keep built-in summary fallback behind `fallbackCompaction()` in `session_before_compact`.
- Fail open on missing credentials, network errors, malformed responses, budget failures, aborts, or insufficient reduction.
- Never print or persist API keys, command output, or failed HTTP response bodies.
- Never add a credential-manager identifier to this repository. Runtime environment variables and user-configured commands are the boundary.
- Tests must not use the network.

## Workflow

Use TDD. Add or change a failing test, implement the smallest fix, then run:

```bash
npm run check
npm run demo
npm run pack:dry
```

For Pi lifecycle behavior, extend the fake API tests in `tests/extension.test.ts`. For state fitting and TypeSafe's contract, work in `src/core/` and `tests/core.test.ts`. For persisted decisions and message fidelity, work in `src/ledger.ts` and `tests/ledger.test.ts`.

The lifecycle belongs in the XState v5 machine at `src/machine.ts`. Do not replace explicit states with overlapping booleans.

## Upstream boundary

`src/core/*.ts` is ported and adapted from `tamaratran/fast-jev-compaction` under MIT. Preserve the attribution header in those files and update `THIRD_PARTY_NOTICES.md` if the upstream boundary changes.
