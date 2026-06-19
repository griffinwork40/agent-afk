# Normalize session identity across AFK telemetry/state artifacts

## Implementation status (2026-06-18)

- **Stage A — Witness trace: DONE + verified + committed.** `origin`
  (cli/telegram/daemon/unknown) + `actor` (main/subagent) now recorded on the
  `session_init_start` trace event. Lint clean; 65 targeted tests pass; full
  suite shows only 2 pre-existing env failures (local-MLX config bleed —
  proven identical on a stashed/clean tree).
- **Stages B + C — DONE + verified + committed** (commit `696953f`).
  routing-decisions.jsonl + skill-invocations.jsonl rows now carry optional
  `origin` + `actor`; frozen `surface:'afk'` unchanged. Minimal widening: added
  `surface?` to `SubagentExecutorContext` + `SkillExecutorContext`; actor derives
  from the EXISTING `depth` (depth>0 ⟺ subagent) — no `parentSessionId` field
  added. Top-level executors tagged at bootstrap/chat (cli), daemon (daemon),
  telegram (telegram); nested child executors inherit surface. Extracted pure
  `buildRoutingDecisionRow` for testability. +12 tests, all green.
  - DEFERRED in B/C: deep skill→skill grandchild `origin` via
    `createChildSkillExecutorFactory` (nesting.ts, fragile 8-positional sig) —
    actor stays correct via depth, origin reads `unknown`.
- **Stage D — DONE + verified + committed** (memory DB migration, sidecar,
  presence). SCHEMA_VERSION bumped 2→3 (nullable `sessions.actor`, idempotent
  ALTER); sidecar `source` gained `'daemon'` + optional `actor`; presence gained
  optional `actor` (derived via `actorFromDepth` at the top-level provider gate).
  Full suite green except the 2 unrelated pre-existing env failures.
- Mirror of this plan persisted to cross-session memory as procedure
  `normalize-session-identity-telemetry-plan` (survives worktree sweeps).

### Stage A — what shipped
- `AgentConfig.surface?: Surface` (`types/config-types.ts`) — optional, back-compat.
- `SessionPhasePayload` + `SessionPhasePayloadSchema` gain optional
  `origin`/`actor` (`trace/types.ts`, `trace/events.ts`).
- New pure helper `session/session-identity.ts` (`deriveOrigin`, `deriveActor`).
- `agent-session.ts` ctor emits `origin: deriveOrigin(config.surface)` +
  `actor: deriveActor(config.parentSessionId)` on `session_init_start`.
- Top-level surface tags: REPL `bootstrap.ts` ('cli'), `chat.ts` ('cli'),
  `daemon.ts` ('daemon', forced after `...config` — also covers scheduler/cron),
  `telegram/construct-session.ts` ('telegram').
- Tests: `session-identity.test.ts`, plus additions to `trace/session-phase.test.ts`
  and `trace/integration.test.ts`.

### Stage A — deferred sub-step (documented, low value)
Subagent `origin` *inheritance* onto a child's own `session_init_start` was NOT
wired. Reason: subagent `childConfig` (`subagent-executor.ts:540`) sets no
`traceWriter`, so most subagents emit no `session_init_start` at all — their
activity is recorded in the PARENT trace via `subagent_lifecycle` (parentId +
subagentId), and the parent's `session_init_start` carries `origin`. A child
that IS independently traced still gets correct `actor:'subagent'` from the
`parentSessionId` injected at `subagent.ts:391`; only its `origin` reads
`'unknown'` (recoverable via parentId→parent correlation). Closing this needs
the same surface-threading prerequisite as Stages B/C.

### Shared prerequisite for Stages B & C (and the deferred A sub-step)
Surface is not threaded into the subagent/skill executors. To record `origin` in
routing-decisions and skill-invocations:
1. Widen `SubagentExecutorContext.defaultConfig` Pick (`subagent-executor.ts:49`,
   currently `'apiKey'|'systemPrompt'|'baseUrl'`) to include `'surface'` (and
   optionally `'parentSessionId'` for `actor`).
2. Set `surface` in the `defaultConfig` literal at the 4 SubagentExecutor
   construction sites: `bootstrap.ts:295`, `chat.ts:484`, `daemon.ts:118`,
   `telegram.ts:281` (the nested child at `subagent-executor.ts:585` already
   passes `this.ctx.defaultConfig` through).
