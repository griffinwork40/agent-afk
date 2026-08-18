# Enforce the 350-code-line ceiling

**Status:** Phase 0 (the gate) implemented and green. The refactor waves have not
started — this document is the protocol they must follow.
**Decided:** 2026-08-10. **Metric revised:** 2026-08-18 (raw → code-line).

Counts below say "136", which was the population under `src/` at the time of the
raw-line measurement. After the metric revision to code-only (non-blank,
non-comment), **94 of 136 files retired immediately** — `.filesize-baseline.json`
now holds ~42 entries. Both numbers are live and drift with the tree; re-measure
with `pnpm audit:filesize:list` rather than trusting these.

## Problem

136 of 885 non-test `.ts` files under `src/` exceeded 350 raw lines (`wc -l`),
totalling 82,574 LOC with 34,974 lines of excess. Nine files exceed 1,000 lines;
the largest is `src/config/env.ts` at 1,877.

The operator's standing rule — no source file over 350 lines — is justified on
agent-context grounds: an oversized file costs an agent most of a working
context just to establish what it may safely touch, and the failure mode is
silent, because the agent edits from a partial read. At the ceiling you pull one
whole *concern* into a new file. You never shave lines and never raise the limit.

## Metric decision: 350 CODE lines (revised 2026-08-18)

The original gate (2026-08-10) measured 350 **raw** lines (`wc -l` semantics) —
comments counted deliberately. Operator overruled the code-line metric at the
time, accepting the consequence that comment-heavy files near the ceiling would
need extraction to add documentation.

In practice the raw metric created perverse incentive pressure: agents facing
the ceiling shaved, condensed, or deleted comments to stay under — despite
explicit instructions not to. The 128-entry baseline (all "pending concern
extraction") never drained, and 48% of lines near the ceiling were
comments/blanks. The operator reversed the decision on 2026-08-18.

**Current metric: 350 non-blank, non-comment lines.** A line-oriented heuristic
classifies comments (`//`, block comments, JSDoc); lines with trailing comments
count as code. The heuristic errs toward "not a comment" so the ceiling is never
looser than reported. Comments are now free — write as many `Invariant:`,
`Contract:`, and `History:` blocks as needed.

## Scope decision: file AND function (reconciles #831 / #832)

This campaign was preceded by a triage — **#832** (tracking) and **#831** (gate
design) — filed 2026-08-01. Phase 0 shipped without citing either, so the
reconciliation is recorded here.

**#831 argued that a file-scoped gate is the wrong instrument**, on measurement:
146 of 756 files (19.3%) exceeded 350, ~40% of the largest were large from
*breadth* rather than entanglement (flat registries, an NDJSON wire schema, an
18-handler dispatch chain), and a gate firing on a fifth of the tree "gets
disabled within a week". It proposed a **function**-scoped primary rule, a looser
file rule at 800–1000, an allowlist with rationale, and ratchet mode.

Of those four asks Phase 0 delivered the last two and inverted the first two.
What discharges the "fires 146× on day one" objection is the ratchet — which was
#831's own item 4 — because the 138-entry baseline means the gate fires **zero**
times on day one. What it did *not* discharge is the metric argument: file LOC
still does not predict maintenance pain, and grandfathering merely parks the
false positives rather than answering them.

So both gates now exist, and they measure different things:

| | measures | ceiling | baseline |
|---|---|---|---|
| `check-file-size.ts` | how much must be **read** to establish edit safety | 350 code lines | ~42 files (~4.2%) |
| `check-function-size.ts` | how much must be **held in mind** to change one behaviour | 200 lines | 54 functions (1.2%) |

Neither implies the other, in both directions: a 900-line flat registry is a
large file containing no large function, and a 700-line function can sit inside a
file that passes 350 only because siblings were extracted around it. The sharpest
case is **#919** — #829 shrank `subagent.ts` and closed, while `forkSubagent`
itself never changed and has since grown to 586 lines. A file gate scores that as
progress. The function gate does not.

The function ceiling is **200**, taken from the measured distribution over 4,388
functions (median 10, p99 229): 350 would catch only 15 functions and miss the
entire 200–350 band, while 200 yields a 54-entry baseline — one screen, which is
what keeps it honest. #831's own framing: *"a gate whose allowlist you can read
is a gate that gets fixed."*

