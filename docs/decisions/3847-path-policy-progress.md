# #3847 — shared path policy, second incremental slice

## Verified base and scope

Base / starting HEAD: `d97a3747d320eb3d927ca22ab9bad9ba4c8554d1`.
The base is an ancestor of this proposal. #4036 already introduced the shared
read credential floor. This change extends that implementation rather than
recreating it. It is a **partial proposal**, not closure of #3847.

## Shipped in this slice

- `decidePathAccess(path, op, actorScope, fallbackBase)` now decides the read or
  write credential floor **before** actor-root containment. Denials distinguish
  `credential` from `roots` and carry the anchored absolute path.
- `resolveAndContain`, path approval, and patch validation consume that decision.
  Protected writes never prompt for grants that the write handler would reject.
  Patch validation retains `write_denied` versus `path_containment` error codes.
- Root containment lives in `path-policy.roots.ts`. The existing
  `wouldBeRestricted` adapter, including bash's extracted-path advisory caller,
  uses that same root decision. Its result is intentionally **roots-only**.
- Plain and native write-floor canonical forms remain separate, preserving the
  Windows 8.3 long-name guard. Read carve-outs remain exact-file exceptions;
  operator read-denylist entries still outrank them. No write carve-outs exist.
- Undefined resolve base remains unconfined; an explicitly empty roots array
  with a concrete base remains deny-all except for write-only scratch. Scratch
  cannot override the credential floor. Existing symlink/dangling-target
  revalidation and live write-denylist resolution remain in place.

## Independent review and verification

A separate security reviewer read the diff and the new policy modules, ran
scoped tests, and approved with no blocking bypass or regression found. Review
notes: retain the redundant write-handler floor checks during incremental
migration, and document the advisory's deliberately floor-free contract.
Existing patch validation tests cover both structured denial codes; the native
canonical-spelling test also exercises `decidePathAccess` directly.

Verified locally: handler suite, hook suite (including Windows-spelling bash
goldens), file-checkpoint suite, AFK-mode gate, cross-classifier goldens,
subagent root validation, live bypass toggling, POSIX guard, `pnpm lint`,
`pnpm build`, test-typecheck ratchet, and all 16 `check:audits` gates. No baseline
files were increased and all source files remain below 350 code lines.

## Exact remaining scope (keep issue open)

1. Migrate the bash **hard restriction hook's** lexical extraction, sensitive
   root derivation, interactive grants and headless carve-out semantics to the
   policy incrementally. Do not replace its heuristics with the incomplete
   advisory token scan: that would drop protections for interpreter-assembled,
   embedded, variable and Windows spellings.
2. Migrate the AFK-mode gate's workspace-escape decisions only after equivalence
   tests pin its distinct risk/approval semantics.
3. Consolidate remaining duplicate handler floor checks and resolution calls
   after their error attribution and dangling-write-target contracts are pinned.
   This slice does not claim a single filesystem syscall per path: plain and
   native forms are both required, and fresh target revalidation is deliberate.
4. Reconcile denial-circuit-breaker integration and consistent safer-alternative
   metadata without changing stable denial markers used by telemetry.

No concurrent sandbox (#3845) or command-classifier (#3846) integration is
included. Bash advisories remain non-blocking under ADR 0001. String checks and
check-before-open are not an adversarial OS security boundary; this change does
not claim to fix shell indirection or filesystem races.
