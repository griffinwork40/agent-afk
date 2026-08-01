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