**Consequences for the wave plan.** #832's Tier 4 list — `env.ts`,
`trace/types.ts`, `schemas.ts`, `terminal-compositor.ts`, `…input-dispatch.ts`,
`interactive/shared.ts` — is *"explicitly leave alone"*, and all six are
grandfathered rather than scheduled. In particular `src/config/env.ts` is
governed by open issue **#830** (generate the getters from `ENV_REGISTRY`; do not
split the file — `scripts/audit-env-access.ts:45` hardcodes that exact path,
exact-matched at `:175`). The waves below are sequenced **entanglement-first**;
selecting a wave for "maximum mass" is precisely the objective #831 refutes.

## How to hit 350 raw without shaving comments

This is the crux. The repo *mandates* long comment blocks: any block of ≥15
contiguous lines must be prefixed `// Invariant:`, `// Contract:`, or
`// History:` (AFK.md, "Long-comment prefix convention"). A raw line ceiling
therefore taxes exactly the documentation the repo requires.

The escape hatch AFK.md offers — `// History:` migrates to `docs/<area>.md`
leaving a ≤5-line summary + link — turns out to be nearly empty: only **14
`History:` occurrences repo-wide**, present in just 5 of the 90 comment-heavy
files, versus **201 `Invariant:`** and **39 `Contract:`** blocks that explicitly
stay inline.

The real lever is that **JSDoc travels with its declaration**. The comment-heavy
cohort averages raw 486 / code 240 / **jsdoc 142**. Extracting one declaration
group carries its doc comments out with it: nothing is deleted, nothing is
relocated anywhere worse, and `Invariant:`/`Contract:` blocks remain inline with
the code they govern — which is what happens automatically when that code moves.

**Sanctioned transformations, in priority order:**

1. **Declaration-group extraction** (primary, applies to nearly all 136) — move a
   whole concern, declarations together with their attached JSDoc.
2. **History migration** (rare, ~5 files) — `// History:` → `docs/<area>.md`,
   leaving a ≤5-line summary + link. Already mandated "on next touch".

