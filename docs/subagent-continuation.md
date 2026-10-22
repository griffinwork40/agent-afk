# Subagent continuation (option B): status

Design: `.afk/plans/2811-continuation-design.md` (decisions D1-D10). Supersedes PR #2811.

## Landed in this checkpoint (core, not yet wired to the `agent` tool)

- `forkJournal(source, new, loc?)` (`src/agent/journal/fork.ts`): seeds a new
  top-level journal from a CHILD journal (`{ subagentId }`), the D1 seed step.
- `ContinuationRegistry` (`src/agent/subagent/continuation-registry.ts`):
  runtime-minted `chain_<hex>` ids, owner check, in-flight flag, synchronous
  admission with rollback, D4 accounting (initial charged at its cap, or at
  runtime-counted rounds when uncapped; continuations charged in full, clipped
  to the remaining aggregate; no refunds), D9 terminal update, D6 result line.
  Defaults: 150 aggregate rounds, 3 continuations.
- `continuation-guards.ts`: D3 override/worktree/host refusals and D5
  runtime-captured workspace checkpoints (cwd, branch, HEAD, sha256 of
  `git status --porcelain=v1 -z`); non-git cwd records `git: false` and skips
  the drift check; read-only chains skip it.

Chains are in memory only: they do not survive a process restart or REPL `/resume`.

## Landed: dispatch-side wiring

- `continuation_chain_id` on the `agent` tool schema and `parseAgentInput`
  (compose nodes do not get it). Until the D8 fork path lands, a call passing
  it is refused with "continuation not yet wired" (`TODO(continuation-d8)` in
  `src/agent/tools/subagent/continuation-dispatch.ts`).
- One `ContinuationRegistry` per root session (`wire-executors.ts`), threaded
  through `SubagentExecutorContext.continuationRegistry` to nested executors.
- `continuation-dispatch.ts`: every local initial dispatch mints a chain
  (remote `host` dispatches do not; worktree-isolated ones do, marked
  `continuable: false`); the handle's `runToResult` / `runInBackground` are
  wrapped so every terminal outcome (foreground, promoted, background; success,
  capped, failure, rejection) calls `recordTerminal` once with the runtime
  `roundsUsed` and a checkpoint from the child's runtime cwd. Results carry a
  `continuation` metadata field; capped results of continuable chains get the
  `[continuation: ...]` line (foreground tool result and background delivered
  message).

## Not yet done

D8 continuation fork path (seed + `resume=<seedId>` + `autoCompact` + runtime
note, admission/guards/rollback), D10 lifecycle event fields, env-registry
limits (D4), and the D8 executor-level test list. Worktree-isolated chains are
refused in v1.
