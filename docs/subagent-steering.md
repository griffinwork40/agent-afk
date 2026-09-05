# Subagent Steering

Mid-run steering lets an external actor redirect a running subagent between
tool-call boundaries. Two domains exist, split by **who steers** and **which
subagent mode** they target.

## Domain 1: Human-owned (foreground)

When a user watches a foreground subagent going wrong, they hit **Ctrl+C** to
open the interrupt picker, select **Steer**, and type a redirect message. The
message is delivered as the next top-level REPL turn -- the child is soft-stopped
and the redirect becomes the parent session's next input.

**Path:** `interrupt-picker.ts` → `onSteer()` → readline → `pendingSteerText`
→ `loop-iteration.ts:seedBuffer` → next REPL turn.

This path is surface-specific (REPL only) and requires human presence. It does
not inject into the running child mid-stream; it redirects the parent after the
child completes or is stopped.

## Domain 2: Model-owned (background)

When a parent model dispatches a background subagent and later wants to redirect
it, it calls the `send_message_to_agent` tool. The message is delivered at the
child's next tool-call boundary via the `beforeNextRound` callback.

**Path:** `send_message_to_agent` tool → `handle.steer()` → ring buffer
(capacity 3, oldest-evict) → `_beforeNextRound` closure → `setBeforeNextRound`
→ `applyBeforeNextRound` (inter-round.ts) → injected into child's conversation.

This path is available on all surfaces (REPL, Telegram, daemon) and requires no
human presence. Only model-created background jobs can be steered this way;
user-promoted jobs (Ctrl+B) are refused by the provenance guard.

## Why foreground model-steering is not supported in V1

The parent model is blocked on `await runToResult` during a foreground
subagent's execution. It has no model turns available to invoke
`send_message_to_agent`. This is a property of the current execution model
(parent awaits child), not a fundamental impossibility -- the `beforeNextRound`
hook is provider-agnostic and could accept steering from non-model actors
(e.g., REPL input, Telegram messages, sibling agents) in a future extension.

## Cross-session isolation

In a multi-session process (concurrent REPL + Telegram + daemon),
`send_message_to_agent` enforces session-ID ownership: a model in session A
cannot steer a background job created by session B. The provenance guard
additionally prevents model-initiated steering of user-promoted jobs.

## Escape hatch: Ctrl+B promotion

A foreground subagent can be promoted to background mid-flight via **Ctrl+B**.
Once promoted, it becomes steerable through the model-owned domain
(`send_message_to_agent`). This bridges the two domains when a user decides
mid-run that they want model-level steering of a child that started foreground.
