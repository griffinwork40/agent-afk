/**
 * Native AFK skill-invocation telemetry writer.
 *
 * Appends one JSONL row per skill dispatch to
 * `$AFK_HOME/agent-framework/skill-invocations.jsonl`, tagged
 * `surface:"afk"` and `source:"native-runtime"` so rows interleave cleanly
 * with plugin-written rows in the same file.
 *
 * Privacy: operational metadata only — skill name, session/trace IDs, cwd,
 * model, and the dispatch command. No prompt content, tool inputs/outputs,
 * model responses, stack traces, or credentials are written here.
 *
 * Three public exports with distinct responsibilities:
 *   - `buildSkillInvocationRow` — pure, no I/O. Construct the row object.
 *   - `appendSkillInvocationTo` — write to an *explicit* dir. No test guard.
 *     Used by both the public writer and by hermetic tests that inject a
 *     temp dir.
 *   - `writeSkillInvocation` — public entry point wired into the executor.
 *     No-ops under tests (VITEST / NODE_ENV=test) to prevent fixture runs
 *     from polluting the real `~/.afk/agent-framework/` stream. Mirrors the
 *     guard in `src/agent/routing-telemetry.ts:104`.
 *
 * @module agent/telemetry/skill-invocation-writer
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { env } from '../../config/env.js';
import { getAgentFrameworkDir } from '../../paths.js';

/** Input shape accepted by the public writer and `buildSkillInvocationRow`. */
export interface SkillInvocationInput {
  skillName: string;
  sessionId?: string | undefined;
  traceId?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
}

/** The persisted JSONL row shape. Optional fields are omitted (never `null`)
 *  when their input counterpart is `undefined`, keeping the log compact. */
export interface SkillInvocationRow {
  ts: string;
  surface: 'afk';
  event: 'skill_invocation';
  skill_name: string;
  source: 'native-runtime';
  session_id?: string;
  trace_id?: string;
  cwd?: string;
  model?: string;
  command?: string;
}

/**
 * Build a `SkillInvocationRow` from the given input.
 *
 * Pure — performs no I/O. Optional fields are included via conditional spread
 * so absent keys are never written as `null` to the JSONL stream.
 */
export function buildSkillInvocationRow(input: SkillInvocationInput): SkillInvocationRow {
  return {
    ts: new Date().toISOString(),
    surface: 'afk',
    event: 'skill_invocation',
    skill_name: input.skillName,
    source: 'native-runtime',
    ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
    ...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
  };
}

/**
 * Write a built row into an explicit `frameworkDir`.
 *
 * No test guard — this function is also called by hermetic tests that inject
 * a temp directory. The public `writeSkillInvocation` applies the guard
 * before calling here.
 *
 * Best-effort: any filesystem error is swallowed so telemetry never breaks
 * dispatch. Uses `appendFileSync` for POSIX `O_APPEND` atomicity (rows are
 * well under PIPE_BUF). Mirrors `routing-telemetry.ts`'s approach.
 */
export function appendSkillInvocationTo(frameworkDir: string, row: SkillInvocationRow): void {
  try {
    mkdirSync(frameworkDir, { recursive: true });
    appendFileSync(join(frameworkDir, 'skill-invocations.jsonl'), JSON.stringify(row) + '\n');
  } catch {
    // Swallow — telemetry failures must never propagate to dispatch callers.
  }
}

/**
 * Public entry point wired into `SkillExecutor`.
 *
 * No-op under Vitest / NODE_ENV=test — fixture dispatches must never pollute
 * the real `~/.afk/agent-framework/skill-invocations.jsonl` stream. This is
 * the same guard used in `src/agent/routing-telemetry.ts:104`.
 *
 * In production, resolves the real framework dir via `getAgentFrameworkDir()`
 * (honours `$AFK_HOME`) and delegates to `appendSkillInvocationTo`.
 */
export function writeSkillInvocation(input: SkillInvocationInput): void {
  // No-op under vitest — fixture dispatches must never pollute the real stream
  // (see routing-telemetry.ts).
  if (env.VITEST || env.NODE_ENV === 'test') return;
  appendSkillInvocationTo(getAgentFrameworkDir(), buildSkillInvocationRow(input));
}
