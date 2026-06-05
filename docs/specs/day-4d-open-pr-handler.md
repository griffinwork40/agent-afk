# Spec: Day 4d — Open PR Handler for the Speculative Branch Farm

**Type:** Feature (new handler replacing a stub)  
**Branch:** Stack on `feat/farm-day-4b`  
**PR:** Will extend PR #273 (Day 4b + 4c + 4d)

---

## 1. Problem Statement

The farm digest Telegram message exposes four inline buttons: `x` (Discard), `d` (Diff), `p` (Open PR), and `r` (Respawn). Days 4b and 4c fully wired `d` and `r`. The `p` button is currently a stub — it calls `safeAnswer(ctx, 'Open PR — coming in Day 4d', log)` and returns without performing any work.

This is not a safe neutral state: the button is user-visible, its label implies a real action, and the schema already has `prUrl` / `prCreatedAt` fields that are never written. Day 4d removes the stub and replaces it with a working handler that calls `gh pr create`, writes the result back to the manifest, and confirms success in-chat.

---

## 2. Scope

### In scope

1. **`src/agent/gh.ts` — new `gh` wrapper module**  
   A thin `execFile`-based wrapper exposing:
   - `checkGhReady(): Promise<GhReadiness>` — probes `gh --version` and `gh auth status` without side effects. Returns a discriminated union: `{ ok: true }` or `{ ok: false; hint: string }`. The hint is human-readable and safe to surface in Telegram (e.g. `"gh is not installed. Install: brew install gh"` or `"gh is not authenticated. Run: gh auth login"`).
   - `createPr(opts: CreatePrOpts): Promise<string>` — calls `gh pr create --base <base> --head <branch> --title <title> --body <body> [--repo <repo>]` via `execFile` (never shell-interpolated). Returns the PR URL on success. Throws a typed `GhError` on failure, carrying `.exitCode`, `.stderr`, and a `.kind` discriminant (`'not-found' | 'already-exists' | 'unauthed' | 'network' | 'unknown'`).  
   - Both functions accept an injectable `execFn` parameter (same pattern as `execGit` in the existing callbacks) so tests never shell out to real `gh`.

2. **`src/agent/worktree.ts` — `recordPrCreated` helper**  
   A new exported function following the exact shape of `recordRespawn` and `setFarmMemoryFactId`:
   ```ts
   export async function recordPrCreated(
     taskSlug: string,
     prUrl: string,
     opts?: { now?: () => Date },
   ): Promise<FarmManifest>
   ```
   - Loads the manifest, sets `manifest.prUrl = prUrl` and `manifest.prCreatedAt = (opts?.now ?? (() => new Date()))().toISOString()`, enforces `schemaVersion = 3`, and writes back atomically. Returns the updated manifest.
   - Does NOT modify `human_decision` — PR creation is not the same act as approval.

3. **`src/telegram/handlers/farm-callbacks.ts` — replace the `p` stub**  
   - Remove the one-liner `safeAnswer(ctx, 'Open PR — coming in Day 4d', log)`.
   - Add `handleOpenPr(ctx, manifest, deps, log)` as a new internal function following the same structural contract as `handleRespawn` and `handleDiscard`.
   - Add two new injectable deps to `FarmCallbackDeps`:
     ```ts
     checkGhReady?: typeof checkGhReady;          // for pre-flight
     createPr?: typeof createPr;                  // the actual gh call
     recordPrCreated?: typeof recordPrCreated;    // manifest write
     ```
   - Wire `case 'p': return handleOpenPr(ctx, manifest, deps, log)` in the dispatch switch.

4. **Tests** (see Section 5 for full requirements)

### Out of scope

- Garbage collection / farm cleanup (Day 4e or later).
- `writeFarmDecisionFact` supersede wiring (independent debt, deferred).
- Any changes to the Respawn handler, the Diff handler, or any Day 4c work.
- Setting `human_decision = 'approved'` on PR open — that decision is distinct from the mechanical act of raising a PR, and the spec defers it explicitly.
- PR templates, custom labels, or reviewers.

---

## 3. Behavioural Contract for `handleOpenPr`

