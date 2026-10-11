/**
 * Reduced-tool-surface detection for SDK (embedding) sessions.
 *
 * When a session is created through the public SDK entry points (`AgentSession`,
 * `query()`, `queryText()`) without executor wiring, the `agent`, `skill`, and
 * `compose` tools are absent from the model's tool list even though the
 * skill-bridge discovers skills and `supportedCommands()` returns them.
 *
 * This module provides:
 *  - {@link resolveSurfaceInputs} — derives real inputs (init metadata is empty).
 *  - {@link isReducedToolSurface} — detects the mismatch at init time.
 *  - {@link emitReducedSurfaceWarning} — emits a one-time warning to stderr
 *    when the gap is present. Silent on CLI/REPL/Telegram/web surfaces that
 *    wire executors (those set `skillExecutor` on `AgentConfig`).
 *
 * The check fires only when skills were actually discovered (i.e.
 * `SessionMetadata.skills` is non-empty) AND no `skillExecutor` is present.
 * An executor-less session with zero discovered skills is a legitimate
 * use-case (no plugins installed) and produces no warning.
 *
 * Set `AFK_SDK_SURFACE_WARN=0` to silence the warning when the reduced
 * surface is intentional (registered via `src/config/env.ts`).
 *
 * @module agent/session/sdk-surface-warning
 */

import { env } from '../../config/env.js';
import { listSkills } from '../../skills/skill-registry.js';
import type { AgentConfig } from '../types.js';
import type { SessionMetadata } from '../types/session-types.js';

/**
 * Contract: build the `{ skills, tools }` input for {@link isReducedToolSurface}
 * from what the session actually knows at init.
 *
 * Both providers emit `session.init` with `skills: []` and `tools: []`
 * (anthropic-direct `query-turn-driver.ts`, openai-compatible `query.ts`), so
 * feeding raw init metadata to the predicate never fires (#3442 follow-up).
 * Instead:
 *  - skills: the init list when non-empty, else the process skill registry
 *    (built-ins register at import, so a bare SDK session has some).
 *  - tools: the init list, plus `'skill'` when the session is known or assumed
 *    to have a skill executor: `config.executors.skillExecutor` is wired, the
 *    caller injected its own `provider`/`providerFactory` (every first-party
 *    surface does, with executors), or the session is a forked child.
 */
export function resolveSurfaceInputs(
  config: Pick<AgentConfig, 'executors' | 'provider' | 'providerFactory' | 'isSubagentFork' | 'parentSessionId'>,
  metadata: Pick<SessionMetadata, 'skills' | 'tools'>,
): { skills: string[]; tools: string[] } {
  const skills =
    metadata.skills !== undefined && metadata.skills.length > 0
      ? [...metadata.skills]
      : listSkills();
  const tools = [...(metadata.tools ?? [])];
  const skillWired =
    config.executors?.skillExecutor !== undefined ||
    config.provider !== undefined ||
    config.providerFactory !== undefined ||
    config.isSubagentFork === true ||
    config.parentSessionId !== undefined;
  if (skillWired && !tools.includes('skill')) tools.push('skill');
  return { skills, tools };
}

// Invariant: one stderr line per PROCESS. Embedders that build a session per
// request (Next.js routes, servers) must not get one line each.
let reducedSurfaceWarned = false;

/**
 * First-turn hook: write the reduced-surface warning once per process, only
 * when a session actually runs a model turn. Construction/init alone stays
 * silent so probe sessions (e.g. `afk status`) never print it; the
 * `SessionMetadata.reducedToolSurface` flag is still stamped at init.
 */
export function warnReducedSurfaceOnTurn(
  config: Parameters<typeof resolveSurfaceInputs>[0],
): void {
  if (reducedSurfaceWarned) return;
  const inputs = resolveSurfaceInputs(config, { skills: [], tools: [] });
  if (!isReducedToolSurface(inputs)) return;
  reducedSurfaceWarned = true;
  emitReducedSurfaceWarning(inputs);
}

/** @internal Test-only reset of the once-per-process guard. */
export function resetReducedSurfaceWarningForTests(): void {
  reducedSurfaceWarned = false;
}

/**
 * Returns `true` when skills have been discovered for this session but the
 * `skill` tool is not in the registered tool list — meaning the model cannot
 * invoke any skill even though the skill-bridge lists them.
 *
 * The check uses `SessionMetadata.tools` (populated from `session.init`) as the
 * ground truth: if `"skill"` is absent from the tools list, the executor was
 * never wired regardless of how the provider was constructed. This avoids
 * coupling the detection to `AnthropicDirectProviderOptions.skillExecutor`,
 * which is provider-specific and not on `AgentConfig`.
 */
export function isReducedToolSurface(
  metadata: Pick<SessionMetadata, 'skills' | 'tools'>,
): boolean {
  const hasSkills = Array.isArray(metadata.skills) && metadata.skills.length > 0;
  const hasSkillTool =
    Array.isArray(metadata.tools) && metadata.tools.includes('skill');
  return hasSkills && !hasSkillTool;
}

/**
 * Emits a one-time warning to stderr when skills are discovered but the
 * `skill` tool is absent from the session's registered tool list.
 *
 * Uses `process.stderr.write` (matching the project's convention for agent-
 * layer one-time warnings, e.g. `src/agent/journal/append-queue.ts`) so the
 * message is not buffered by test runners that capture `console`.
 *
 * Suppressed when `AFK_SDK_SURFACE_WARN=0` (read via the typed `env` object).
 * Does nothing when {@link isReducedToolSurface} returns `false`.
 */
export function emitReducedSurfaceWarning(
  metadata: Pick<SessionMetadata, 'skills' | 'tools'>,
): void {
  if (!isReducedToolSurface(metadata)) return;
  if (env.AFK_SDK_SURFACE_WARN === '0') return;
  const count = (metadata.skills ?? []).length;
  process.stderr.write(
    `[agent-afk] SDK session: ${count} skill${count === 1 ? '' : 's'} discovered but ` +
      `the "skill", "agent", and "compose" tools are NOT registered. ` +
      `Skills are listed by supportedCommands() but the model cannot invoke them. ` +
      `This is expected when using AgentSession / query() / queryText() directly ` +
      `without executor wiring. Opt in with AgentConfig.executors from createWiredExecutors(); ` +
      `see docs/sdk-surface.md. ` +
      `Set AFK_SDK_SURFACE_WARN=0 to silence this warning.\n`,
  );
}
