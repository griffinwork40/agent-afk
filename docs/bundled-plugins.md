# Bundled Plugins

`src/bundled-plugins/awa-bundled/` ships a pinned-hash snapshot of the
skills AFK bundles with the plugin (`src/bundled-plugins/awa-bundled/bundled.test.ts`).
Each bundled `SKILL.md` is snapshotted by SHA-256 in `PINNED_HASHES`; the test
fails on any unauthored edit, forcing the developer to explicitly bump the
hash (and, when an upstream counterpart exists, consider a parallel upstream
PR) rather than silently drifting the bundled copy out from under the pin.
This document holds the hash-pin history entries that grew too long to keep
inline in `bundled.test.ts` per the [long-comment convention](../AFK.md) — the
inline comments summarize and link back here.

## Hash pin history

### `review` hash — #726 / #777

<a id="review-726"></a>

History: hash bumped (#726): Wave 1's per-agent citation requirement no
longer mandates a `git show` re-read at the reviewed ref. `research-agent`
has no shell, so that clause forced every Wave 1 agent to nest a
`git-investigator` purely to run one command — doubling the concurrency of
a declared 2-agent wave and cascading into 429s. Ref-anchored verification
is now centralized: Wave 1.5 runs INLINE in the orchestrator (which already
holds the read-only shell it needs) instead of as a fourth sub-agent,
absence-claim grounding uses the shell-free `Grep` tool, and a "Concurrency
floor" block documents the real budget (peak 2 concurrent, 3 dispatched,
zero nesting) so the regression cannot be reintroduced silently — now
guarded by an assertion, not just this comment (see 'review Wave 1 keeps
the no-git citation contract' below). Re-bumped after review feedback on
PR #777: the concurrency floor now states its conditional post-synthesis
budget and bounds the shadow-verify wave, Wave 1.5 Check A verifies
`file-state` citations at EVERY severity (not just blocking/critical/high,
which left medium-and-lower citations permanently unverified), and the
research-agent `tools:` quote is now exact. Re-bumped again after the #777
review: the api-compat reachability pre-check sat inside the Wave 1 slice
still saying "grep production source files", the one shell-implying verb the
rest of this change removed, and Check B verified absence claims only at
blocking/critical/high — the same severity-scope gap Check A had just closed.

Re-bumped again (#937): severity and disposition are now **separate axes**.
`severity` answers "how bad is this defect", `blocking` answers "does this
prevent merge"; the old rubric welded them, defining `high` by impact
("wrong output under reachable conditions") but `medium` by category
("missing edge case, perf degraded under load, deprecated API"), so
blocking on tier alone made "you used a deprecated API" a hard merge
blocker. The rubric is now single-axis (impact), hygiene re-homes to
`low`, and every finding carries an explicit `blocking: true|false` from a
default table with per-finding overrides that each need a one-clause
justification. Two medium classes are never overridable: the `security`
dimension, and material data-integrity risk / likely production failure
under normal usage. Reviewed by /review, which found the first cut
incomplete in three ways, all fixed here: (1) the two pre-existing
severity-downgrade rules (low confidence, Wave 1.5 `diff-only`) fed
straight into the blocking default, so a security `medium` could reach
`blocking: false` with no override and no justification — an "Invariant —
assignment order" block now pins `blocking` to the pre-downgrade severity;
(2) neither wave's dispatch contract transmitted the blocking table and no
actor was named for the mapping, so Wave 1 was told to emit a field whose
rules it never received — Wave 1 is now the named assigner and the table
is in its `receives` list; (3) the shadow-verify trigger still keyed on
tier while the gate keyed on `blocking`, leaving the newly-introduced
waiver as the only pipeline decision with no independent reader —
overridden findings are now routed to /shadow-verify, and the 3-claim
concurrency bound is prioritised waiver-first because an unreviewed
waiver removes a blocker while an unreviewed `critical` still blocks. The
two never-overridable clauses and the ordering invariant are now guarded
by a substring assertion, not the file hash alone (see 'review keeps the
severity/disposition split' below).

Re-bumped once more after /review of PR #936 itself, which found the
assignment-order invariant under-scoped in two ways. First, it enumerated
only two downgrade paths (confidence, Wave 1.5 `diff-only`) while the file
has six; the three unnamed ones include the api-compat reachability rule,
which drops a finding **two tiers in one step** (`medium` → `nit`) and so
was not even described by the invariant's "downgraded a tier" wording. The
invariant now covers every downgrade rule in the file explicitly. Second,
preserving `blocking: true` across a downgrade collided head-on with the
override rule that permits `blocking: true` on a `low`/`nit` only for a
stated external constraint: every downgraded `medium` landed as a
`low`/`nit` carrying `blocking: true` with no admissible justification to
write, forcing the reviewer to fabricate an external constraint or emit a
schema-violating finding. A downgrade-preserved disposition is now
explicitly *not* an override — it records `· blocking preserved from
pre-downgrade <severity>` and is exempt from that rule. The same review
also found Wave 2's `receives` list still omitted the merge-decision rule
it is the actor for, the exact gap that had just been closed for Wave 1's
blocking table; it is now listed.

That review additionally caught a consumer-side effect of the schema
change that lives outside this file: `summarizeForTelegram`
(`src/cli/slash/_lib/review-post.ts`) keyed its high-signal-line filter on
the bare word `blocking`, and the new schema puts `blocking:(true|false)`
on *every* finding line — so the filter matched 100% of findings and the
8-line push cap filled with nits. It now matches `blocking: true` only.

The bundled copy is the SOLE copy of /review: upstream deleted its own
review skill on 2026-07-24 (ce27e45), a deliberate dedup of a skill that
only ever shadowed this one. So #726 had nothing to back-port. The defect
CLASS was ported to the one place it still lived upstream: /weekly-reflect
dispatched two shell-mandating survey waves as `research-agent` (upstream
PR #77; all 40 upstream SKILL.md scanned, no other instance).

### `shadow-verify` hash — #52 / #187

<a id="shadow-verify-52"></a>

Hash bumped 2026-06-09 (PR #52): records the confidence-trigger enhancement
landed in this branch's commit 1e35850 — adds high-confidence language
("confident", "certain", "clearly", ≥80%) as a verification trigger in its
own right, a three-way CONFIRMED/REFUTED/UNVERIFIABLE verdict with
[was: …]/[needs-human-review] annotations, and a bounded 3-round retry loop.
The behavior change is intentional; this records the new content.
Hash re-bumped during PR #52 review: the frontmatter description used YAML
escape sequences that parseSkillMetadata (tool-injector.ts) renders
literally — replaced with a literal ≥ and unquoted terms so the
model-facing description is clean.
Hash re-bumped during PR #187 review: the Merge section now enumerates the
new UNVERIFIED-COMPOSITION / UNVERIFIED-ECHO-CHAMBER verdict states — prose-
consistency fix only; no behavior change to the composition-axis guard.
Hash re-bumped: ported the private-plugin refinements — the Merge section
now frames UNVERIFIED-COMPOSITION / UNVERIFIED-ECHO-CHAMBER as produced by
the Composition-axis guard (not individual verifiers) with the specific
tags [needs-human-review: composition boundary unchecked] / [echo-chamber
suspected]; the guard gains the REFUTED-exemption parenthetical (a refuted
claim already halts action, so its boundary-blindness is safe) and the
echo-chamber loop-cap escalation (UNVERIFIED-ECHO-CHAMBER [loop-cap-reached]
when the 3-round cap is exhausted). Bundled frontmatter/description
preserved verbatim (kept the literal-quote description, NOT the reference's
escaped-quote form).