### Idempotency
If `manifest.prUrl` is already set, answer `"PR already open: <url>"` and return. Never call `gh pr create` twice for the same farm.

### Pre-flight
Before shelling out, call `checkGhReady()` (real or injected). If `ok === false`, answer with the embedded hint string and return. This must produce a visible Telegram message — silent failure is unacceptable.

### Which branch to use
Call `resolveWinnerBranch(manifest)` (already injectable in `FarmCallbackDeps` from Day 4b). The PR is opened from that winner branch. Use `manifest.repoRoot` as the `--repo` path (or omit and run `gh` with `cwd` set to the winner's worktree path, whichever makes `gh` resolve the correct remote).

### PR metadata defaults
- `--base`: `manifest.baseBranch ?? 'main'` — derive from the manifest's recorded base ref name; fall back to `'main'` for detached-HEAD farms.
- `--title`: `manifest.taskName` (the original human-supplied task description).
- `--body`: A minimal auto-generated body:
  ```
  Opened by agent-afk farm `<taskSlug>`.
  Winner branch: `<winnerBranch.branch>`.
  Farm created: <manifest.createdAt>.
  ```
- `--head`: `winnerBranch.branch` (the full ref, e.g. `afk/farm/<slug>/1-branch-1`).

### Success path
1. `gh pr create` succeeds → returns the URL string.
2. Call `recordPrCreated(manifest.taskSlug, prUrl)` (best-effort, same error-log-and-continue semantics as `recordRespawn`'s manifest write).
3. `answerCbQuery("PR opened ✓")`.
4. `ctx.reply("🔗 PR opened: <url>")` — a durable in-chat message, not just the transient ack toast.

### Failure paths
| Scenario | Handler behaviour |
|---|---|
| `gh` not installed | `answerCbQuery(hint)` from `checkGhReady` |
| `gh` not authenticated | `answerCbQuery(hint)` from `checkGhReady` |
| `resolveWinnerBranch` throws | `answerCbQuery("Winner lookup failed")` |
| `createPr` throws `GhError` kind `already-exists` | `answerCbQuery("PR already exists for this branch")` |
| `createPr` throws `GhError` kind `network` | `answerCbQuery("Network error — check gh connectivity")` |
| `createPr` throws `GhError` kind `unauthed` | `answerCbQuery("gh authentication lost — run: gh auth login")` |
| `createPr` throws `GhError` unknown | `answerCbQuery("gh pr create failed — see daemon logs")` |
| `recordPrCreated` throws | Log, continue — ack already sent |

---

## 4. `checkGhReady` Caching Strategy

The spec input proposes caching the readiness check once at session start. **This spec calls for a simpler, safer approach**: call `checkGhReady()` lazily on every button press, but cache the last result in module-level state with a 60-second TTL. Rationale:

- The readiness probe (`gh --version && gh auth status`) takes ~50 ms and succeeds on every normal press. TTL-caching avoids repeated syscalls in rapid re-clicks while still detecting a user who runs `gh auth login` mid-session within a minute.
- Session-start eager check requires coupling the Telegram bot startup sequence to a subprocess — adds startup latency and a failure mode during bot init. The lazy approach requires no wiring changes outside `farm-callbacks.ts` and `gh.ts`.

Cache TTL of 60 seconds is an implementation detail the implementer may adjust; it must be injectable in tests (default: 60 000 ms; tests pass `0` to disable caching).

---

## 5. Success Criteria

### Functional
- [ ] Pressing `p` on a farm with no `prUrl` creates a PR via `gh pr create` using `execFile` (no shell).
- [ ] `manifest.prUrl` and `manifest.prCreatedAt` are written back to `farm.json` after a successful call.
- [ ] Telegram receives a durable reply with the PR URL (not just the ack toast).
- [ ] Pressing `p` a second time on a farm with `prUrl` already set returns `"PR already open: <url>"` and does not call `gh pr create`.
- [ ] Pressing `p` on a machine without `gh` installed produces a human-readable install hint in the ack — never a silent no-op.
- [ ] Pressing `p` on a machine with `gh` installed but unauthenticated produces an auth hint.

### Quality gates
- [ ] All **3 558** existing tests remain green (`pnpm test`).
- [ ] `pnpm lint` passes with strict `tsc` (`noImplicitAny`, `strictNullChecks`, etc.).
- [ ] New tests cover:
  - `gh.ts` wrapper: success path returning URL, `gh` binary missing (ENOENT), `gh auth status` fails (unauthed exit code 1), network error from `gh pr create`, `already-exists` detection from stderr.
  - `recordPrCreated` in `worktree.ts`: writes `prUrl`, `prCreatedAt`, and bumps `schemaVersion` to 3.
  - `handleOpenPr` integration in `farm-callbacks.test.ts`: success end-to-end (mock all three deps), idempotency guard, pre-flight failure surface, `resolveWinnerBranch` failure path, `createPr` failure paths.
  - The old stub test (`'p' stub acks without touching the manifest'`) must be **replaced** by the new handler tests — leaving the old stub assertion would be a false pass after the stub is removed.

---

## 6. Key Constraints

**Security:** `gh pr create` args are assembled from manifest fields (never from the raw callback payload). Branch names come from `manifest.branches[*].branch`, which was set at farm creation from trusted internal code. No user-supplied string from the Telegram message ever reaches the `execFile` args array.

**Isolation:** `gh.ts` must not import anything from `telegraf` or Telegram-specific code. It is a pure agent-layer utility. `farm-callbacks.ts` imports from `gh.ts`; `gh.ts` knows nothing about Telegram.

**No shell:** The `createPr` function must use `execFile` (promisified), never `exec` or `spawn` with `shell: true`. This is already the established convention in `farm-callbacks.ts` for git calls.

**Error surfacing:** Every failure branch that a user could trigger with a bad environment state must produce a non-empty human-readable string in the Telegram ack. "Silent fail" is the specific risk we're eliminating from the prior stub.

---

## 7. File Map

| File | Change |
|---|---|
| `src/agent/gh.ts` | **New** — `checkGhReady`, `createPr`, `GhError`, `GhReadiness` types |
| `src/agent/worktree.ts` | **Add** `recordPrCreated` export (~25 lines, mirrors `recordRespawn`) |
| `src/telegram/handlers/farm-callbacks.ts` | **Replace** `p` stub with `handleOpenPr`; add `checkGhReady`, `createPr`, `recordPrCreated` deps to `FarmCallbackDeps` |
| `src/agent/gh.test.ts` | **New** — unit tests for the `gh` wrapper |
| `src/agent/worktree.test.ts` | **Add** `recordPrCreated` coverage block |
| `src/telegram/handlers/farm-callbacks.test.ts` | **Replace** PR stub test block; add `handleOpenPr` test suite |

---

## 8. Assumptions

- `gh` CLI is the GitHub CLI (`github.com/cli/cli`); no other GitHub API client is in scope. The codebase has no existing `gh` wrapper — this is the first.
- The farm's `repoRoot` (an absolute path recorded at creation) is always a valid git repo with a configured GitHub remote by the time the user presses `p`. If it isn't, `gh pr create` will fail with a recognisable error and the handler will surface it.
- `manifest.baseBranch` is populated for the normal farm workflow (non-detached HEAD). Detached-HEAD fallback to `'main'` is a safety net, not the primary path.
- The existing `resolveWinnerBranch` injectable in `FarmCallbackDeps` is already available from Day 4b — no new surface is needed to determine which branch to PR from.

---

## 9. Branch Strategy Decision

**Recommendation: stack on `feat/farm-day-4b` and amend PR #273 to cover 4b + 4c + 4d.**

Rationale: 4d is tightly scoped (~150–200 new lines of production code, ~150–200 lines of tests). Splitting it to its own branch and PR adds merge-coordination overhead with no reviewer benefit — PR #273 already has a complete diff that reviewers can absorb in one pass. If PR #273 has not received review by the time 4d lands, the implementer should ping the reviewer explicitly rather than splitting the branch.

If the implementer or reviewer strongly prefers isolation, the split point is clean: branch `feat/farm-day-4d` off `feat/farm-day-4b`, merge back into `feat/farm-day-4b` after review, then force-push #273.
