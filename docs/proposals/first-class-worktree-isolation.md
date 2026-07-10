# Proposal: First-Class `isolation: "worktree"` for the `agent` Tool

**Status:** MVP implemented (2026-07-10) — see §9.
**Author:** Scoped via read-only sub-agent investigation + main-session verification, 2026-07-10
**Scope:** `src/agent/tools/subagent/*`, `src/agent/subagent.ts`, `src/agent/tools/handlers/worktree.ts`, `src/agent/worktree*.ts`, bundled skills under `src/bundled-plugins/awa-bundled/skills/`

---

## 9. Implementation status (MVP, 2026-07-10)

Waves 1–2 shipped; Wave 3 **dropped as a misread** (see below). Delivered:

- **Factored-out substrate** — `src/agent/tools/handlers/worktree-managed.ts`:
  `createManagedWorktree`, `removeManagedWorktreeGuarded`, `isManagedWorktreeDirty`,
  `managedWorktreeCommitsAhead`, `resolveRepoContext`, `sanitizeSlug`, plus the new
  `createIsolatedWorktree` / `teardownIsolatedWorktree`. `worktree.ts` now delegates to it
  (byte-identical git argv — `worktree.test.ts` still green). New `worktree-managed.test.ts`.
- **Schema + parse** — `isolation: 'none' | 'worktree'` on the `agent` tool; parse validates the
  enum, rejects `cwd`+`isolation` (mutually exclusive) and `isolation:worktree`+`mode:background`.
- **Executor** — creates the worktree between `buildChildConfig` and `forkSubagent`, sets
  `childConfig.cwd`, fails loud on a non-git cwd (never falls back to the shared tree). Read-only
  children (research-agent, recon) skip creation via `childWriteCapable` from `buildChildConfig`.
- **Teardown** — `foreground-promotion.ts` `if (!promoted)` finally removes the tree; a dirty /
  commits-ahead tree is **preserved and `git worktree lock`ed** (WIP never destroyed).
- **Verified** — lint + full suite green; real-git smoke confirms create / clean-remove /
  dirty-preserve+lock / non-git-throws.

**Wave 3 dropped (correction):** the proposal's §5/Unit 6 said to remove `'isolation'` from
`RECOGNIZED_UNSUPPORTED_KEYS` (`agents/parser.ts:43`). That set gates **agent-file frontmatter**
keys — a *different surface* from the `agent` tool param this feature adds — and a test
(`parser.test.ts:143`) asserts `isolation` stays in `ignoredKeys`. Removing it would be unrelated
and break that test. Honoring `isolation:` declared in an agent *definition* is a separate future
feature, not part of this MVP.

**Known MVP limitations (deferred to Phase 2/3):**
- **Grandchild isolation** — only the direct child's cwd is isolated; a depth-2 fan-out anchors at
  the parent tree. Fine for the leaf hypothesis/verifier agents the 5 skills dispatch.
- **Promotion (Ctrl+B)** leaks the tree — a promoted job outlives the teardown; the sweep engine
  reclaims it later (dead-owner/stale verdict), same as a killed-process tree.
- **Meta-file dirty dependency** — `isManagedWorktreeDirty` uses `git status --porcelain`, so a
  consumer repo that does NOT gitignore `.afk-worktree-meta.json` sees fresh trees as dirty and
  preserves+locks them (sprawl, but never data loss). afk gitignores it (`.gitignore:60`); this is
  a pre-existing dependency of the `worktree` tool, not new.
- **Return shape** (§3.6) not yet surfaced — no `SubagentResult.isolation` field / content footer,
  so `diagnose` stays on the manual `worktree`+`cwd` pattern until Phase 2.

---

## 1. Problem

`isolation: "worktree"` is a **no-op** in afk. The `agent` dispatch tool exposes only `cwd`
(`schemas.ts:382-399`); `parseAgentInput` parses only `cwd` (`input-parse.ts:173-208`); and
`isolation` sits in `RECOGNIZED_UNSUPPORTED_KEYS` — "recognized but does not honor yet"
(`agents/parser.ts:43`). So any skill that dispatches a write-capable sub-agent with
`isolation: "worktree"` actually gets a sub-agent that **inherits the parent's working tree**.
Parallel such agents corrupt each other's edits and test runs, invalidating any per-branch
pass/fail attribution.

This bit us concretely: the `diagnose` skill's hypothesis-testing phase (PR #480) shipped the
`isolation:"worktree"` idiom, which was a silent regression from the deleted TS orchestrator
that created **real** per-hypothesis worktrees in code (`git worktree add --detach` → isolated
verifier → `git worktree remove`, commit `3095f1f` `diagnose/_phases/verifier.ts`). PR #480 was
patched to use the manual `worktree` tool + `cwd` pattern. But **four other bundled skills use
the same no-op idiom** and remain latently broken: `refactor` (`SKILL.md:82,92,109`),
`shadow-verify` (`:14`), `simplify` (`:115`), `devils-advocate` (`:27`).