**Forbidden:** deleting any comment; reflowing or condensing JSDoc; collapsing
block comments to one-liners; deleting dead code to make a number; and
specifically **reclassifying an `Invariant:` or `Contract:` block as `History:`
to make it migratable** — AFK.md pre-empts this exact gaming vector ("When in
doubt between `Invariant:` and `History:`, use `Invariant:` — false-shrink is a
regression").

## Sibling arithmetic

| Cohort | Files | 1 sibling | 2 | 3 | 4+ |
|---|---|---|---|---|---|
| Comment-heavy (code ≤350) | 90 | **75** | 14 | 1 | — |
| Code-heavy (code >350) | 46 | 11 | 18 | 11 | 6 |

≈**210 new sibling files**, not the ~370 a naive line-count division implies.
Seventy-five files need a single extraction each.

## Gate scope: non-test source only

The gate scans non-test `.ts` under `src/`. **223 test files exceed 350 raw**
(largest 3,567 lines) and are excluded deliberately: the rule's rationale is
edit-safety from a partial read, and a 3,000-line test file is a flat list of
independent cases an agent greps into, never read whole to establish edit
safety. This matches the precedent script in the operator's Swift repo
(`app/Scripts/check-file-size.sh`), which scopes to source and deliberately
exempts prose. Reversible via one constant if tests should be included later.

## Chosen approach

### Phase 0 — the gate (blocks the waves)

1. `scripts/check-file-size.ts` — code-line count (non-blank, non-comment), LIMIT 350, WARN 315.
2. `.filesize-baseline.json` — grandfathers today's 138. **Generated, never
   hand-edited** (`--update-baseline`); `reason` / `permanent` preserved by key.
3. Three failure modes, making the baseline a one-way ratchet:
   - a non-baseline file exceeds the ceiling → FAIL;
   - a baseline entry **grew** since baselining → FAIL;
   - a baseline entry is now **under** the ceiling → FAIL, "remove it from the
     baseline" (so the ratchet can never silently slacken).
4. `--changed-vs <ref>` touch-trigger mode: if a diff modifies a baselined file,
   that file must come under the ceiling in the same PR. This matters because
   **100% of the 136 were touched within 90 days** (67% within 14) — zero are
   cold, so touch-triggering retires stragglers for free even if the campaign
   stalls.
5. `package.json`: `audit:filesize`, `audit:filesize:check`, `audit:filesize:update`.
6. `.github/workflows/ci.yml`: new step beside the other audits.
7. `.gitattributes`: `-merge -diff` on the baseline so git never invents a broken
   JSON hybrid; collisions are resolved by regeneration, not by editing markers.
8. Document in **both** AFK.md and CLAUDE.md (they drifted apart once already).

### Phase 0.5 — guards the critique earned

9. `scripts/audit-module-state.ts` — fail when the same module-scope mutable
   singleton (`let x`, `new Map/Set/WeakMap`) or a `process.on(` registration
   appears in more than one file of a `<base>.` sibling family. **18 of the 136
   carry this hazard.** Live case: `src/agent/trace/writer.ts:142-148` holds
   `liveTraceWriters` + `exitBackstopInstalled` gating a `process.on('exit')`
   trace-sealing backstop; a split that re-declares rather than imports those
   bindings silently unseals traces on crash, and `writer.test.ts:177` calls
   `sealOnProcessExit()` directly so the existing suite would not catch it.
10. Circular-import detection in CI — absent today, and extraction-induced cycles
    are already a live risk (`terminal-compositor.frame-preserve.ts:7-8` needed
    `import type` specifically to dodge one).

### Phases 1–N — the waves (hard-first)

- **W1** (2 solo PRs): `config/env.ts` (1877) and `agent/tools/schemas.ts` (1323)
  — both data tables, so maximum mass at minimum risk, and it validates the
  gate/baseline/anti-shave machinery on real splits. `env.ts` carries its
  `scripts/audit-env-access.ts` `ALLOWED_FILES` companion edit **in the same commit**.
- **W2–W9** (width 1, human-reviewed): the 8 god-objects — `agent-session.ts`
  (1440), `dispatcher.ts` (1428, gate ORDER is a documented security invariant),
  `openai-compatible/query.ts` (1374), `subagent/handle.ts` (864),
  `telegram/handlers/message.ts` (939), `input/reader.ts` (900, one function with
  30+ closured lets), `interactive/turn-handler.ts` (996), `interactive.ts` (981).
- **W10–W14** (width 4–6, one subtree per PR): remaining 36 code-heavy files.
- **W15–W29** (width 6, one subtree per PR): the 90 comment-heavy files.
- `terminal-compositor.committed-band-commit.ts` gets the single
  `permanent: true` baseline entry: `commitAbove` is one atomic 3-phase
  terminal-escape transaction whose inline invariants are the only guard against
  regressing bugs #81/#403/#467.

Sizing: 29 waves, ~30 PRs, ~210 new siblings, peak 6 concurrent write-capable
subagents (429s cause ~35% of subagent failures here — issue #941), roughly 2–3
weeks at 2–3 waves/day.

## The regrowth problem, and the defense

Sibling extraction **has already failed in this repo** and the evidence is
unambiguous:

- `src/cli/terminal-compositor.ts` is **1,168 lines today after 18 siblings were
  extracted from it**;
- **5 of those 18 siblings are themselves over the ceiling**, one at 1,153 —
  nearly the size of the parent;
- `terminal-compositor.committed-band-commit.ts` **grew 474 → 847 lines (+79%)**
  across 16 commits since its birth on 2026-06-10.

Extraction relocated the mass and then it regrew, because nothing gated the
products. Two defenses:

1. **The gate applies to new siblings from birth** — this is why Phase 0 must
   land before any wave.
2. **Every extracted sibling must ship a test that constructs no parent
   instance.** If it cannot be tested standalone it is not a seam — park the file
   and report `UNSPLITTABLE` rather than force it. This is the mechanical form of
   "demonstrated encapsulation", and it is exactly what the 18 prior compositor
   extractions lacked: their own headers describe free functions mutating a
   shared `Host` slice, i.e. method extraction over one live instance, not
   decoupling.

## Dispatch-brief invariants (verbatim to every refactor subagent)

1. The original file never moves and keeps its exact public surface.
2. No importer is ever rewritten. Zero edits outside the target, its new
   siblings, and (when applicable) `scripts/audit-*.ts`.
3. Sibling naming: `<base>.<concern>.ts` kebab-case; for a file already inside its
   own directory, plain-named siblings in that directory. No new subdirectories.
4. Never name a new file `types.ts` if it holds runtime logic — vitest coverage
   excludes `src/**/types.ts`, so logic there is invisible to the gate.
5. Never delete, reflow, or condense a comment; never reclassify
   `Invariant:`/`Contract:` as `History:`.
6. Prove the sibling is imported (`grep -rn <basename> src --include=*.ts`) —
   esbuild has 3 fixed entrypoints and silently tree-shakes orphans with zero CI signal.
7. Audit-allowlist companion edit lands in the SAME commit when a new sibling
   contains raw `process.env` or `chalk.<style>` (exact-string allowlists).
8. Verify test reach before splitting; do not add, rename, or modify any test file
   — zero test churn is the parity proof both precedent commits cite.
9. Run `pnpm lint`, then `pnpm test <file>` (**no `--`**: pnpm 10 drops args after
   `--` and runs the entire suite).
10. Return `UNSPLITTABLE` + reason rather than shave. A parked file is a valid
    outcome; a shaved file is not.

## Verification gates

| Gate | Per-file | Per-wave | Rationale |
|---|---|---|---|
| `pnpm lint` | yes | yes | ~30s, catches every NodeNext/strict breakage |
| `pnpm test <file>` | yes | — | seconds; the only loop tight enough per file |
| `pnpm test` (full) | no | yes | dotted-sibling tests reach across a directory |
| `pnpm audit:filesize:check` | yes | yes | ~1s, the ratchet's own gate |
| `audit:env` / `audit:chalk` | if allowlisted | yes | ~2s; a missed entry reddens the wave |
| `pnpm test:coverage` | no | when ≥5 siblings added | only 1.4pt headroom |
| `pnpm build:dist` | no | yes | the only gate proving sibling reachability |
| `pnpm test:pty` | no | compositor/input waves | needs native node-pty |

## Anti-shave guard

- insertions ≥ deletions (a real split adds barrel/import lines);
- total comment lines across parent + siblings ≥99% of before;
- count of `Invariant:` + `Contract:` tags non-decreasing (catches reclassification);
- zero test churn.

## Stop / park rules (observable, not judgment)

- any comment-conservation failure, or `delta < 0` → stop;
- full-suite failures >0 after scoped tests passed → stop;
- coverage statements <74.8 (0.8 of the 1.4pt headroom consumed) → stop;
- `dist` bundle shrinks >2% → silent tree-shake, stop;
- ≥2 subagents hit 429 in one wave → drop wave width by 2; recurrence → stop;
- ≥2 `UNSPLITTABLE` returns in one wave → the archetype rule is misclassifying;
  reclassify that area before continuing;
- >3 wave PRs open simultaneously → land before launching (rebase storms).

## Alternatives considered

Three independent critics reviewed this; all three conceded the ratchet gate is
correct, and two returned *strong* alternatives against the all-136 campaign
(`dissent = true`).

1. **Gate + touch-triggered enforcement only** (pragmatist, strong) — ship the
   gate, enforce the ceiling only on files a diff actually touches, proactively
   split just the 9 files >1000 lines. Evidence: 100% of the 136 are touched
   within 90 days, so touch-triggering reaches all of them within a quarter with
   zero speculative refactoring; CHANGELOG already logs ~18 unprompted "split
   under the 350 ceiling" commits. **Rejected by operator decision to do all 136**,
   but its mechanism is retained as the `--changed-vs` mode.
2. **Coupling-boundary metric** (architect, strong) — cap how many modules hold
   mutable-reference access into one class's private state instead of counting
   lines; a size gate cannot see shared-mutable-state fan-out. Right diagnosis,
   rejected on cost: requires dependency-graph tooling the repo does not have.
3. **State-aware split rule** (paranoid, medium) — only pure functions/types/
   constants may move mechanically; anything touching module-scope singletons or
   signal handlers is auto-escalated to serialized review. **Adopted** as
   `scripts/audit-module-state.ts` plus the standalone-test criterion.
4. **Code-line metric (350 non-comment non-blank)** — would cut the target set
   from 136 to 46. Recommended, **overruled by the operator**; recorded here
   because the WARN tier and the "never reclassify a comment" prohibition exist
   specifically to blunt the raw metric's incentive to attack documentation.

## Risks

- **Baseline is a merge-conflict magnet** — every wave removes its files from it.
  Mitigated by generation (`--update-baseline`) + `.gitattributes -merge`;
  resolution is `git checkout origin/main -- .filesize-baseline.json &&
  pnpm audit:filesize:update`, never editing conflict markers.
- **Coverage floor has only ~1.4pt headroom** (74/79/82/74 vs 75.42/80.65/83.9/75.42).
- **esbuild silently tree-shakes orphan siblings** — no CI signal; `build:dist`
  per wave is the only detector.
- **`src/cli/system-prompt.ts` must not be split**: `scripts/esbuild-plugin-inline-prompts.mjs:271-280`
  string-matches the literal body of `loadSystemPrompt()`; breaking it fails
  `build:dist`, not `pnpm test`. (It is 113 lines, so not a target anyway.)
- **`src/telegram/entry.test.ts:37`** asserts `existsSync('src/telegram.ts')` — path-pinned.
- **Raw metric penalises mandated documentation** — see the WARN tier and the
  comment-conservation guard.
