/**
 * One-time deprecation notice for `AFK_CAPTURE_SUBAGENT_PROMPTS` and
 * `AFK_CAPTURE_SUBAGENT_OUTPUT`, retired in favour of subagent message
 * journals (`sessions/<id>/subagents/<subagentId>.jsonl`, #2460).
 *
 * Reads via `isEnvVarSet` from `env-helpers.ts` (the sanctioned dynamic
 * `process.env` read-point inside `src/config/`), so the audit-env-access
 * gate passes cleanly.
 *
 * Design choice (#2460): a standalone startup-check is preferred over adding
 * registry entries whose only purpose is to side-effect on first access.
 * Registry entries are for vars that the codebase READS; these two have no
 * remaining consumers. The env.ts conventions (registry = live vars) make
 * stub-only entries awkward; a function in a separate file avoids the smell.
 *
 * @module config/deprecated-capture-flags
 */

import { isEnvVarSet } from './env-helpers.js';

let _warned = false;

/**
 * Emit a one-time stderr notice when the operator still has either retired
 * capture flag in their environment. Call once at process start from CLI
 * entry points.
 */
export function warnDeprecatedCaptureFlags(): void {
  if (_warned) return;
  const promptsSet = isEnvVarSet('AFK_CAPTURE_SUBAGENT_PROMPTS');
  const outputSet = isEnvVarSet('AFK_CAPTURE_SUBAGENT_OUTPUT');
  if (!promptsSet && !outputSet) return;
  _warned = true;
  const names = [
    ...(promptsSet ? ['AFK_CAPTURE_SUBAGENT_PROMPTS'] : []),
    ...(outputSet ? ['AFK_CAPTURE_SUBAGENT_OUTPUT'] : []),
  ].join(', ');
  try {
    process.stderr.write(
      `[afk] DEPRECATED: ${names} — these capture flags have been retired (#2460).\n` +
      `      Subagent journals now record the same data at sessions/<id>/subagents/<subagentId>.jsonl.\n` +
      `      Use \`afk trace show\` or read those files directly; the old flags are no-ops.\n`,
    );
  } catch {
    // stderr may be closed in some test environments.
  }
}