Making `isolation:"worktree"` first-class fixes all of them at once and aligns afk's `agent`
tool with the Claude Code Task semantics those skills were authored against.

## 2. Current State (verified with file:line)

**Dispatch → cwd → tool handlers (traced end-to-end):**
- `SubagentExecutor.execute()` (`subagent-executor.ts:385`) → `parseAgentInput` (`:396`) →
  `buildChildConfig` (`:474`) → `subagentManager.forkSubagent({config: childConfig})` (`:513`) →
  `runForegroundWithPromotion` (`:585`).
- `buildChildConfig` threads `parsed.cwd` → `childConfig.cwd` (`child-config.ts:247`).
- `forkSubagent` applies `config.cwd ?? this.parentCwd` as the child cwd and grants the main
  repo as a READ root (`subagent.ts:532-539, 621-623`), stamps occupancy (`:685`).
- `childConfig.cwd` → `AgentSession` → dispatcher `resolveBase` (`dispatcher.ts:292,319-320`) →
  every file/shell handler (`handlers/bash.ts:147`, `grep.ts:73`, `glob.ts:202`).
- Executor tracks `this.currentCwd = ctx.cwd` (`subagent-executor.ts:269`).

**Substrate #1 — the `worktree` tool (recommended base):** `createWorktreeHandler(): ToolHandler`
is a **monolithic** closure (`handlers/worktree.ts:192`) with `case 'create'` (`:227-276`:
`git worktree add -b afk/<slug> <path> HEAD` + `.afk-worktree-meta.json`) and `case 'remove'`
(`:329-367`: refuses **dirty** `:346`, **commits-ahead** `:352`, **locked** `:338` unless
`force`). Trees live under `.afk-worktrees/<slug>` and are protected/reclaimed by the sweep
engine (`worktree-sweep.ts`), with `keep` = `git worktree lock` self-save. **There is no
reusable `createManagedWorktree` function today** — it must be factored out of the handler.

**Substrate #2 — Speculative Branch Farm (`worktree.ts`, NOT recommended):** `createFarm` /
`FarmManifest`, `MAX_FARM_BRANCHES=16`, PR/human-decision lifecycle, lives in `$AFK_HOME/farms/`.
Over-engineered for ephemeral per-dispatch isolation.

## 3. Recommended Design

