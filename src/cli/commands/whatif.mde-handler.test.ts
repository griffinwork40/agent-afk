/**
 * Tests for whatif.mde-handler.ts — the shared MDE-error decision logic
 * (issue #2610).
 *
 * Covers:
 *  - --yes always refuses, regardless of --force or measured flag.
 *  - A measured refusal always refuses (not prompts), with --no-baseline-sample advice.
 *  - An interactive non-measured non-yes refusal produces 'prompt'.
 *  - A non-interactive non-measured non-yes refusal produces 'refuse'.
 */

import { describe, it, expect } from 'vitest';
import { decideMdeAction } from './whatif.mde-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal WhatifMdeError-shaped object.  We do NOT import the real
 * class (it lives in run.ts which has many heavy dependencies); the handler
 * duck-types on `err.name === 'WhatifMdeError'` and reads `.measured`,
 * `.message`, `.kind`, `.predictionId`.  A plain object with those properties
 * is sufficient for unit-testing the decision logic.
 */
function makeMdeError(opts: {
  message?: string;
  measured?: boolean;
  kind?: 'mde' | 'headroom';
  predictionId?: string;
}) {
  const err = new Error(opts.message ?? 'whatif: run is underpowered — headroom too small');
  Object.defineProperty(err, 'name', { value: 'WhatifMdeError' });
  Object.assign(err, {
    episodesPerArm: 6,
    kind: opts.kind ?? 'mde',
    measured: opts.measured ?? false,
    predictionId: opts.predictionId,
  });
  return err as unknown as import('./whatif.mde-handler.js').MdeAction extends infer A ? never : never;
}

// ---------------------------------------------------------------------------
// Typed wrapper so TypeScript doesn't complain
// ---------------------------------------------------------------------------

type FakeError = {
  name: string;
  message: string;
  measured: boolean;
  kind: 'mde' | 'headroom';
  episodesPerArm: number;
};

function fake(opts: {
  message?: string;
  measured?: boolean;
  kind?: 'mde' | 'headroom';
}): FakeError {
  return {
    name: 'WhatifMdeError',
    message: opts.message ?? 'whatif: run is underpowered — headroom too small',
    measured: opts.measured ?? false,
    kind: opts.kind ?? 'mde',
    episodesPerArm: 6,
  };
}

// ---------------------------------------------------------------------------
// Tests: --yes always refuses
// ---------------------------------------------------------------------------

describe('decideMdeAction — --yes flag', () => {
  it('refuses when --yes is set and the refusal is not measured', () => {
    const err = fake({ measured: false });
    // Cast: the function accepts WhatifMdeErrorType; our fake matches structurally.
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      true /* yes */,
      true /* interactive */,
    );
    expect(action.kind).toBe('refuse');
  });

  it('refuses when --yes is set and --force would otherwise clear it', () => {
    // This is the core bug fix: with --yes and a non-measured error in a TTY,
    // the OLD code prompted because `!parsed.force` was the extra guard.
    // The new handler must refuse regardless.
    const err = fake({ measured: false, kind: 'mde' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      true /* yes */,
      true /* interactive — would have prompted without the fix */,
    );
    expect(action.kind).toBe('refuse');
    expect((action as { message: string }).message).toMatch(/underpowered run refused/);
  });

  it('refuses when --yes is set and the refusal IS measured', () => {
    const err = fake({ measured: true, kind: 'headroom' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      true /* yes */,
      false /* non-interactive */,
    );
    expect(action.kind).toBe('refuse');
  });

  it('includes the detail in the refuse message under --yes', () => {
    const err = fake({ message: 'whatif: run is underpowered — only 5pp headroom' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      true /* yes */,
      true,
    );
    expect(action.kind).toBe('refuse');
    expect((action as { message: string }).message).toContain('only 5pp headroom');
  });
});

// ---------------------------------------------------------------------------
// Tests: measured refusal always refuses (never prompts)
// ---------------------------------------------------------------------------

describe('decideMdeAction — measured refusal', () => {
  it('refuses for a measured refusal even in an interactive session', () => {
    const err = fake({ measured: true, kind: 'headroom' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false /* no --yes */,
      true /* interactive — must NOT prompt */,
    );
    expect(action.kind).toBe('refuse');
  });

  it('refuses for a measured refusal in a non-interactive session', () => {
    const err = fake({ measured: true, kind: 'headroom' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false,
      false,
    );
    expect(action.kind).toBe('refuse');
  });

  it('appends --no-baseline-sample advice when not already in message', () => {
    const err = fake({
      measured: true,
      message: 'whatif: run is underpowered — headroom 8pp < MDE 15pp',
    });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false,
      true,
    );
    expect(action.kind).toBe('refuse');
    expect((action as { message: string }).message).toContain('--no-baseline-sample');
  });

  it('does NOT duplicate --no-baseline-sample advice when already present', () => {
    const msg =
      'Prediction p1 leaves 8pp headroom; run cannot confirm it. ' +
      'More probes will not fix this; choose probes where the baseline leaves room, ' +
      'or pass --no-baseline-sample to run anyway.';
    const err = fake({ measured: true, message: msg });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false,
      true,
    );
    expect(action.kind).toBe('refuse');
    // Count occurrences of the advice substring — must be exactly 1.
    const refuseMsg = (action as { message: string }).message;
    const occurrences = (refuseMsg.match(/--no-baseline-sample/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: clearable refusal in an interactive session
// ---------------------------------------------------------------------------

describe('decideMdeAction — clearable interactive refusal', () => {
  it('prompts in a TTY for a non-measured MDE refusal without --yes', () => {
    const err = fake({ measured: false, kind: 'mde' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false /* no --yes */,
      true /* interactive */,
    );
    expect(action.kind).toBe('prompt');
    expect((action as { detail: string }).detail).toBeTruthy();
  });

  it('prompts in a TTY for a non-measured headroom refusal without --yes', () => {
    const err = fake({ measured: false, kind: 'headroom' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false,
      true,
    );
    expect(action.kind).toBe('prompt');
  });

  it('includes the detail text in the prompt action', () => {
    const err = fake({
      measured: false,
      kind: 'mde',
      message: 'whatif: run is underpowered — only 3 probes per prediction',
    });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false,
      true,
    );
    expect(action.kind).toBe('prompt');
    expect((action as { detail: string }).detail).toContain('only 3 probes');
  });
});

// ---------------------------------------------------------------------------
// Tests: non-interactive non-measured refusal
// ---------------------------------------------------------------------------

describe('decideMdeAction — non-interactive, non-measured', () => {
  it('refuses in a non-interactive session even for a clearable error', () => {
    const err = fake({ measured: false, kind: 'mde' });
    const action = decideMdeAction(
      err as unknown as Parameters<typeof decideMdeAction>[0],
      false /* no --yes */,
      false /* non-interactive */,
    );
    expect(action.kind).toBe('refuse');
  });
});
