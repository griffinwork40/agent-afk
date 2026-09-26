/**
 * Surface-agnostic glue for `afk whatif` and `/whatif`.
 *
 * Exports two functions consumed by both surfaces:
 *
 *   - {@link resolveSpec} — turn parsed args into a `ChangeSpec`.
 *   - {@link buildWhatifDeps} — wire `WhatifDeps` from a token + options.
 *
 * The recursion guard (`isWhatifEpisode()`) is enforced here so neither
 * surface needs to know about it.
 *
 * @module whatif/surface
 */

import { readdirSync } from 'node:fs';
import { isWhatifEpisode } from '../agent/whatif-episode-gate.js';
import { createAnthropicComplete } from './complete.js';
import { createAfkRunner } from './runner/afk-runner.js';
import { resolveJudge } from './judge/index.js';
import { connectJev } from './judge/jev-connect.js';
import { createClaudeJudge } from './judge/claude.js';
import { compileChangeSpec } from './compile.js';
import { describeChange } from './operators/index.js';
import { loadSpecFile } from './args.js';
import type { ParsedWhatifArgs } from './args.js';
import type { ChangeSpec, CompleteFn, WhatifDeps, WhatifProgress } from './types.js';

// ---------------------------------------------------------------------------
// resolveSpec
// ---------------------------------------------------------------------------

export interface ResolveSpecDeps {
  complete: CompleteFn;
  analystModel: string;
  realHome: string;
  /** Names of user skills (dir names under <realHome>/skills). */
  skills: string[];
  /** Names of user plugins. */
  plugins: string[];
}

/**
 * Resolve parsed args to a `ChangeSpec`, compiling plain-English text when
 * needed.
 *
 * Throws on unresolvable specs (`UNRESOLVED:` prefix from the compiler),
 * bad spec files, or missing inputs.
 */
export async function resolveSpec(
  parsed: ParsedWhatifArgs,
  deps: ResolveSpecDeps,
): Promise<ChangeSpec> {
  const { complete, analystModel, skills, plugins } = deps;

  // Spec file takes priority.
  if (parsed.specFile) {
    return loadSpecFile(parsed.specFile);
  }

  // Explicit flag changes: assemble a spec directly.
  if (parsed.flagChanges.length > 0 && !parsed.text) {
    const title = parsed.flagChanges.map((c) => describeChange(c)).join('; ');
    return { title: title.slice(0, 120), changes: parsed.flagChanges };
  }

  // Plain-English text: compile to a ChangeSpec.
  if (parsed.text) {
    const spec = await compileChangeSpec(
      parsed.text,
      complete,
      analystModel,
      { skills, plugins },
    );

    if (spec.title.startsWith('UNRESOLVED:')) {
      throw new Error(
        `whatif: cannot resolve the requested change: ${spec.title}\n` +
          `The compiler could not map your description to a concrete change.\n` +
          `Try being more specific or use explicit flags (--append, --model, etc.).`,
      );
    }

    // Merge any flag changes too (flag changes come before compiled changes).
    if (parsed.flagChanges.length > 0) {
      return {
        title: spec.title,
        changes: [...parsed.flagChanges, ...spec.changes],
      };
    }

    return spec;
  }

  throw new Error('whatif: no change to predict — provide text, flags, or --spec');
}

// ---------------------------------------------------------------------------
// buildWhatifDeps
// ---------------------------------------------------------------------------

export interface BuildWhatifDepsOptions {
  token: string;
  analystModel: string;
  onProgress?: (p: WhatifProgress) => void;
  signal?: AbortSignal;
}

/**
 * Wire `WhatifDeps` from a token and options.
 *
 * Enforces the recursion guard: throws if the process is already a
 * what-if episode (`AFK_WHATIF_EPISODE=1`).
 */
export function buildWhatifDeps(opts: BuildWhatifDepsOptions): WhatifDeps {
  if (isWhatifEpisode()) {
    throw new Error(
      'whatif cannot run inside a what-if episode — recursion guard active (AFK_WHATIF_EPISODE=1).',
    );
  }

  const { token, analystModel, onProgress, signal } = opts;
  const complete = createAnthropicComplete(token);
  const runner = createAfkRunner();

  const makeJudge: WhatifDeps['makeJudge'] = (choice) =>
    resolveJudge(choice, { complete, model: analystModel, connectJev });

  const makeCrossCheckJudge: WhatifDeps['makeCrossCheckJudge'] = async () =>
    createClaudeJudge(complete, analystModel);

  return { runner, complete, makeJudge, makeCrossCheckJudge, onProgress, signal };
}

// ---------------------------------------------------------------------------
// Skill/plugin discovery helper
// ---------------------------------------------------------------------------

/**
 * Read skill names from a skills directory (subdirectory names).
 * Returns an empty array when the directory does not exist.
 */
export function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
