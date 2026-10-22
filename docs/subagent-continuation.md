# Subagent continuation

A subagent that stops before finishing (it hit its tool-round cap, timed
out, was aborted, or ended early) can be **continued**: the parent dispatches
the `agent` tool again with `continuation_chain_id`, and a fresh child starts
from the previous child's full conversation (its tool calls and tool results
included) plus the parent's new prompt. Before continuation existed, the only
option was a new dispatch that re-derived everything from a summary. Design
record: `.afk/plans/2811-continuation-design.md` (decisions D1-D10;
supersedes PR #2811).

## Using it

Every local `agent` dispatch is assigned a **chain**. Its id is
runtime-minted (`chain_<24 hex>`), and the model never chooses it. When a
result is incomplete (capped, or another incomplete stop) and the chain can be
continued, the tool result ends with:

```
[continuation: chain_id=chain_…, rounds 55/150 used, continuations 0/3 used; pass continuation_chain_id to continue]
```

The same data is on the result's structured `continuation` field
(`chainId`, `roundsCharged`, `maxRounds`, `continuations`,
`maxContinuations`, `continuable`), which is stamped on every result. A
continuation's own result always carries the line, and so does a background
result delivered to the parent.

To continue, call `agent` with:

- `continuation_chain_id`: the id from the line or metadata.
- `prompt`: the new instruction. The runtime prefixes it with
  `[Continuation k of chain …: your previous run ended (<reason>). You have R tool-use rounds for this run.]`.
- optionally `max_tool_use_iterations` (the round allowance for this run,
  default 50), `max_turns`, `mode` (foreground/background may differ from the
  original), `id_prefix`, `progress_events`, `attachments`.

`agent_type`, `model`, `cwd`, `isolation`, `readRoots`, and `writeRoots` are
inherited from the chain. Omit them, or pass exactly the chain's values.

## How it works

- `src/agent/subagent/continuation-registry.ts`: one in-memory
  `ContinuationRegistry` per root session (`wire-executors.ts`), shared with
  nested executors. Each chain records its owner, stored dispatch inputs,
  latest child id, rounds charged, continuation count, in-flight flag,
  workspace checkpoint, and last end reason.
  - **Owner** is the dispatching actor's runtime identity (`actorIdentity` in
    `continuation-dispatch.ts`): a per-registry root token for the root
    session (stable even before the provider assigns a session id), or
    `subagent:<id>` for a nested subagent. It is never empty, and only the
    owner can continue a chain, so a child cannot continue its parent's or a
    sibling's chain.
  - The registry holds at most 256 chains and evicts the oldest chains that
    are not in flight. An evicted chain is refused as unknown.
  - **Settling.** The subagent result is returned (foreground) or
    delivered (background) as soon as the child finishes. The terminal
    bookkeeping runs after that: the child's message journal flush (at most
    5s) and, for write-capable chains, the workspace checkpoint (git, 10s
    timeout per call). That bookkeeping is the chain's `settling` promise,
    which never rejects. In-flight stays true until it settles. An
    uncapped initial run's round charge is applied before the result is
    delivered, so the delivered metadata is final. If the flush times out,
    the previous link is kept, so a continuation never folds a truncated
    journal.
  - Checkpoint git calls pass `--no-optional-locks` (and set
    `GIT_OPTIONAL_LOCKS=0`), so `git status` never takes `index.lock` while
    the parent or a sibling commits in the same worktree.
- `src/agent/tools/subagent/continuation-dispatch.ts`: mints a chain for
  every local initial dispatch and wraps the child handle so that every
  terminal outcome records into the chain exactly once (foreground, promoted,
  or background; success, capped, failure, or abort). The latest link
  advances only when the child's journal holds messages.
- `src/agent/tools/subagent/continuation-run.ts`: admission (below), then the
  seed. The latest child journal
  (`sessions/<root>/subagents/<child>.jsonl`) is folded and handed to the new
  child as `resumeMessages` (`applyContinuationSeed` in
  `src/agent/subagent/fork-resolution.ts`, which also turns on `autoCompact`).
  No seed session is written. The continuation child resumes the parent
  session id like every fork and journals into its own `subagents/<id>.jsonl`.
  That journal holds the seeded history plus its own run, and the next link
  reads it. The admitted call then re-enters the normal `executeOnce` path
  with an input rebuilt from the chain's stored inputs, so config assembly,
  permissions, `DelegationBudget`, and fork wiring are the ordinary ones.
- Both providers honor `resumeMessages`. On openai-compatible, an assistant
  tool call that has no result (a link aborted mid tool round) is answered
  with `INTERRUPTED_TOOL_RESULT` by the journal adapter
  (`openai-compatible/journal-adapter.ts`), so the resumed request stays
  valid.
- Tracing: `subagent_lifecycle` `started` events of continuation forks carry
  `chainId`, `continuationOf`, and `continuationIndex`.

## Limits and accounting

| Env var | Default | Meaning |
| --- | --- | --- |
| `AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS` | 150 | Aggregate tool-round budget across the whole chain |
| `AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS` | 3 | Continuations per chain; `0` disables continuation |

The initial run is charged its round cap. If the initial run was uncapped, it
is charged the rounds it actually used, counted at runtime. Each continuation
is charged its full allowance up front, clipped to what remains of the
aggregate. A continuation call reserves the chain synchronously before it
awaits anything, so a concurrent second call on the same chain is refused at
once as in flight and runs no git. The call holding the reservation then
waits (at most 15s) for the previous run to settle, so a parent that
continues right after receiving a result is admitted with the complete
journal. After that it checks in-flight, drift, and limits. The charge
itself is synchronous, so two concurrent continuations of one chain cannot
both pass. Charges are never refunded, with one exception: when
the continuation child was never constructed or never started (budget
refusal, fork failure, or teardown before running), the charge, the count,
and the in-flight flag are rolled back. A continuation is never re-dispatched
by the zero-output stream-cut retry, so one call is charged at most once.

## Refusals (fail closed)

When a continuation is refused, nothing is forked and nothing is charged. The
tool error reads `Agent tool continuation refused: <reason>. Nothing was
forked.` Reasons:

- the chain is unknown (this includes invented ids and chains from before a
  restart or `/resume`);
- the chain is owned by another actor;
- a run on the chain is still in flight (including another continuation
  call that is being admitted);
- the previous run is still finishing its bookkeeping after the 15s wait
  (retry the continuation);
- the continuation limit or the aggregate round limit has been reached;
- an inherited field (`agent_type`, `model`, `cwd`, `isolation`,
  `readRoots`, `writeRoots`) differs from the chain's value;
- the chain was `isolation: "worktree"`, or the call sets `host`;
- the workspace drifted since the chain's last run: branch, HEAD, or
  uncommitted changes (`git status --porcelain` fingerprint) changed.
  Checked for write-capable chains only; read-only chains and non-git cwds
  skip this check;
- the workspace checkpoint is unavailable: `git status` (or the repo probe)
  failed or timed out when the checkpoint was taken or at the recheck, so
  drift cannot be ruled out. Write-capable chains only (fail closed; retry);
- the previous child left no usable journal, either because message
  journaling is disabled (`AFK_MESSAGE_JOURNAL_DISABLED`) or because its fold
  is missing or empty;
- the session has no registry (continuation is unavailable there).

## v1 limitations

- Chains live in memory only and are lost on process restart and on REPL
  `/resume`.
- Worktree-isolated chains are minted (their metadata says
  `continuable: false`) but cannot be continued.
- Remote (`host`) dispatches never mint a chain. Compose nodes do not accept
  `continuation_chain_id`.
