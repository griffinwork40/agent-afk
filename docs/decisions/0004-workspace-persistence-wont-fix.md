# ADR 0004 — Cross-session workspace persistence: won't-fix

Status: **Decided (won't-fix)**

Closes issue #1541.

---

## Context

The shared workspace (`workspace_publish` / `workspace_query`) gives sibling
sub-agents a low-friction scratchpad for exchanging findings within a single
top-level session. Because the backing store defaults to SQLite `:memory:`, all
entries are discarded when the session process exits.

Issue #1541 asked whether the workspace should be made durable across sessions —
either by routing writes to a file-backed SQLite database that persists on disk,
or by flushing entries to the cross-session `StateStore` at session close.

## Decision

**The workspace remains strictly session-scoped. No cross-session persistence
will be added.**

For information that must survive across sessions, agents should use the
`state_put` / `state_get` tools, which write to the durable
`StateStore` (`~/.afk/state/kv/kv.db`).

## Rationale

### 1. Stale findings injection

Workspace entries are ephemeral investigative artifacts — conclusions drawn from
a specific codebase snapshot at a specific point in time. Carrying them into a
future session without re-validation would inject stale, context-mismatched
findings into the new session's preamble. A sub-agent opening a session days or
weeks later would receive "findings" that no longer reflect the repository state,
potentially steering it toward wrong conclusions from the start.

### 2. Session-scoped contract is load-bearing

`WorkspaceStore` is constructed once per top-level session and shared among all
children of that session tree. The `queryRelevant` method accepts a `sessionId`
parameter so that the fork-child preamble injection path can scan *all entries in
the store* (cross-child, within the session) without session-ID filtering. This
design — one store instance, all children in the same trust domain — depends on
the store being discarded at session end. Persisting across sessions would require
introducing session-boundary scoping logic that currently does not exist and would
add complexity with no clear payoff.

### 3. The right abstraction already exists

The `StateStore` (`src/agent/state/state-store.ts`) is purpose-built for durable,
cross-session, namespaced document storage with versioning, TTL, and CAS
semantics. Agents that need to pass information between sessions should use
`state_put` / `state_get`. Duplicating that persistence path through the workspace
would create two competing mechanisms for the same use case.

### 4. Failure mode has not emerged

No production session has failed because workspace entries were lost at session
close. The `artifact-durability-gate` and `checkpoint` skills provide escape
hatches for agents that need to preserve mid-session work. Optimizing for a
failure mode that has not manifested violates the project's bias toward minimal
mechanism.

## Consequences

### For agent authors

| Need | Right tool |
|---|---|
| Share a finding with sibling sub-agents **within the current session** | `workspace_publish` / `workspace_query` |
| Persist information **across sessions** | `state_put` / `state_get` (durable `StateStore`) |
| Preserve in-progress work across a session interruption | `/checkpoint` skill |

### For maintainers

- `WorkspaceStore` (`src/agent/workspace/workspace-store.ts`) must remain
  defaulting to `:memory:`. PRs that switch the production default to a
  file-backed path should reference this ADR and require a fresh decision.
- The `StateStore` (`src/agent/state/state-store.ts`) is the sole approved
  mechanism for cross-session durable state. No second durable-state path should
  be introduced without a new ADR.

## Revisit trigger

Re-open if a concrete, reproducible failure mode emerges where:

1. Information that *should* survive across sessions is being lost because agents
   forget to call `state_put`, **and**
2. The session-scoped workspace is a plausible fix path (rather than better agent
   prompting or a `/checkpoint` call).

Until both conditions hold simultaneously, the status remains **won't-fix**.
