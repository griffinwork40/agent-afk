/**
 * Snapshot path normalization.
 *
 * Invariant: baseline and candidate run from different sandbox directories,
 * and the runtime echoes those paths into the prompt (e.g. the "Personal
 * configuration (<path>/AFK.md)" header, the Environment block). Left alone,
 * every structural diff would report those path lines as changes. Rewriting
 * each sandbox path back to the real path it stands in for makes the diff show
 * only what the change itself altered, and shows the user the paths they know.
 *
 * @module whatif/structural.normalize
 */

import type { Environment, RequestSnapshot } from './types.js';

function replaceAll(text: string, from: string, to: string): string {
  return from.length === 0 || from === to ? text : text.split(from).join(to);
}

/** Rewrite sandbox home/cwd paths in a snapshot to the real paths. */
export function normalizeSnapshot(
  snap: RequestSnapshot,
  env: Environment,
  real: { home: string; cwd: string },
): RequestSnapshot {
  // Longest first: the sandbox cwd can live inside the sandbox home's run dir.
  const pairs: [string, string][] = [
    [env.home, real.home],
    [env.cwd, real.cwd],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  const fix = (t: string): string => pairs.reduce((acc, [from, to]) => replaceAll(acc, from, to), t);
  return {
    model: snap.model,
    system: fix(snap.system),
    tools: snap.tools.map((t) => ({ name: t.name, description: fix(t.description) })),
    firstUserMessage: fix(snap.firstUserMessage),
  };
}
