/**
 * Best-effort "open the forked session in a new terminal tab".
 *
 * This is the fragile, environment-specific enhancement layer on top of the
 * always-succeeds session fork. `trySpawnTab` NEVER throws and NEVER blocks the
 * REPL: it detects the terminal, plans a fast-returning client command, runs it
 * with a hard timeout, and reports a structured outcome. Any failure path
 * (unknown terminal, missing binary, non-zero exit, timeout, dev entrypoint)
 * resolves to `{ spawned: false, … }` so the caller falls back to printing the
 * resume command — the spawn can never produce a false success.
 */

import { spawnSync } from 'node:child_process';
import { detectTerminal, type SpawnCapability, type TerminalKind } from './detect.js';
import { planSpawn, resolveResumeInvocation } from './spawners.js';
import type { AgentModelInput } from '../../agent/types.js';

const SPAWN_TIMEOUT_MS = 5000;

export interface SpawnOutcome {
  spawned: boolean;
  kind: TerminalKind;
  capability: SpawnCapability;
  /** Why the spawn did not happen (absent on success). */
  reason?: string;
}

/** Injectable spawn for tests — mirrors the slice of spawnSync we use. */
export type RunFn = (
  cmd: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => { status: number | null; error?: Error };

const defaultRun: RunFn = (cmd, args, options) => {
  const res = spawnSync(cmd, args, options);
  return { status: res.status, ...(res.error ? { error: res.error } : {}) };
};

export interface TrySpawnOptions {
  forkId: string;
  model: AgentModelInput;
  cwd: string;
  /** Whether the caller is the local interactive REPL (vs Telegram/daemon). */
  interactive: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: RunFn;
}

export function trySpawnTab(opts: TrySpawnOptions): SpawnOutcome {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const kind = detectTerminal(env);

  // Surface guard: only auto-spawn for a local interactive REPL. On
  // Telegram/daemon a spawn would target the bot/daemon host, not the user's
  // machine — and could even race two sessions onto one sidecar. Print instead.
  if (!opts.interactive) {
    return { spawned: false, kind, capability: 'none', reason: 'non-interactive-surface' };
  }

  const inv = resolveResumeInvocation(opts.forkId, opts.model, opts.cwd);
  if (!inv.spawnable) {
    return { spawned: false, kind, capability: 'none', reason: 'dev-entrypoint' };
  }

  const plan = planSpawn(kind, inv, platform);
  if (plan.capability === 'none' || !plan.exec) {
    return { spawned: false, kind, capability: plan.capability, reason: 'no-tab-mechanism' };
  }

  try {
    const res = run(plan.exec.cmd, plan.exec.args, { stdio: 'ignore', timeout: SPAWN_TIMEOUT_MS });
    if (res.error || res.status !== 0) {
      const reason = res.error ? res.error.message : `exited ${res.status}`;
      return { spawned: false, kind, capability: plan.capability, reason };
    }
    return { spawned: true, kind, capability: plan.capability };
  } catch (err) {
    return {
      spawned: false,
      kind,
      capability: plan.capability,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export { detectTerminal } from './detect.js';
export type { TerminalKind, SpawnCapability } from './detect.js';
export { planSpawn, resolveResumeInvocation } from './spawners.js';
export type { SpawnPlan, ResumeInvocation } from './spawners.js';
