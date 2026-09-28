# Proposal: `verified_outcome`, a session outcome label built from observed facts

Status: ACCEPTED design (2026-09-27). Operator decisions recorded under
"Resolved decisions". M0 done; see "M0 results" (exit check FAILED, which
re-ordered M2).

## Why

Every downstream use of session data (routing, skill evolution, evals, any
future training) needs to know whether a session actually worked. Today it
cannot:

- `outcome` is `fully_achieved` whenever the last assistant reply is non-empty
  (`src/agent/facets/derive.ts:237-240`). 4,444 of 4,497 facets say
  `fully_achieved`. The label never abstains, so it carries almost no
  information.
- `yield_tracking.produced_pr / pr_merged` exists but is probed once, at
  teardown, by branch name (`src/agent/facets/yield-probe.ts`). In the newest
  1,500 facets it is `null/null` for 1,439, and `pr_merged` is read before most
  PRs could possibly have merged.

The goal is a label that is (1) derived from facts the harness observes, never
from the agent grading its own transcript, (2) allowed to say "unknown", and
(3) able to settle later as delayed evidence (merges, reverts) arrives.

## Design principles

1. **Additive.** `outcome` and `primary_success` stay byte-identical. They have
   string-level consumers: `fragility-audit`, `omission-audit`,
   `scope-debt-collector`, `error-locality`, the `get_facet` tool, and three
   pinned tests in `derive.test.ts:107-160`.
2. **Self-report is never sufficient.** A `**Done**` block is recorded as
   evidence but cannot by itself produce `succeeded`. This is the Goodhart
   guard: the label must not reward the agent for claiming success.
3. **Abstain by default.** `unknown` is a first-class value and is not
   negative. Most research and Q&A sessions will be `unknown`, and that is
   correct.
4. **Evidence, not a verdict.** Each label carries the list of labeling-function
   votes that produced it, with pointers, so every label is auditable.
5. **Delayed labels settle; they do not flip silently.** A label is
   `provisional` until its delayed probes resolve or expire, then `settled`.
   Later revisions (a revert after settling) are appended, not overwritten.

## Label shape

```ts
type VerifiedOutcome = {
  schema_version: 1;
  session_id: string;
  label: 'succeeded' | 'failed' | 'interrupted' | 'blocked' | 'unknown';
  confidence: number;            // 0..1, from the combiner
  state: 'provisional' | 'settled';
  settles_after: string | null;  // ISO; when delayed probes expire
  session_kind: 'mutating' | 'text';  // world_changes.mutated
  self_report: 'done' | 'blocked' | 'asking' | 'interrupted' | 'none';
  artifacts: { commits: string[]; prs: string[]; repo: string | null };
  votes: Array<{
    lf: string;                  // labeling-function id
    vote: 1 | -1 | 0;            // 0 = abstain
    strength: 'strong' | 'weak';
    evidence: string;            // file:line, sha, PR url, trace seq
    observed_at: string;
  }>;
  history: Array<{ at: string; label: string; reason: string }>;
};
```

### Storage: a separate store, not a facet patch

Facets are re-derived whenever `FACET_VERSION` bumps or the session file's
mtime changes (`store.ts:89-91`). A delayed label patched into the facet (the
`yield_tracking` pattern) would be wiped on the next re-derive. Labels live in
their own store instead:

- `~/.afk/agent-framework/outcomes/<sessionId>.json`, resolved through a new
  `src/paths.ts` helper (never hand-joined).
- Atomic tmp+rename writes (same protocol as `patchYieldFields`).
- `get_facet` joins it at read time as an optional `verified_outcome` key.
  Existing consumers see no change.

## Labeling functions (LFs)

Every input below was measured on real data this session. Coverage figures are
from samples of the newest sessions.

### Immediate LFs (computed at session teardown)

Source: the session JSON `turns[].toolEvents[]` (tool name, args, `isError`, a
~90-char `result` preview) and the witness trace.

