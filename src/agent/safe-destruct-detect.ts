/**
 * Safe-destruct detector — an **observe-only** PreToolUse hook.
 *
 * Migrates the detection half of the `safe-destruct` gate-skill into
 * deterministic harness code (Wave 1 of the friction-substrate / gate-migration
 * program — `.afk/plans/friction-substrate-and-gate-migration.md`). It watches
 * `bash` commands for a curated set of catastrophic / irreversible operations
 * (`rm -rf`, `git reset --hard`, `DROP DATABASE`, `dd of=/dev/*`, `mkfs`,
 * `terraform destroy`, ...) and, on a match, emits a witnessed catch-record —
 * **without blocking the command**.
 *
 * # Why observe-only (the interpreter-eval lesson)
 *
 * This whole program exists because an over-firing PreToolUse *hard block* (the
 * interpreter-eval guard) generated 18 nights of self-inflicted friction. The
 * plan's de-risking rule is therefore "injectContext-first, shadow-window
 * before enforcing". PreToolUse cannot `injectContext` — the harness honors that
 * field only for `SubagentStop` / `UserPromptSubmit` (see `hooks.ts`) — and a
 * hard block would repeat the exact mistake. So slice 1 changes ZERO behavior:
 * it only records that a destructive command was attempted. The records are the
 * shadow window; a later slice uses their real-world frequency per pattern to
 * calibrate which (if any) warrant a block or nudge.
 *
 * # How the catch-record is emitted (the `approve` outcome)
 *
 * A PreToolUse handler can only `block` or pass; passing (`{}`) is not
 * witnessed with a reason. To emit a filterable catch-record while letting the
 * command run, this hook returns the otherwise-unused `decision: 'approve'`
 * outcome with a structured `reason`. `approve`:
 *   - is behaviorally identical to unset — `isBlocking()` (`hook-registry.ts`)
 *     checks only `block` / `continue:false`, so the command proceeds and the
 *     other PreToolUse gates (afk-mode, bash-restriction, ...) still run;
 *   - is recorded by `dispatchPreToolUse` as a `hook_decision` event carrying
 *     the `reason` (`subagent-hooks.ts`), which is the Wave-4 substrate signal;
 *   - is IGNORED by the mechanical friction detectors (they count `block`
 *     outcomes / error `failureClass`es — see `improve/scan/detectors`), so
 *     these observations never masquerade as new friction.
 * No existing hook returns `approve`, so `decision === 'approve'` cleanly
 * isolates safe-destruct observations in the trace.
 *
 * Registered unconditionally on ALL surfaces (including headless/autonomous,
 * where destructive actions are most dangerous and least observed) precisely
 * because it never blocks — it is safe everywhere.
 *
 * @module agent/safe-destruct-detect
 */

import type { HookContext, HookDecision } from './hooks.js';

/**
 * Stable prefix on the emitted `reason`. Exported so the telemetry substrate,
 * tests, and `afk trace show` can match safe-destruct observations by prefix.
 */
export const SAFE_DESTRUCT_DETECT_REASON_PREFIX =
  'safe-destruct observe-only: destructive-command attempt';

/**
 * Curated destructive / irreversible command patterns.
 *
 * Calibration bias: high-signal only. Operations that are catastrophic AND
 * rarely a legitimate agent action. Recursive-only deletes (`rm -r build/`) are
 * deliberately NOT flagged — common and usually safe; only recursive+force
 * (no prompt, no recovery) is. Each regex avoids nested quantifiers so the scan
 * is linear (no ReDoS); `[^|&;\n]*` bounds a match to a single command segment.
 *
 * Reused by the future block/nudge slice — keep it the single source of truth.
 */
