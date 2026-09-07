import { describe, it, expect } from 'vitest';
import { isExplicitlyDisabled, isExplicitlyEnabled } from './env-helpers.js';

describe('isExplicitlyDisabled', () => {
  describe('disable values — return true', () => {
    it.each(['0', 'false', 'no', 'off'])('returns true for %s', (v) => {
      expect(isExplicitlyDisabled(v)).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it.each(['FALSE', 'False', 'NO', 'No', 'OFF', 'Off'])('returns true for %s', (v) => {
      expect(isExplicitlyDisabled(v)).toBe(true);
    });
  });

  describe('whitespace trimming', () => {
    it.each([' 0 ', ' false ', ' no ', ' off ', '\t0\t', '\nfalse\n'])(
      'returns true for %j (whitespace-padded)',
      (v) => {
        expect(isExplicitlyDisabled(v)).toBe(true);
      },
    );
  });

  describe('non-disable values — return false', () => {
    it.each(['1', 'yes', 'on', 'true', 'TRUE', 'enabled', 'garbage', 'falsy', 'nope'])(
      'returns false for %j',
      (v) => {
        expect(isExplicitlyDisabled(v)).toBe(false);
      },
    );
  });
});

describe('isExplicitlyEnabled', () => {
  describe('enable values — return true', () => {
    it.each(['1', 'true', 'yes', 'on'])('returns true for %s', (v) => {
      expect(isExplicitlyEnabled(v)).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it.each(['TRUE', 'True', 'YES', 'Yes', 'ON', 'On'])('returns true for %s', (v) => {
      expect(isExplicitlyEnabled(v)).toBe(true);
    });
  });

  describe('whitespace trimming', () => {
    it.each([' 1 ', ' true ', ' yes ', ' on ', '\t1\t', '\ntrue\n'])(
      'returns true for %j (whitespace-padded)',
      (v) => {
        expect(isExplicitlyEnabled(v)).toBe(true);
      },
    );
  });

  describe('non-enable values — return false', () => {
    it.each(['0', 'false', 'no', 'off', 'garbage', 'enabled', 'nope'])(
      'returns false for %j',
      (v) => {
        expect(isExplicitlyEnabled(v)).toBe(false);
      },
    );
  });
});
