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
  (compose nodes do not get it).
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

## Landed: D8 continuation path, D4 env limits, D10 trace fields

- `src/agent/tools/subagent/continuation-run.ts`: a call with
  `continuation_chain_id` is admitted fail-closed (nothing forked on refusal;
  the tool error names the reason) in this order: chain lookup + owner,
  `checkContinuationOverrides` (host, worktree chain, inherited
  agent_type/model/cwd/isolation/readRoots/writeRoots), in-flight,
  `checkWorkspaceDrift` (write-capable chains only), a resumable latest link,
  then the synchronous `admitContinuation` charge. It seeds
  `forkJournal(rootSessionId, seedId, { subagentId: latestChildId })`
  (failure rolls back), then re-enters `executeOnce` with an input rebuilt
  from the chain's stored inputs, so config assembly, permissions, and
  `DelegationBudget` admission are the normal ones. The finite allowance is
  the child's `max_tool_use_iterations`; the prompt is prefixed by the
  runtime note.
- Fork: `ForkSubagentOptions.continuation` overrides `resume` (default stays
  the parent session id, `fork-resolution.ts`); `applyContinuationSeed` sets
  the seeded `resumeMessages` and `autoCompact` (default on) after
  `assembleChildConfig`.
- The continuation child is instrumented against the SAME chain (no new
  mint); its result always carries the continuation line. If the re-run
  exits before wiring a child (budget refusal, fork construction failure,
  cancel), the charge and in-flight flag roll back. An abort after wiring
  keeps the charge.
- Stuck-chain fix: a handle torn down before any run entry point (attachment
  error, no background registry, job cap, register error) clears in-flight
  (initial chain: terminal record; continuation: rollback).
- D9: the latest link advances only when the child's journal holds messages.
- D4: `AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS` (default 150) and
  `AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS` (default 3, 0 disables).
- D10: `subagent_lifecycle` started events carry optional `chainId` /
  `continuationOf` / `continuationIndex` on continuation forks.

## Not yet done

`docs/subagent-tool-budget.md` update and the AFK.md pointer; executor-level
tests for the non-owner and worktree-chain refusals (covered at the
registry/guard level only). Worktree-isolated chains are refused in v1.
OpenAI-compatible providers' handling of a dangling tool_use on an aborted
link was not verified (spike note).
