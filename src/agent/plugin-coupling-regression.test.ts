/**
 * Regression guard: optional-plugin couplings stay out of core.
 *
 * Invariant: the /forge and /harvest skills and their pending-briefs queue are
 * provided by an optional external plugin, not by core. The dormant couplings
 * that used to reference those plugin concepts — the pending-briefs
 * system-prompt nudge and the daemon sessionstart brief-queue gate — were
 * removed from core. This test fails if those specific identifiers reappear.
 *
 * Scope is intentionally narrow — exact removed identifiers in the two files
 * that carried them — so it cannot false-positive on legitimate generic
 * plumbing (e.g. getBriefsDir still exists in paths.ts for the audit-fit skill).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(join(here, relativePath), 'utf-8');
}

describe('plugin-coupling regression — forge/briefs concepts stay out of core', () => {
  it('routing-directive.ts carries no pendingBriefContext nudge or briefs-dir coupling', () => {
    const src = readSource('routing-directive.ts');
    expect(src).not.toContain('pendingBriefContext');
    expect(src).not.toContain('getBriefsDir');
  });

  it('daemon/gates.ts carries no briefs_pending gate or briefs-dir coupling', () => {
    const src = readSource('daemon/gates.ts');
    expect(src).not.toContain('briefs_pending');
    expect(src).not.toContain('countPendingBriefs');
    expect(src).not.toContain('getBriefsDir');
  });
});
