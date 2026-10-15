# Detach Contract: Ctrl+B Backgrounding for In-Flight Tool Calls

**Status:** First slice (bash only). Compose is a follow-up tracked in #2542.

## Problem

Ctrl+B already backgrounds in-flight foreground **subagents** by promoting them
to the `BackgroundAgentRegistry`. But long-running **bash** (and future **compose**)
calls have no equivalent — Ctrl+B during a `sleep 300 && pnpm test` simply did
nothing, leaving the model's turn parked on the tool call until it finishes or
times out (up to 10 minutes). This blocks the user from sending a new message
and from redirecting the agent's attention.

## Design

### Core Concept

A tool handler that opts in to the detach contract:

1. Registers with a per-session `DetachableToolRegistry` at the start of execution,
   receiving a `DetachToken`.
2. Listens for `token.detachSignal` (an `AbortSignal`).
3. When the signal fires (Ctrl+B), the handler:
   - Resolves its handler Promise with a placeholder `detachResult` (freeing the model's turn).
   - Keeps the underlying process running (does **not** kill it).
4. When the process eventually finishes, the handler calls `token.deliver()` with
   the real result, which the REPL injects into the next user turn.

### Ctrl+B Dispatch Order

When Ctrl+B fires during a streaming turn, the keyboard handler applies this
ordered dispatch:

1. **Subagent promotion** (existing): If a foreground subagent dispatched by this
   turn is running and promotable (a `BackgroundAgentRegistry` is wired),
   detach it via `promoteActiveForeground()`. The main turn keeps streaming.
2. **Detachable tool** (new, #2542): If no subagent is promotable but a bash
   call has registered with the `DetachableToolRegistry`, call `detachAll()` to
   free the model's turn while the process continues running.
3. **No-op**: If neither is available, Ctrl+B does nothing (no whole-turn detach).

### Invariants

**Invariant:D1 (Parallel-batch semantics):** When a Ctrl+B keypress lands while
`N > 1` detachable tool calls are running concurrently within one batch, ALL of
them are detached in the same `detachAll()` pass. Each detached token carries its
own independent delivery channel; results arrive individually. No partial-batch
detach: a token that settled before `detachAll()` reaches it has already
deregistered itself and is simply skipped.

**Invariant:D2 (Provider parity):** The registry and token are wired through
`ToolHandlerContext`, which is shared by both the Anthropic-direct and
OpenAI-compatible dispatcher paths. The detach seam works identically for both
providers — no provider-specific code path is needed.

**Invariant:D3 (AbortGraph ownership):** `DetachableToolRegistry.cancelAll()`
MUST be called by session teardown (AbortGraph cascade). Detaching a bash call
frees the MODEL's turn, not the session's resource claim. The in-flight process
is still a child of the session; the session owns its lifetime. A cancelled
(session-aborted) process is still killed by the bash handler's existing
`abortHandler` (SIGKILL on the process group), which fires because the session's
`AbortSignal` was already wired into the handler at spawn time. The detach
signal and the session abort signal are separate; `cancelAll()` fires the detach
abort to unblock any poll-style handler, but the actual process kill remains the
session signal's responsibility.

### Detach vs. Yield

The existing **yield contract** (`user-yield.ts`) is for tools that are safe to
stop and redo later (polls, idempotent waits). The tool stops early when the
user has a queued message, freeing the turn.

The **detach contract** (this doc) is for tools that must NOT be interrupted
but CAN be decoupled from the model's attention — the process keeps running,
the model gets its turn back, and the result arrives later. These are orthogonal;
`bash` is detachable but never yieldable.

### Result Delivery

Detached bash results are delivered through the `DetachableToolRegistry`'s
`settled` event. The REPL's `BgResultNotifier` subscribes to a similar event
on the `BackgroundAgentRegistry`; the analogous notifier for detached tool calls
is wired in the same bootstrap path.

The result is injected as a model-context block into the **next user turn**,
exactly like background subagent results — the model sees it between turns, not
mid-turn (the provider consumes one input-stream message per turn).

## Files Changed

| File | Role |
|------|------|
| `src/agent/tools/detach-registry.ts` | `DetachableToolRegistry` class + `DetachToken` interface |
| `src/agent/tools/detach-bash.ts` | Bash-specific detach helpers (`bashDetachLabel`, `wireBashDetach`, `buildBashDelivery`, `DETACHABLE_TOOLS`) |
| `src/agent/tools/types.ts` | Added `detachRegistry?: DetachableToolRegistry` to `ToolHandlerContext` |
| `src/agent/tools/handlers/bash.ts` | Wires `wireBashDetach` when `context.detachRegistry` is present |
| `src/agent/tools/dispatcher.ts` | Reads `detachRegistry` from options; injects it via `callHandlerContext` for `DETACHABLE_TOOLS` |
| `src/cli/commands/interactive/shared.ts` | Added `detachRegistry?: DetachableToolRegistry` to `TurnHandles` |
| `src/cli/commands/interactive/turn-handler.bg-promotion.ts` | Implements three-step Ctrl+B dispatch; step 2 calls `detachAll()` |

## Deferred Scope

- **compose detach**: The `compose` tool should support the same contract. The
  registry design is generic (`DETACHABLE_TOOLS` is a `Set<string>`); adding
  `'compose'` requires wiring the detach signal into the compose executor's
  per-node loop. Tracked in #2542.
- **BgResultNotifier wiring**: The `settled` event on `DetachableToolRegistry`
  needs a notifier (analogous to `BgResultNotifier`) wired at bootstrap to inject
  detached bash results into the next turn's model context. The registry emits
  the event; the bootstrap and `loop-iteration.ts` consumer are the follow-up.
- **TUI notification**: The ToolLane overlay should show "detached — result
  pending" for a detached bash call. Currently the lane just disappears from the
  turn's tool list when the placeholder result arrives.
- **Session bootstrap wiring**: The `DetachableToolRegistry` instance needs to be
  constructed at bootstrap alongside `BackgroundAgentRegistry` and passed into
  the `SessionToolDispatcherOptions`. The `TurnHandles.detachRegistry` field is
  the hook point.

## Testing

```bash
pnpm test src/agent/tools/detach-registry.test.ts
pnpm test src/agent/tools/handlers/bash.detach.test.ts
pnpm test src/agent/tools/user-yield.test.ts
pnpm test src/cli/commands/interactive/queued-flush.test.ts
```