3. Mirror for `SkillExecutorContext` (`skill-executor.ts:46` parentSession Pick).

---

## Goal
Make durable telemetry answer: (1) which user-facing surface produced the work
(cli/telegram/daemon), and (2) what actor role (main/subagent).

## Root cause: `surface` is overloaded + actor smuggled in
- `src/telemetry/schemas.ts:14` — `surface = z.enum(['afk','plugin'])`: a
  PROVENANCE/writer-ecosystem tag, FROZEN by the cross-surface schema. The
  hardcoded `surface:'afk'` in routing-telemetry.ts:114 + skill-invocation-writer
  .ts:45,65 is THIS tag — correct, not a bug.
- `src/agent/awareness/types.ts:36` — `Surface =
  'cli'|'repl'|'daemon'|'telegram'|'subagent'|'unknown'`: the USER-FACING surface,
  plus a dead `'subagent'` member that is really an ACTOR ROLE.

## Recommended vocabulary (additive; do NOT touch frozen `surface`)
```
provenance → existing JSONL `surface`: 'afk'|'plugin'        (FROZEN)
origin     → NEW: 'cli'|'telegram'|'daemon'|'unknown'        (Q1)
actor      → NEW: 'main'|'subagent'                          (Q2)
```
`actor = parentSessionId == null ? 'main':'subagent'`. Surface→origin: cli/repl→
cli, telegram→telegram, daemon→daemon, subagent→inherit parent (actor=subagent),
unknown→unknown.

## Remaining staged patch set
### Stage B — routing-decisions.jsonl
- `routing-telemetry.ts:28-93` — add optional `origin?`/`actor?` to
  RoutingDecisionEntry; thread from dispatch sites (already pass subagent_id/
  depth/parent_session_id → actor derivable). `surface:'afk'` stays at :114.

### Stage C — skill-invocations.jsonl
- `skill-invocation-writer.ts:43-54` — add `origin?`/`actor?` to row + builder.
- Widen `SkillExecutorContext` (skill-executor.ts:46) to expose surface +
  parentSessionId; update stub `createStubParentSession` (skill-executor.ts:524).

### Stage D — state artifacts (SHIPPED)
- `cli/session-store.ts` — `source` union gained `'daemon'`; optional `actor?` on
  `StoredSession` + `SessionListEntry`, threaded through `saveSession`/
  `listSessions`. `SessionStats` (`cli/slash/types.ts`) widened to match.
- `agent/awareness/presence.ts` — optional `actor?` on `PresenceFileInfo`;
  populated at both provider presence call sites via `actorFromDepth(depth)`
  (top-level gate ⇒ `'main'`).
- `agent/memory/memory-store.ts` — SCHEMA_VERSION 2→3; nullable `actor TEXT` on
  sessions; migration restructured into a sequential v1→v2→v3 catch-up chain; the
  v2→v3 `ALTER` is idempotent (guards on `table_info`) so it tolerates re-runs /
  interrupted migrations. `actor` threaded through `NewSession`, `startSession`,
  the WAL-replay insert, and `memory-hooks.ts` (derived via `deriveActor`).
  NOTE: real paths are under `src/agent/memory/…`, not the `src/memory/…` /
  `src/agent/memory-hooks.ts` cited in the original plan.

## Risks / do-NOT-change-yet
- Do NOT repurpose `surface:'afk'` (frozen provenance; breaks shared schema).
- Do NOT rename JSONL surface→provenance now (2-repo coordination).
- Do NOT remove the dead `'subagent'` Surface member (coerceSurface + tests ref
  it); deprecate in a comment only.
- Do NOT fix forge-telemetry non-conformance (daemon/scheduler.ts:104-117); only
  add origin:'daemon' if cheap.
- Memory DB migration must be nullable + forward-compatible (the "schema version
  newer than build" error is a live failure mode).

## Alternatives considered (rejected)
- Reuse `surface` for cli/telegram/daemon in JSONL → collides with frozen afk|plugin.
- Rename JSONL surface→provenance → deferred (2-repo coordination).
- Treat subagent as a surface → it's an actor role orthogonal to origin.
- Read surface from the provider instead of config → parseProvider() doesn't set
  it (only the fallback AnthropicDirectProvider does), so config is the robust
  single source of truth. Confirmed at bootstrap.ts:448 / chat.ts:541 / daemon.ts:164.