| LF | Vote | Strength | Signal | Coverage |
|---|---|---|---|---|
| `closure` | interrupted | strong | trace `closure.reason == abort` | abort in ~5-8% of traces |
| `budget_cap` | -1 | weak | `closure.reason == iteration_cap` | ~1% |
| `error_tail` | -1 | strong | 3+ consecutive `isError` tool calls ending the session | ~49% have any error; tail is rarer |
| `verification` | +1 / -1 | strong | a test/lint/build command (`pnpm test`, `vitest`, `tsc`, `pytest`, `cargo test`, `go test`, `test_run`) ran after the last edit: exit 0 is +1; a failure with no later pass is -1 | only for mutating sessions; to measure in M0 |
| `in_session_correction` | -1 | weak | a later user turn opens with correction language (no / wrong / revert / still broken / that's not) | keyword scan only ~1%; weak by design |
| `self_report` | recorded, 0 vote | n/a | parse the final `**Done** / **Blocked** / **Asking** / **Interrupted**` block. Blocked sets `label=blocked`; the others never vote | ~93% have a block |
| `artifacts` | 0 vote | n/a | recover commit SHAs from `git commit` result previews (`[branch sha] msg`) and PR URLs from `gh pr create` previews | 433/460 commits (94%), 170/194 PRs (88%) recoverable |

The artifact recovery is the key enabler. It gives exact session → commit → PR
linkage for existing history with no new instrumentation.

### Delayed LFs (daemon shell job, nightly)

Run for sessions with `state == provisional` and recovered artifacts. They reuse
`queryPrState` (`yield-probe.ts:65-98`) and `getPrMergedAt`
(`gh-fix-of-fix.ts:119-155`).

| LF | Vote | Strength | Signal | Settles |
|---|---|---|---|---|
| `pr_fate` | +1 merged / -1 closed unmerged | strong | `gh pr view <n> --json state,mergedAt` | on terminal state, or abstain after 14 days open |
| `commit_survival` | +1 / -1 | strong | SHA is an ancestor of `origin/<default>` after 7 days (`git merge-base --is-ancestor`); -1 if `git log --grep "This reverts commit <sha>"` finds a revert. Squash-merged work is handled by `pr_fate`, since squashing orphans the original SHA | 7 days |
| `fix_of_fix` | -1 | weak | a later PR references this session's PR as fixed or regressed, using the patterns already in `gh-fix-of-fix.ts` | 7 days (`FIX_OF_FIX_WINDOW_DAYS`) |
| `ci` | +1 / -1 | weak | `gh pr checks <n>` conclusion | on completion |
| `cross_session_reask` | -1 | weak | a new session in the same `cwd` within 30 min whose first prompt closely matches this session's | 30 min |

Cost: `gh` calls only for sessions that produced a PR (~5% of sessions), so
tens per night. Sessions whose `cwd` is not a git repo or no longer exists skip
delayed LFs (all abstain).

## Combiner

### v1: ordered, transparent rules (ship first)

Evaluated top to bottom; the first match wins:

1. `closure` says abort and there are no artifacts → `interrupted`.
2. `self_report == blocked` → `blocked`.
3. Any strong -1 (revert, PR closed unmerged, verification failed, error tail)
   and no later strong +1 → `failed`.
4. Any strong +1 (PR merged, commit survived, verification passed after last
   edit) and no strong -1 → `succeeded`.
5. Otherwise → `unknown`.

Confidence = strong votes agreeing ÷ strong votes cast, discounted by 0.2 for
each weak vote that disagrees; `unknown` gets 0. Deliberately crude: it exists
so the gold set has something to measure against.

### v2: probabilistic label model (only after the gold set exists)

Replace the rules with a Snorkel-style label model over the same LF vote
matrix, calibrated against the gold set (isotonic regression). Do not build
this until v1's per-LF precision numbers show which LFs actually deserve
weight.

## Gold set

- Label 200 sessions by hand (about 1-2 hours): 150 for LF development, 50 held
  out and never looked at while tuning. Stratify 50/50 mutating vs text, and
  across repos.
- Tooling: a small script that prints the first prompt, final reply, artifacts
  and LF votes, and records the human verdict. Not a new `afk` subcommand.
- Acceptance bar for v1: **precision ≥ 0.85 on both `succeeded` and `failed`**
  on the held-out 50. Coverage (the share of non-`unknown`) is reported but not
  gated; a precise label on 20% of sessions beats a noisy label on 100%.

## Explicit feedback (accepted)

A one-keystroke rating: `/good` or `/bad` in the REPL, or a thumbs reaction in
Telegram. It writes an `explicit_feedback` vote into the session's outcome
record.

- It is the strongest LF and the only good signal for text sessions.
- Rule: explicit feedback **overrides** the combiner. `/good` sets
  `succeeded`; `/bad` sets `failed`. Confidence is 1.0 and the label is
  settled immediately. Later delayed evidence is still appended to `votes` and
  `history`, so a `/good` session whose commit is later reverted remains
  visible as a disagreement (useful for measuring how often Griffin's
  in-the-moment verdict is wrong).
- Rated sessions double as free gold-set labels, which shrinks the M1
  hand-labelling burden over time.
- It is never prompted for automatically; no nagging at session end.

## Linkage hardening (optional, additive)

Not needed for v1, since preview recovery already covers ~94% of commits:

- Add `sessionId` to `.afk-worktree-meta.json`
  (`src/agent/tools/handlers/worktree-managed.ts:149-163`).
- `AFK_SESSION_ID` is already exported to hook children
  (`src/agent/hooks/command-executor.ts:171`), so a future commit-trailer hook
  could stamp `AFK-Session: <id>`.

## File layout (fits the 350-line ceiling)

```
src/agent/outcomes/
  schema.ts                 # Zod VerifiedOutcome
  store.ts                  # read/write via paths.ts helper, atomic
  artifacts.ts              # SHA / PR-url recovery from result previews
  lf-immediate.ts           # closure, error_tail, verification, correction, self_report
  lf-delayed.ts             # pr_fate, commit_survival, fix_of_fix, ci, reask
  combine.ts                # v1 rules + confidence
  session-end-hook.ts       # immediate pass, registered beside the facet hook
  relabel-job.ts            # delayed pass, invoked by a daemon shell task
  index.ts
scripts/outcomes-backfill.ts  # M0 offline pass over existing history
```

## M0 results (2026-09-27)

Script: `scripts/outcomes-backfill.ts`. Aggregate report:
`docs/proposals/verified-outcome-m0-report.md`. Input: all 1,001 session JSON
files (see finding 4 for why only 1,001).

| Label | Count |
|---|---|
| succeeded | 259 (26%) |
| failed | 5 (0.5%) |
| blocked | 8 |
| interrupted | 0 (closure LF not joined in M0) |
| unknown | 729 (73%) |

**Exit check: FAIL** (272 non-unknown against a bar of 300). The count is not
the real problem, though.

### Findings

1. **The label can confirm success but cannot detect failure.** 229 of the
   259 successes rest on `pr_fate` (merged) or `commit_survival`. Across all
   1,001 sessions the only negative evidence is 8 PRs closed unmerged and 32
   weak in-session corrections; `commit_survival` found 0 reverts and
   `error_tail` fired 0 times (sessions end on an assistant turn after
   recovering from errors). 605 sessions ended with a `**Done**` block and
   have no evidence either way. A 259:5 label cannot train or validate a
   router: the devils-advocate falsifier required at least 200 minority-class
   examples.
2. **Two precision bugs were caught and fixed during review**, each of which
   had inflated `succeeded`:
   - PR attribution scanned every tool result and all assistant prose, so any
     PR merely *mentioned* (via `gh pr view`, lists, links) was scored as the
     session's own. Now only `gh pr create` events count
     (`isPRCreateEvent`). PR-bearing sessions: 457 → 206.
   - `verification` trusted the exit status of piped commands. 1,591 of 2,196
     stored test/lint/build commands are piped (`pnpm test 2>&1 | tail -5`) or
     masked, so `isError` reflected `tail`, not the tests. Now these abstain,
     as do truncated inputs and events with no recorded `isError`.
     `verification`-only successes: 168 → 24.
   Before the fixes the run reported 523 successes and a PASS.
3. **Self-reports are unreliable as success evidence, as designed.** 84% of
   sessions report Done; 72% of those have no corroborating evidence.
4. **Session JSON is retained for only 30 days / 1,000 files**
   (`src/agent/session-sidecar-sweep.ts`, `AFK_SESSION_MAX_AGE_DAYS`,
   `AFK_SESSION_MAX_COUNT`). The 16k older session directories hold only
   `events.jsonl`. So M2's teardown hook must copy artifacts and immediate
   votes into the outcome store; delayed probes must never depend on the
   session JSON still existing. An events.jsonl reader could extend the
   backfill to the older history (follow-up).

### History extension (2026-09-28)

Implemented an `events.jsonl` reader (`scripts/outcomes-backfill-events.ts`)
that maps the per-session event stream into the same `Turn[]` shape the
immediate LFs consume. Key measurement results before implementation:

| Signal | Events-only sessions | Recovery rate |
|---|---|---|
| `cwd` (from `meta` record) | 16,248 / 16,248 | 100% |
| Git commit SHA (from `tool_result` content) | 336 | 2% |
| PR URL from `gh pr create` (from `tool_result`) | 121 | 0.7% |
| `closed.reason=abort` (closure LF) | 175 | 1% |
| Self-report Done/Blocked (from `assistant` records) | 2,388 / 63 | ~15% |
| Facet coverage (yield_tracking / commits) | 3,556 (22%) | 0 with pr_url or commits |

**Strategies chosen:**
- **SHA/PR recovery**: `tool_result` records carry the actual command output
  (not a 90-char truncated preview), so the same regex patterns work verbatim.
  Facets were rejected — none of the 3,556 facets covering events sessions
  carry `pr_url` or `world_changes.commits`.
- **Commit subject matching**: rejected. Only 36% of commits use `-m "..."`;
  `-F file` (31%) and heredocs (25%) make the subject invisible in inputs, and
  `git log --grep` matching on truncated subjects would cause false attributions.
- **PR branch matching (`gh pr create --head`)**: rejected. `--head` is never
  visible in the sampled inputs; the bare `--title` is present in 87% but is
  not unique enough for safe matching.
- **Closure LF**: events `closed.reason=abort` gives a direct closure signal,
  so events-only sessions get closure LF coverage that JSON-sidecar sessions
  lack in M0.

**New distribution** (16,255 total sessions; `--source all`):

| Label | Count | % |
|---|---|---|
| succeeded | 270 | 2% |
| failed | 18 | 0.1% |
| interrupted | 166 | 1% |
| blocked | 63 | 0.4% |
| unknown | 15,738 | 97% |

**Per-source breakdown:**

| Source | Sessions | succeeded | failed | interrupted | blocked | unknown |
|---|---|---|---|---|---|---|
| json (M0) | 1,000 | 258 | 5 | 0 | 8 | 729 |
| events (new) | 15,255 | 12 | 13 | 166 | 55 | 15,009 |

**Exit check: PASS** (517 non-unknown, up from 272). The 166 new `interrupted`
labels come entirely from the `closure` LF fired on `closed.reason=abort`
events. The `failed` count is 18 (was 5) — still far below the 200 required
for the router experiment. The primary blocker remains: explicit feedback
(`/good`, `/bad`) is the only viable path to 200 `failed` labels. The events
history adds 13 new `failed` from `error_tail` (3+ consecutive tool errors at
session end) and `in_session_correction`, but scaling to 200 via bulk history
alone is not feasible given the 97% `unknown` rate.

### What this changes in M2 (re-prioritised)

Negative evidence is now the critical path. Build these before anything that
consumes the label:

1. **Explicit feedback (`/good`, `/bad`, Telegram reaction).** It is the only
   cheap, high-precision source of `failed`.
2. **Record the tail of verification output.** For bash commands matching the
   verification patterns, store the last ~200 characters of output (where
   `Tests N passed | M failed` and `Found N errors` summaries live), not just
   the first ~90. This recovers pass/fail even for piped commands, which are
   72% of test runs.
3. **`cross_session_reask`** and the **closure join** (trivial at teardown,
   where the trace label is known).
4. Only then the store, the relabel job, and the `get_facet` join.

The router experiment (M3) stays blocked until the label has at least 200
`failed` examples.

## Milestones

| | What | Cost | Exit criterion |
|---|---|---|---|
| **M0** | `scripts/outcomes-backfill.ts`: run immediate LFs and a one-off delayed pass over all ~17k existing sessions. Report the label distribution and per-LF coverage. No schema or runtime change. | $0, local | Distribution report exists; at least a few hundred non-`unknown` labels, otherwise rethink the LFs |
| **M1** | Hand-label 200 sessions; compute per-LF precision. | ~1-2 h of Griffin | v1 precision ≥ 0.85 on held-out |
| **M2** | Store, teardown hook, nightly relabel job, `get_facet` join. | 1 PR | Tests pass; new sessions get labels |
| **M3** | Point consumers at it: the router experiment, `/whatif` judge calibration (compare judge P(yes) with settled labels), fragility-audit. | per consumer | Router falsifier from the research can now be evaluated honestly |

## Known limits

- **Coverage will be low.** Only ~16% of sessions commit and ~5% open PRs. Text
  sessions will mostly be `unknown` unless explicit feedback is added.
- **Merged is not the same as good.** Research shows only ~36% of rejected
  agent PRs are real agent failures, and ~15% of merged ones needed human fixes
  (arXiv 2605.22534). For a single operator who merges his own PRs, `pr_fate`
  partly measures Griffin's patience; `commit_survival` and `fix_of_fix`
  counterweight it.
- **Goodhart.** Once this label is a reward, an agent could learn to avoid
  opening PRs (fewer ways to fail). `unknown` being non-negative limits this,
  but any optimizer that consumes the label must treat `unknown` as
  missing data, not as a zero.
- **Subagent attribution.** Open question: do forked children's tool events
  land in the parent session's `toolEvents`? If not, commits made by
  worktree-isolated children are invisible to `artifacts`.

## Resolved decisions (operator, 2026-09-27)

1. **A PR that merged but needed a follow-up fix is a success.** `fix_of_fix`
   is a weak -1 that lowers confidence; it can never flip `succeeded` to
   `failed` on its own.
2. **Explicit feedback is in.** See "Explicit feedback" above.
3. **Survival window: 7 days** (delegated to the agent). Rationale: it matches
   the existing `FIX_OF_FIX_WINDOW_DAYS = 7`, so one settle clock drives every
   delayed LF; this repo ships releases several times a day, so reverts and
   fix-ups land well inside a week; and a longer window mostly measures
   unrelated later rewrites rather than whether the session's work was right.
   Revisit if M1 shows reverts arriving after day 7.
4. `unknown` sessions are excluded from the router experiment (treated as
   missing data, never as zero).
