/**
 * Unit tests for the session-identity derivation helpers.
 *
 * These encode the canonical mapping table from the normalize-session-identity
 * plan: Surface → origin (Q1) and parentSessionId → actor (Q2).
 */

import { describe, it, expect } from 'vitest';
import { deriveOrigin, deriveActor } from './session-identity.js';
import type { Surface } from '../awareness/types.js';

describe('deriveOrigin — Surface → user-facing origin (Q1)', () => {
  it.each<[Surface | undefined, ReturnType<typeof deriveOrigin>]>([
    ['cli', 'cli'],
    ['repl', 'cli'], // REPL is a CLI entrypoint
    ['telegram', 'telegram'],
    ['daemon', 'daemon'],
    ['subagent', 'unknown'], // actor role, not a surface
    ['unknown', 'unknown'],
    [undefined, 'unknown'],
  ])('maps surface %s → origin %s', (surface, expected) => {
    expect(deriveOrigin(surface)).toBe(expected);
  });

  it('never returns a value outside the origin union', () => {
    const all: (Surface | undefined)[] = [
      'cli',
      'repl',
      'telegram',
      'daemon',
      'subagent',
      'unknown',
      undefined,
    ];
    const allowed = new Set(['cli', 'telegram', 'daemon', 'unknown']);
    for (const s of all) expect(allowed.has(deriveOrigin(s))).toBe(true);
  });
});

describe('deriveActor — parentSessionId → actor role (Q2)', () => {
  it('top-level session (no parent) → main', () => {
    expect(deriveActor(undefined)).toBe('main');
    expect(deriveActor(null)).toBe('main');
  });

  it('forked session (parentSessionId set) → subagent', () => {
    expect(deriveActor('parent-uuid-123')).toBe('subagent');
  });

  it('empty string parent id is still a parent (forked) — defensive', () => {
    // An empty string is a degenerate id but still non-null; `== null` only
    // catches null/undefined, so this is treated as a fork.
    expect(deriveActor('')).toBe('subagent');
  });
});
