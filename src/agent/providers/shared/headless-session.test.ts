import { describe, it, expect } from 'vitest';
import { isHeadlessSession } from './headless-session.js';

describe('isHeadlessSession (#2302)', () => {
  it('is true for an explicitly non-interactive session (afk chat, cron daemon task, fork)', () => {
    expect(isHeadlessSession({ isNonInteractive: true })).toBe(true);
  });

  it('is true for a daemon pull-shaped session (surface daemon, isNonInteractive false)', () => {
    expect(isHeadlessSession({ isNonInteractive: false, surface: 'daemon' })).toBe(true);
  });

  it('is true for a daemon session with isNonInteractive unset', () => {
    expect(isHeadlessSession({ surface: 'daemon' })).toBe(true);
  });

  it('is false for interactive surfaces', () => {
    expect(isHeadlessSession({})).toBe(false);
    expect(isHeadlessSession({ isNonInteractive: false })).toBe(false);
    expect(isHeadlessSession({ surface: 'repl' })).toBe(false);
    expect(isHeadlessSession({ surface: 'telegram', isNonInteractive: false })).toBe(false);
    expect(isHeadlessSession({ surface: 'cli' })).toBe(false);
  });
});
