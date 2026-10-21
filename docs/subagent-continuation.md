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

## Not yet done

Executor wiring (`continuation_chain_id` schema/parse, registry construction in
`wire-executors.ts`, seed + `resume=<seedId>` fork with `autoCompact`, terminal
hooks on foreground and background paths, lifecycle event fields), env-registry
limits, and the executor-level test list. Worktree-isolated chains are refused in v1.
