/**
 * Shared sensitive-root candidate derivation for the bash restriction hook.
 *
 * # Why this module exists (#3847, sensitive-root derivation slice)
 *
 * `deriveRestrictedSubstrings` (interactive, grant-filtered path) and
 * `headlessRestrictedSubstrings` (headless, unfiltered floor) previously
 * assembled the SAME candidate set independently:
 *
 *   deriveRestrictedSubstrings  line 943-950  (bash-restriction-hook.ts)
 *   headlessRestrictedSubstrings line 1034-1042 (bash-restriction-hook.ts)
 *
 * Both produced:
 *   [...new Set([...builtinBashSensitiveRoots(), ...getReadDenylist(),
 *                ...readDenylistExtrasAsSpelled(), ...relocatedAfkSensitiveRoots()])]
 *
 * That duplication was the leftover cited in the #3847 progress doc (§ remaining
 * scope item 1) after slice 3 (PR #5087). Moving the derivation here makes the
 * two functions diverge only in their grant-filter step — which is the
 * deliberate semantic split between interactive and headless surfaces.
 *
 * # What this module does NOT own
 *
 * - Grant filtering (`deriveRestrictedSubstrings` in bash-restriction-hook.ts)
 * - The headless floor path (`headlessRestrictedSubstrings`)
 * - Any block-decision logic
 *
 * # Behaviour-preservation invariant
 *
 * The output of `buildSensitiveRootCandidates()` is identical, element-for-
 * element, to the inlined candidate arrays it replaces. All 49 equivalence
 * tests in `bash-restriction-hook.check2-policy.test.ts` and the 25
 * characterization tests in `bash-restriction-hook.sensitive-roots.test.ts`
 * pin this contract and must pass unchanged before and after any refactor.
 *
 * @module agent/tools/hooks/bash-restriction-hook.policy
 */

import { getReadDenylist, parseReadDenylistEntries } from '../handlers/read-denylist.js';
import { env } from '../../../config/env.js';
import { relocatedAfkSensitiveRoots } from './afk-home-refs.js';
// Invariant: circular-import safety — policy.ts → bash-restriction-hook.ts → policy.ts
//
// This import creates a cycle: bash-restriction-hook.ts imports
// buildSensitiveRootCandidates from this module, and this module imports
// builtinBashSensitiveRoots back from bash-restriction-hook.ts.
//
// The cycle is SAFE today because builtinBashSensitiveRoots is declared as a
// hoisted `function` declaration (not `const` or an arrow function) in
// bash-restriction-hook.ts. Function declarations are hoisted to the top of
// their module scope and are therefore available before the module body
// finishes executing, so the circular reference resolves correctly at runtime.
//
// Hazard: if builtinBashSensitiveRoots is ever refactored from a `function`
// declaration to a `const` or arrow function, it will be subject to the
// Temporal Dead Zone (TDZ). The circular import would then cause the binding
// to read as `undefined` at the moment policy.ts first evaluates, silently
// emptying the credential floor that check-2 depends on — with NO runtime
// error thrown and NO type-system signal.
//
// DO NOT refactor builtinBashSensitiveRoots to `const` or an arrow function
// without first breaking this cycle (e.g. by moving builtinBashSensitiveRoots
// to a third leaf module that neither bash-restriction-hook.ts nor policy.ts
// imports circularly).
import { builtinBashSensitiveRoots } from './bash-restriction-hook.js';

/**
 * The deduplicated union of all sensitive-root candidates consulted by the bash
 * restriction hook's check-2 substring scan.
 *
 * Sources (in precedence order, deduplicated via `Set`):
 *   1. `builtinBashSensitiveRoots()` — bash-only extras plus the typed-tool
 *      credential floor, with `/etc` ↔ `/private/etc` aliases baked in.
 *   2. `getReadDenylist()` — symlink-resolved forms of BUILTIN_READ_DENYLIST
 *      plus any `AFK_READ_DENYLIST` operator overrides (resolved).
 *   3. `readDenylistExtrasAsSpelled()` — the same operator entries as-spelled
 *      (un-resolved), because bash commands name symlinks, not their targets.
 *   4. `relocatedAfkSensitiveRoots()` — non-empty only when `AFK_HOME` is
 *      set outside the default `~/.afk`; ensures a relocated config tree is
 *      covered even when SENSITIVE_PATH_SIGNAL's hardcoded `.afk/config`
 *      fragment does not match the relocated path.
 *
 * Both `deriveRestrictedSubstrings` (interactive) and
 * `headlessRestrictedSubstrings` (headless) start from this same set; they
 * diverge only in whether a grant-filter step is applied afterward.
 *
 * Invariant: pure derivation — no I/O beyond what the imported helpers already
 * do, no singleton state, deterministic for a fixed env/filesystem.
 */
export function buildSensitiveRootCandidates(): string[] {
  return [
    ...new Set([
      ...builtinBashSensitiveRoots(),
      ...getReadDenylist(),
      ...readDenylistExtrasAsSpelled(),
      ...relocatedAfkSensitiveRoots(),
    ]),
  ];
}

/**
 * Operator `AFK_READ_DENYLIST` entries exactly as spelled, to sit alongside the
 * symlink-RESOLVED forms `getReadDenylist()` returns.
 *
 * Extracted here alongside `buildSensitiveRootCandidates` so both callers
 * (`deriveRestrictedSubstrings` and `headlessRestrictedSubstrings`) use the
 * identical derivation without inlining it twice.
 *
 * Invariant: delegates to `parseReadDenylistEntries` from `read-denylist.ts`,
 * NOT a local copy. The two previously drifted: neither expanded a leading `~`,
 * so the tilde-spelled form the docs recommend resolved to a literal `./~/…`
 * and protected nothing on either surface (PR #734 review, MAJOR 1).
 */
function readDenylistExtrasAsSpelled(): string[] {
  return parseReadDenylistEntries(env.AFK_READ_DENYLIST);
}
