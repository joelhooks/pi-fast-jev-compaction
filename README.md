# `@joelhooks/pi-fast-jev-compaction`

A stock [Pi](https://github.com/badlogic/pi-mono) 0.85.1 extension that keeps conversation text verbatim while pruning stale tool history with [TypeSafe Jev](https://docs.typesafe.ai/docs/system-one/overview).

This is deliberately **layer 1 only**. It does not summarize, rewrite, or create memory. When pruning cannot free enough context, Pi's built-in summary compaction takes over.

## What it does

- Sends a compact representation of tool calls and surrounding conversation to TypeSafe's `/v1/systemone` endpoint.
- Asks two `noul` questions per eligible tool call: keep the call and keep its result.
- Keeps the first message and recent messages pinned.
- Applies three monotonic decisions:
  - `keep`: preserve the pair.
  - `drop_result`: preserve the tool call and a deterministic head of its result.
  - `drop_call`: remove the call and its matching result.
- Stores decisions as append-only `fast-jev-decisions` custom session entries.
- Rebuilds the ledger from the current session branch after startup, reload, resume, fork, or tree navigation.
- Filters only the context sent to the model. It never rewrites the JSONL session file.

User text, assistant text, thinking blocks, images outside pruned tool results, custom messages, and relative message order remain unchanged.

## Install

```bash
pi install git:github.com/joelhooks/pi-fast-jev-compaction
```

For one run without installing:

```bash
pi -e git:github.com/joelhooks/pi-fast-jev-compaction
```

The package targets Node 24.18 and Pi 0.85.1.

## API key

Set the runtime environment variable before starting Pi:

```bash
export TYPESAFE_API_KEY='...'
```

Or configure a command that prints the key to stdout:

```json
{
  "fastJevCompaction": {
    "apiKeyCommand": "your-key-helper print"
  }
}
```

The extension trims and caches the key in memory for the session. It does not log it or store it in custom entries. Failed commands and HTTP responses produce generic errors without echoing output or response bodies.

## Configuration

Add `fastJevCompaction` to `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

```json
{
  "fastJevCompaction": {
    "enabled": true,
    "model": "jev-latest",
    "baseUrl": "https://api.typesafe.ai/v1/systemone",
    "goal": "",
    "keepThreshold": 0.5,
    "preserveRecentMessages": 6,
    "maxStateTokens": 25000,
    "maxRequestTokens": 30000,
    "truncateHeadChars": 300,
    "compactAtPercent": 60,
    "minReductionRatio": 0.25,
    "cooldownTokens": 8000
  }
}
```

Project settings override global settings after Pi marks the project trusted.

| Setting | Meaning |
| --- | --- |
| `enabled` | Enable pruning for the session. |
| `model` | TypeSafe Jev model. |
| `baseUrl` | System One endpoint. |
| `goal` | Optional task goal sent as decision context. Recent user prompts are used when empty. |
| `keepThreshold` | `noul` values at or above this stay in context. |
| `preserveRecentMessages` | Pin this many messages at the end of the context. |
| `maxStateTokens` | Maximum estimated tokens in Jev's state. |
| `maxRequestTokens` | Maximum estimated state plus question tokens per request. |
| `truncateHeadChars` | Tool-result characters retained by `drop_result`. |
| `compactAtPercent` | Run proactively after a turn reaches this context percentage. |
| `minReductionRatio` | Minimum measured reduction required to replace Pi summary compaction. |
| `cooldownTokens` | Required context growth before another proactive run. |

## Commands

```text
/fast-jev          Show status, ledger size, and last-run stats
/fast-jev status   Same status output
/fast-jev run      Force one decision pass
/fast-jev on       Enable for this session
/fast-jev off      Disable for this session and abort an active pass
```

Each successful pass emits one concise notification and a small status-line indicator. The custom ledger entry renderer shows counts and reduction without exposing message content.

## Failure and fallback behavior

The extension fails open. A missing key, malformed Jev response, timeout, abort, network error, impossible request budget, overlapping pass, or insufficient reduction leaves Pi's built-in summary path available. Decisions are merged into the live ledger only after a complete, valid Jev result.

The pruning lifecycle is an explicit XState v5 machine:

```text
idle/applied/fallback/failed -> deciding -> applied | fallback | failed
```

It blocks overlapping work and enforces the proactive cooldown.

## Demo and checks

The demo uses a local fixture and makes no network request:

```bash
npm run demo
npm run check
npm run pack:dry
```

Tests inject fake Jev answers and fake Pi APIs. The test suite never contacts TypeSafe.

## Limits

- Tool-call/result pairing depends on Pi's tool-call IDs.
- `drop_result` removes images attached to that tool result along with the stale result body.
- Decisions are model judgments, not semantic proofs. Raise `keepThreshold` or pin more recent messages if pruning feels aggressive.
- This package does not implement durable memory or rewritten summaries.

## Attribution

The decision and state-fitting core is ported and adapted from [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction), used under the MIT License. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). New Pi lifecycle, ledger, filtering, tests, and documentation are also MIT licensed.
