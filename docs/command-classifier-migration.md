# Shared command classification: migration substrate (#3846)

This is a **bounded partial**, not completion of #3846. It changes ownership and
reuse, not command approval policy. The initial verified HEAD and required base
were `d97a3747d320eb3d927ca22ab9bad9ba4c8554d1` (ancestry checked before edits).

## What is shared now

`src/agent/command-classifier.ts` exposes `analyzeCommand(command)`, a lazy,
per-command object with:

- `segments`: the existing best-effort tokenizer's raw command view;
- `mutation` / `readOnly`: the existing four-pass mutation heuristic;
- `risk`: the existing approval tier, reason, and category;
- `destructive` / `releaseBoundary`: ordered pattern records, retaining stable
  IDs, observe/block tiers, and block reasons.

Each facet is computed at most once per analysis. Identical tokenizer input views
share one parse. Approval matching removes neutral redirects before tokenizing;
that distinct view must **not** replace the raw mutation view. Hook data masking
also retains its two existing, deliberately different modes. There is no global
command cache, command execution, new filesystem policy, or persisted command data.

Risk classification, the read-only compatibility API, and both destructive/release
detectors delegate to this entry. `wait_for` explicitly shares one analysis across
its risk and mutation checks, while retaining its stricter syntax and argv gates
and polling-only builtin supplement. Other existing consumers use the compatibility
APIs, so their public signatures and behavior remain unchanged.

The old read-only implementation lives in `tools/readonly-bash.mutation.ts`; the
approval tables live in `command-classifier.risk.ts`. These are internal concern
modules, not independent consumer entry points. The original mutation guard from
#4032 is reused, not added again. Pattern-table IDs/reasons/tiers are unchanged.

## Safety contract

These facets answer **different questions**, not interchangeable booleans:

- `git push origin main`: medium approval risk and a known mutation.
- `git log --grep="git push" --oneline`: medium approval risk (a retained raw
  substring false positive) but no known mutation.
- An unknown executable: medium risk, yet no known mutation under the existing
  default-allow heuristic. `readOnly: true` is **not proof** it is read-only.
- A release pattern still needs hook-owned dry-run handling. A destructive pattern
  still needs hook-owned worktree-scoped stash demotion and per-call cwd precedence.

Do not use `readOnly` to bypass polling checks, authorize paths, or claim OS-level
containment. Command strings remain best-effort defense in depth, not a sandbox.
No piped Python/JSON allowance or quoted-data relaxation is introduced here.

## Regression evidence

Before any production swap, `command-classifier.golden.test.ts` captured 129
baseline command receipts. The committed snapshot pins exact risk levels/reasons/
categories, mutation verdicts/reasons, ordered IDs, root/worktree/override hook
verdicts, and release dry-run handling. It includes real destructive/release forms,
near misses, compound precedence, quoted data, executable substitutions, interpreter
payloads, wrappers, heredocs, and the quoted curl method from the issue comment.
Existing #4287 cross-classifier pins remain unchanged. Separate sharing tests check
lazy evaluation, reason priority, no global cache, and raw/normalized view isolation.

## Exact remaining scope before closing #3846

1. Replace the legacy approval/mutation/destructive/release recognition tables with
   shared positional rules incrementally, rather than merely sharing entry and
   memoization. Keep golden BLOCK behavior, stable IDs/reasons, tier calibration,
   and conservative interpreter/heredoc handling unless separately justified.
2. Resolve the pinned quoted-data false positives and default-unknown differences
   with explicit policy decisions and discriminating regression tests. Do not turn
   every mutation into high risk: risk and read-only policy are separate axes.
3. Add sound network-egress and write-path facets with explicit unknown states;
   these are **not implemented** and must not be inferred from `readOnly`.
4. Consolidate remaining token/offset/masking views where semantically equivalent;
   retain separate views when normalization changes security meaning. Share across
   independent hooks only with a bounded call-owned lifetime, never global strings.
5. Evaluate any `python3 -m json.tool` exception independently; the current piped
   interpreter block and safer `jq` guidance remain unchanged.

OS sandboxing (#3845) and path-policy consolidation (#3847) are separate proposals.
This change neither implements nor weakens those boundaries.
