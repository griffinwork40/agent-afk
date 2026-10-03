# Usage awareness (rate limits and subscription windows)

AFK knows how much provider headroom it has, and that knowledge is shared by
every AFK process on the machine (REPL panes, the daemon, the Telegram bot,
`afk usage`). The runtime acts on it; the model only hears about it when it
matters.

## Layers

| Layer | File | What it does |
|---|---|---|
| Capture | `src/agent/providers/shared/rate-limit-headers.ts`, `src/agent/quota-cache.ts` | Parse per-minute `anthropic-ratelimit-*` / `x-ratelimit-*` headers and the Claude subscription `anthropic-ratelimit-unified-*` (5h / 7d) headers on every response. Unchanged by this feature. |
| Record model | `src/agent/usage/usage-record.ts` | `UsageRecord` per provider+account; monotone merge rules (a section is replaced only by an observation with a newer `observedAt`; `frozenUntil` merges by max). |
| Ledger | `src/agent/usage/usage-ledger.ts` | The single cross-process store: SQLite state store (`state/kv/kv.db`, namespace `usage`), lossless read-modify-write via `StateStore.cas` / `insertIfAbsent`. Unchanged publishes are throttled to one per 5s per key; 429 freezes publish immediately. |
| Admission | `src/agent/providers/shared/rate-limit-bucket.registry.ts` | One `RateLimitBucket` per provider+account (Anthropic per auth mode, OpenAI-compatible per endpoint host), so one provider's headers never overwrite another's. Each bucket reads its own ledger key at most once per second and adopts a peer's unexpired freeze and any lower, fresher remaining count, so every process backs off together. Adoption only ever makes a bucket more cautious. |
| Reader | `src/agent/usage/usage-snapshot.ts` | The one reader every consumer uses (`readUsageRecords`, `readUsageRecord`, `collectUsage`). Merges the ledger with this process's quota cache and, for `collectUsage`, a fresh Claude OAuth usage-endpoint read. |
| Evaluator | `src/agent/usage/usage-budget.ts` | The one grader: binding window, `ok` / `warn` / `over` / `unknown`. Readings older than 10 minutes are `unknown`, never stale numbers. Defaults: warn at 80%, over at 100%. |
| Formatter | `src/agent/usage/usage-formatter.ts` | The one formatter for the CLI, `get_runtime_state`, the fan-out notice, and the daemon Telegram message. |

## Consumers

- **`afk usage [--json]`** (`src/cli/commands/usage.ts`): per provider/account
  per-minute headroom, active freeze, 5h / 7d utilization with reset
  countdowns, and data age. Providers with credentials but no signal are listed
  as `unknown`.
- **`get_runtime_state`**: the `all` view carries a compact `usage` field
  (`src/agent/awareness/runtime-source.ts`).
- **Fan-out notice** (`src/agent/tools/usage-notice.ts`): when an `agent` or
  `compose` dispatch starts from a Claude parent and the subscription is at
  warn or over, ONE line is prepended to the tool result and a `usage_notice`
  `session_phase` trace event is emitted. Observer only: no blocking, no
  routing change, no model downgrade, nothing in the system prompt (which would
  break prompt caching).
- **Daemon budget gate** (`src/agent/daemon/budget-gate.ts`): before an
  `executor: 'agent'` task runs, the binding Claude window is graded at
  `AFK_DAEMON_BUDGET_SKIP_PCT`. At or over it the task is skipped
  (`skipReason: 'budget-over'` in telemetry, visible in `get_schedule_history`)
  and a Telegram notice is always sent. Shell and builtin tasks are never
  gated. Fail-open: no token, a network error, or a stale reading all pass.

## Environment

| Var | Default | Effect |
|---|---|---|
| `AFK_USAGE_LEDGER_DISABLED` | `0` | `1` stops publishing/reading the cross-process ledger; surfaces see only this process's cache. |
| `AFK_DAEMON_BUDGET_SKIP_PCT` | `90` | Daemon skip threshold (0 to 100). |
| `AFK_DAEMON_BUDGET_GATE_DISABLED` | `0` | `1` disables the daemon gate (no usage-endpoint call). Forced to `1` in the vitest setup (`src/__test-utils__/clean-config-env.ts`) because the default path reads the real keychain token. |

## Known gaps

- **Codex / ChatGPT subscription usage is unknown.** The ChatGPT OAuth backend
  (`chatgpt.com/backend-api/codex`) is bypassed by the admission fetch
  (`openai-compatible/query/client.ts`) and no usage header is known for it.
- **`anthropic-ratelimit-unified-*` headers are undocumented** by Anthropic;
  they work today but can change without notice.
- **The Anthropic ledger account is the auth mode** (`oauth` / `apiKey`), not
  a per-credential identity, so two different API keys on one machine share a
  bucket.
- **No automatic provider routing or model downgrade.** Deliberately deferred
  until per-account data shows where 429s actually originate.
- The fan-out notice adds a few lines to two grandfathered executor files
  (`compose-executor.ts`, `subagent-executor.ts`); their size baselines were
  raised with `--allow-growth`.
