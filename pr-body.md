## Problem

Compose DAG node token usage and USD cost was **silently dropped** from the parent session's `session_sealed` telemetry. Two separate bugs combined to cause this:

### Bug 1: Compose executor's ephemeral manager never received the rollup callback

`ComposeExecutor.execute()` creates a **fresh `SubagentManager` per call** (~line 652 of compose-executor.ts). The rollup callback that accumulates subagent token/cost data is registered on the *root* manager via `rootManager.setOnSubagentSucceeded()` — but compose's ephemeral per-call manager never received it. All compose DAG node costs were silently discarded.

### Bug 2: The rollup was only wired on the REPL surface

`setOnSubagentSucceeded` was called on `rootManager` only inside `bootstrap.ts` (the REPL path). Three other surfaces had **no wiring at all**:

| Surface | File | Status before fix |
|---------|------|-------------------|
| REPL | `src/cli/commands/interactive/bootstrap.ts` | ✅ rootManager wired — **compose missing** |
| Daemon | `src/cli/commands/daemon.ts` | ❌ neither rootManager nor compose |
| Telegram | `src/telegram/session-anthropic.ts` | ❌ neither rootManager nor compose |
| One-shot chat | `src/cli/commands/chat.ts` | ❌ neither rootManager nor compose |

## Fix

### 1. `src/agent/tools/compose-executor.ts`

- Added `onSubagentSucceeded` optional field to `ComposeExecutorContext`
- Added `setOnSubagentSucceeded()` method to `ComposeExecutor` (mirrors the existing `setTraceWriter()` pattern) for late-binding after session construction
- In `execute()`, immediately after the ephemeral `SubagentManager` is constructed, wires `ctx.onSubagentSucceeded` onto it via `manager.setOnSubagentSucceeded(cb)`

### 2. `src/cli/commands/interactive/bootstrap.ts`

Extracted the existing `rootManager.setOnSubagentSucceeded()` closure into a named `onSubagentSucceeded` constant, then reused it for `composeExecutor.setOnSubagentSucceeded(onSubagentSucceeded)`. Both read through `sessionRef.current` so a mid-session `/resume` swap routes costs into the live session.

### 3. `src/cli/commands/daemon.ts`

In `buildDaemonSessionFactory`, after the `AgentSession` is constructed (late-binding pattern), wires both `rootManager.setOnSubagentSucceeded()` and `composeExecutor.setOnSubagentSucceeded()` to accumulate per-tick session costs.

### 4. `src/telegram/session-anthropic.ts`

After `boundSession = session`, wires both `rootManager.setOnSubagentSucceeded()` and `composeExecutor.setOnSubagentSucceeded()` onto the constructed Telegram session.

### 5. `src/cli/commands/chat.ts`

After `boundSession = session`, wires both managers using a `wiredSession` const (TypeScript control-flow narrowing: the outer `session` variable is `AgentSession | null`, so a stable local reference satisfies the type checker).

### 6. `.filesize-baseline.json`

Updated via `pnpm audit:filesize:update` — compose-executor.ts grew from 545 to 560 code lines, and chat.ts / daemon.ts each grew ~7 lines.

## Design notes

- The compose manager is **ephemeral** (created and torn down per `execute()` call), so the callback routes to the *parent* session's accumulators (`session.recordSubagentCompletion()`), not a local one.
- All wiring is **late-bound** (after session construction) to avoid the circular reference: executors are built before the session, session needs executors, so the rollup callback can only be registered once both exist.
- The `setOnSubagentSucceeded` method on `ComposeExecutor` matches the existing `setTraceWriter` method's shape exactly — consistent API, no surprises.

## Verification

```
pnpm lint   ✅ (tsc --noEmit + tsconfig.web.json)
pnpm build  ✅
pnpm audit:filesize:check  ✅ (42 grandfathered, 0 violations)
```