**In a nutshell:** add `isolation: "worktree" | "none"` to the schema; in
`SubagentExecutor.execute()` (between `buildChildConfig` and `forkSubagent`) create a managed
worktree via a **factored-out `createManagedWorktree()`** (from substrate #1), set
`childConfig.cwd` to it, run the child, surface the worktree path/branch on the result, then
remove-or-preserve it in the executor's teardown using the **factored-out guarded remove**.

1. **Schema (`schemas.ts:399`).** `isolation: { enum: ['worktree','none'], default 'none' }`.
   Enum (not boolean) for future `"container"`. **Mutually exclusive with `cwd`** → error if both.
2. **Parse (`input-parse.ts`).** Add `isolation?: 'worktree'` to `AgentInput`; validate the enum;
   throw `"cwd and isolation are mutually exclusive"` when both present; add to the return object.
3. **Create (executor `:474`→`:513`).** Base = `HEAD` of `this.currentCwd`'s repo, on a fresh
   real branch `afk/iso-<idPrefix>-<counter+rand>` (a branch, **not** `--detach`, so
   commits-ahead detection + WIP preservation work). Set `childConfig.cwd = worktreePath`.
   Precondition: verify `currentCwd` is a git repo first (`resolveWorktreeMainRoot`/`rev-parse`);
   if not, return a structured tool error — **do not** silently fall back to the shared tree.
4. **Substrate: reuse #1.** Factor `createManagedWorktree(repoRoot, slug, baseRef)` and
   `removeManagedWorktreeGuarded(repoRoot, path, {force})` out of `handlers/worktree.ts:227-276` /
   `:329-367` into a new `worktree-managed.ts`; call from both the tool handler and the executor.
   (Pure extraction PR, low risk.)
5. **Cleanup (executor teardown).** NOTE: the teardown seam is **`foreground-promotion.ts:310-330`**
   (the `if (!promoted)` branch of the `finally`, after `childManager?.teardownAll()` at `:312`) —
   `subagent-executor.ts:585` only *calls* `runForegroundWithPromotion`. See §8. Remove with `{force:false}` so dirty /
   commits-ahead trees are **preserved** (WIP not destroyed); when preserved, `git worktree lock`
   it (the `keep` primitive `worktree.ts:288`) so the sweep never reaps it, and surface the path.
   Runs on success, failure, and abort (same teardown boundary that already calls
   `childManager.teardownAll()`). Leaked trees (process killed) are `.afk-worktrees/` trees with a
   stamped pid → sweep's `dead-owner`/`stale-*` verdicts reclaim or preserve them.
6. **Return value.** Add optional `isolation?: {worktreePath, branch, baseSha, commitsAhead,
   dirty}` to `SubagentResult` (`subagent/result.ts`), and append a machine-readable footer to the
   tool result `content` (e.g. `[isolated-worktree] path=… branch=… commits_ahead=N dirty=bool`)
   so the parent can collect the diff / apply the winner. (Needed by diagnose's "apply to main".)
7. **Read-only agents → no-op.** Skip creation when the resolved access has no write/edit/mutating
   bash (e.g. `research-agent`) — detect via `resolvedAccess` already computed in
   `child-config.ts:154-167`. Emit a soft note, not an error.
8. **Nesting → do NOT auto-propagate** (mirror `cwd`, `schemas.ts:396-398`). A grandchild already
   runs inside the parent's isolated tree via the manager-cwd chain; a grandchild may request its
   own worktree (nested `git worktree add` off the parent worktree's HEAD is legal).
9. **Concurrency.** `afk/iso-<idPrefix>-<counter>-<rand>` is collision-free; occupancy + sweep
   already handle N concurrent `.afk-worktrees/` trees. Risk: a burst of concurrent
   `git worktree add` can transiently hit the repo index lock — catch + retry once.

## 4. Edge Cases & Risks

- **Non-git cwd:** detect before creating; structured error, don't fork.
- **Creation failure:** fail loudly; never fall back to the shared tree (reintroduces the bug).
- **Disk/sweep pressure:** the repo already carries heavy `.afk-worktrees/` sprawl. Aggressive
  teardown + sweep verdicts mitigate; consider a per-session concurrent-isolation cap.
- **Cleanup race:** a child still writing when teardown fires → `isDirty` sees it and *preserves*
  (correct but leaks) → `keep`-lock preserved trees so the sweep doesn't reap mid-work.
- **Windows:** slug/meta path handling already normalizes `\`/`/`; low incremental risk.

## 5. Migration

- Remove `isolation` from `RECOGNIZED_UNSUPPORTED_KEYS` (`parser.ts:43`).
- **Keep both** the first-class param AND the manual `worktree`-tool+`cwd` pattern (the latter is
  strictly more flexible: custom base ref, `keep`, cross-dispatch reuse). Do not deprecate the tool.
- After Phase 1, `refactor` / `shadow-verify` / `simplify` / `devils-advocate` "just work" (no edit
  required; add a one-line note). Migrate `diagnose/SKILL.md` from the manual pattern to
  `isolation:"worktree"` **only after Phase 2** (its "apply winner to main" step needs the returned
  branch from §3.6).

## 6. Effort & Phasing

- **MVP (~1–1.5 d):** extract create/remove (§3.4); schema+parse+mutual-exclusion (§3.1–2);
  executor create/set-cwd/teardown-remove (§3.3, §3.5 basic); skip-if-read-only (§3.7). Unblocks
  refactor/simplify/shadow-verify/devils-advocate.
- **Phase 2 (~0.5–1 d):** result-shape + content footer (§3.6); WIP-preserve + lock (§3.5 full);
  diagnose migration.
- **Phase 3 (~0.5 d):** concurrency hardening (create-lock retry, per-session cap), Windows pass,
  sweep-pressure telemetry.

## 7. Open Questions

1. **Background-mode cleanup ownership (must resolve before MVP).** The executor branches on
   `parsed.mode === 'background'` → `runBackgroundBranch` (`subagent-executor.ts:507`,
   `background-branch.ts`); the child outlives the executor's turn, so a foreground `finally` would
   destroy a still-running tree. **Recommendation:** forbid `isolation:"worktree"` +
   `mode:"background"` in MVP, or trigger removal from the background registry's completion callback.
2. Auto-name preserved-WIP branches (`afk/iso-<skill>-<timestamp>`) for human discoverability?
3. Does the installed git serialize concurrent `worktree add` cleanly, or is retry mandatory?

---

## Verification note

The two load-bearing structural claims were independently confirmed in the main session:
(a) `handlers/worktree.ts:192` is a monolithic `createWorktreeHandler(): ToolHandler` with inline
`case 'create'`/`case 'remove'` — no reusable extraction exists (confirms §3.4); (b) the executor
seam (`execute` → `parseAgentInput` → `buildChildConfig` → `forkSubagent` →
`runForegroundWithPromotion`) exists at the cited lines (confirms §3.3, §3.5). The background-mode
branch at `:507` confirms Open Question 1 is real. Not independently verified: the internals of
`foreground-promotion.ts` (exact teardown insertion line) and `background-branch.ts`.

---

## 8. Implementation orchestration plan (waves)

Produced by a planning sub-agent (2026-07-10) and re-verified by file read. **Honest parallelism
assessment: this feature is mostly serial.** Only Wave 1 has independent lanes, and they are
small; Wave 2 (the executor integration — the real work) cannot be parallelized because units 4
and 5 both edit `subagent-executor.ts`.

### Verified seam corrections (read before dispatch)
- Teardown lands in **`foreground-promotion.ts:310-330`** (the `if (!promoted)` finally branch),
  not `subagent-executor.ts:585`. Worktree path/branch must be threaded via a new field on
  `RunForegroundArgs` (`foreground-promotion.ts:42-64`).
- The extracted `createManagedWorktree`/`removeManagedWorktreeGuarded` **must accept an injectable
  `ExecFileFn`** — `worktree.ts` helpers (`resolveRepoContext:54`, `findEntry:123`,
  `resolveManagedWorktree:137`, `isDirty:155`, `commitsAhead:164`) all take `execFile` as a param
  and `worktree.test.ts:21` mocks it. Break that seam and parity tests fail.
- Executor already has `this.currentCwd` (`subagent-executor.ts:266,479`); the git-repo
  precondition uses existing `resolveWorktreeMainRoot` (`worktree-read-root.ts:72`).

### Wave 1 — independent foundations (3 parallel lanes; disjoint files)
| Unit | Creates/Edits | Tests | Acceptance |
|---|---|---|---|
| 1. Factor-out | creates `handlers/worktree-managed.ts`; edits `handlers/worktree.ts` (`case 'create':227-276`, `case 'remove':329-367` delegate) | new `worktree-managed.test.ts` + existing `worktree.test.ts` unchanged | parity: identical git argv; `worktree.test.ts` green |
| 2. Schema | edits `tools/schemas.ts` (isolation enum after `:399`) | schema smoke assertion | enum present; lint green |
| 3. Parse+validate | edits `subagent/input-parse.ts` (`AgentInput` `:15-65`; validation+return `:198-209`) | `input-parse.test.ts` | throws on `cwd`+`isolation`; **throws on `isolation:'worktree'`+`mode:'background'`** (MVP forbid); enum-validates |

File-set disjointness confirmed (worktree*.ts / schemas.ts / input-parse.ts — no overlap).
**GATE 1:** `pnpm lint && pnpm test` green.

### Wave 2 — executor integration (single serial lane; depends on 1+2+3)
| Unit | Edits | Tests | Acceptance |
|---|---|---|---|
| 4. Create + set-cwd | `subagent-executor.ts` between `buildChildConfig:474` and `forkSubagent:513` (git precondition on `currentCwd`; `createManagedWorktree`; set `childConfig.cwd`; structured error if non-git) | new `subagent-executor.isolation.test.ts` | tree created; cwd set; non-git → error, no fork |
| 4b. Teardown | `foreground-promotion.ts` (`RunForegroundArgs:42-64` + `if(!promoted)` branch `:310-330` → `removeManagedWorktreeGuarded({force:false})`) | same test | teardown fires on success/failure/abort; dirty/ahead preserved+locked |
| 5. Read-only skip | `subagent-executor.ts` (skip via `resolvedAccess`, `child-config.ts:154-167`) | same test | no-write child → creation skipped, soft note |

Units 4/4b/5 are ONE lane (4 & 5 both edit `subagent-executor.ts`). **GATE 2:** lint + test green.

### Wave 3 — cleanup (trivial; after Wave 2)
| Unit | Edits | Acceptance |
|---|---|---|
| 6. Un-ignore | `agents/parser.ts:43` (drop `'isolation'` from `RECOGNIZED_UNSUPPORTED_KEYS`) | parser tests green |

Sequenced last: removing it before the schema/executor honor `isolation` would turn agent-file
`isolation:` from a tolerated no-op into an unknown-key warning (transient regression).
**GATE 3:** lint + test green.

### Coordinator decisions to resolve during execution
1. `resolvedAccess` (Unit 5): surface it from `buildChildConfig`'s return, or compute the skip
   inside `child-config.ts`? (Affects Wave 2 lane shape.)
2. Worktree→teardown plumbing: new `RunForegroundArgs` field (recommended) vs. handling teardown
   in the executor around `:585`.
3. **MVP return-shape scope**: MVP stops at cwd-set + teardown, **no** `SubagentResult.isolation`
   field (that footer is Phase 2, §3.6). diagnose migration waits for Phase 2.
4. Branch-name counter source in the executor (`afk/iso-<idPrefix>-<counter>-<rand>`).