const DESTRUCTIVE_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  // --- rm: recursive AND force (irrecoverable, no prompt) ---------------------
  // One flag cluster containing both r and f (`-rf`, `-fr`, `-rfv`, `-Rf`, ...).
  { id: 'rm-recursive-force', re: /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+/i },
  // Recursive and force in separate flag tokens (`rm -r -f`, `rm -f -r`).
  {
    id: 'rm-recursive-force-split',
    re: /\brm\s+-[a-z]*r[a-z]*\s+-[a-z]*f|\brm\s+-[a-z]*f[a-z]*\s+-[a-z]*r/i,
  },
  // Long-form, both flags present in either order.
  {
    id: 'rm-recursive-force-long',
    re: /\brm\s+[^|&;\n]*--recursive\b[^|&;\n]*--force\b|\brm\s+[^|&;\n]*--force\b[^|&;\n]*--recursive\b/i,
  },
  // The explicit "yes, wipe /" escape hatch — always catastrophic.
  { id: 'rm-no-preserve-root', re: /\brm\b[^|&;\n]*--no-preserve-root\b/i },

  // --- git: history / worktree destroyers ------------------------------------
  { id: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/i },
  { id: 'git-clean-force', re: /\bgit\s+clean\s+-[a-z]*f|\bgit\s+clean\s+[^|&;\n]*--force\b/i },
  {
    id: 'git-push-force',
    re: /\bgit\s+push\b[^|&;\n]*--force\b|\bgit\s+push\b[^|&;\n]*(?<![\w-])-f\b/i,
  },
  // Case-sensitive: `-D` force-deletes a branch; `-d` refuses on unmerged.
  { id: 'git-branch-force-delete', re: /\bgit\s+branch\s+[^|&;\n]*-D\b/ },

  // --- filesystem / raw device -----------------------------------------------
  // Writing to a real device node (excludes the harmless pseudo-devices).
  {
    id: 'dd-to-device',
    re: /\bof=\/dev\/(?!null\b|zero\b|random\b|urandom\b|stdout\b|stderr\b|tty\b)\S/i,
  },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/i },
  { id: 'redirect-to-block-device', re: />\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)\w*/i },
  { id: 'find-delete', re: /\bfind\b[^|&;\n]*-delete\b|\bfind\b[^|&;\n]*-exec\s+rm\b/i },
  { id: 'shred', re: /\bshred\b/i },

  // --- SQL --------------------------------------------------------------------
  {
    id: 'sql-drop-truncate-delete',
    re: /\b(drop\s+(table|database|schema|index)\b|truncate\s+table\b|delete\s+from\b)/i,
  },

  // --- infra / containers -----------------------------------------------------
  {
    id: 'docker-destructive',
    re: /\bdocker\s+(system\s+prune|volume\s+(rm|prune)|image\s+prune|container\s+prune|network\s+prune)\b|\bdocker\b[^|&;\n]*\brmi?\s+[^|&;\n]*-f/i,
  },
  { id: 'kubectl-delete', re: /\bkubectl\s+delete\b/i },
  { id: 'terraform-destroy', re: /\bterraform\s+destroy\b/i },
];

/**
 * Return the ids of every destructive pattern the command matches (empty when
 * none). Pure and stateless — no global-flag regexes, so `.test()` is safe to
 * call repeatedly. Exported for the block/nudge slice and for tests.
 */
export function detectDestructiveCommands(command: string): string[] {
  if (!command) return [];
  const hits: string[] = [];
  for (const { id, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) hits.push(id);
  }
  return hits;
}

/**
 * Create the observe-only safe-destruct PreToolUse hook.
 *
 * Stateless (no dedup): every destructive attempt is a distinct data point —
 * an agent looping on `rm -rf x` is exactly the signal the shadow window wants
 * to surface, so occurrences are not collapsed.
 */
export function createSafeDestructDetect(): (context: HookContext) => HookDecision {
  return function safeDestructDetect(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    const matched = detectDestructiveCommands(command);
    if (matched.length === 0) return {};

    // approve == allow (never blocks; see module header) but carries a reason
    // that lands as a `hook_decision` catch-record for the reasoning-failure
    // substrate.
    return {
      decision: 'approve',
      reason: `${SAFE_DESTRUCT_DETECT_REASON_PREFIX} [${matched.join(', ')}]`,
    };
  };
}
