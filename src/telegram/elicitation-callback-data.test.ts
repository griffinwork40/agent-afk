/**
 * Tests for src/telegram/elicitation-callback-data.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildElicitationCallback,
  parseElicitationCallback,
  ELICITATION_CALLBACK_PREFIX,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from './elicitation-callback-data.js';

describe('parseElicitationCallback', () => {
  it('parses a valid callback with index 0', () => {
    const parsed = parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}0:elicit-abc-123`);
    expect(parsed).toEqual({ id: 'elicit-abc-123', choiceIndex: 0 });
  });

  it('parses a valid callback with index > 0', () => {
    const parsed = parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}3:my-elicitation-id`);
    expect(parsed).toEqual({ id: 'my-elicitation-id', choiceIndex: 3 });
  });

  it('returns null on unknown prefix', () => {
    expect(parseElicitationCallback('afk:f:0:some-id')).toBeNull();
    expect(parseElicitationCallback('afk:other:0:some-id')).toBeNull();
    expect(parseElicitationCallback('0:some-id')).toBeNull();
  });

  it('returns null on empty / nullish input', () => {
    expect(parseElicitationCallback(undefined)).toBeNull();
    expect(parseElicitationCallback(null)).toBeNull();
    expect(parseElicitationCallback('')).toBeNull();
  });

  it('returns null when payload exceeds 64-byte limit', () => {
    const overflow = `${ELICITATION_CALLBACK_PREFIX}0:${'a'.repeat(64)}`;
    expect(Buffer.byteLength(overflow)).toBeGreaterThan(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    expect(parseElicitationCallback(overflow)).toBeNull();
  });

  it('returns null when id is missing', () => {
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}0:`)).toBeNull();
  });

  it('returns null when index is not a pure integer string', () => {
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}1.5:some-id`)).toBeNull();
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}abc:some-id`)).toBeNull();
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}-1:some-id`)).toBeNull();
  });

  it('returns null when id contains disallowed characters', () => {
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}0:my/id`)).toBeNull();
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}0:my id`)).toBeNull();
    expect(parseElicitationCallback(`${ELICITATION_CALLBACK_PREFIX}0:my.id`)).toBeNull();
  });
});

describe('buildElicitationCallback', () => {
  it('round-trips through parseElicitationCallback', () => {
    const id = 'elicit-abc-123';
    const built = buildElicitationCallback(id, 2);
    expect(built).toBe(`${ELICITATION_CALLBACK_PREFIX}2:elicit-abc-123`);
    expect(parseElicitationCallback(built)).toEqual({ id, choiceIndex: 2 });
  });

  it('round-trips with index 0', () => {
    const id = 'my-question-id';
    const built = buildElicitationCallback(id, 0);
    const parsed = parseElicitationCallback(built);
    expect(parsed).toEqual({ id, choiceIndex: 0 });
  });

  it('throws on an invalid id', () => {
    expect(() => buildElicitationCallback('../escape', 0)).toThrow(/invalid id/);
    expect(() => buildElicitationCallback('', 0)).toThrow(/invalid id/);
  });

  it('throws on negative choiceIndex', () => {
    expect(() => buildElicitationCallback('valid-id', -1)).toThrow(/non-negative integer/);
  });

  it('stays under 64-byte limit for a max-length id (48 chars)', () => {
    const maxId = 'a'.repeat(48);
    const built = buildElicitationCallback(maxId, 0);
    expect(Buffer.byteLength(built)).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  it('rejects ids longer than 48 chars (grammar guard fires before byte check)', () => {
    expect(() => buildElicitationCallback('a'.repeat(49), 0)).toThrow(/invalid id/);
  });
});

import {
  buildCustomElicitationCallback,
  parseCustomElicitationCallback,
  ELICITATION_CUSTOM_CALLBACK_PREFIX,
} from './elicitation-callback-data.js';

describe('buildCustomElicitationCallback / parseCustomElicitationCallback', () => {
  it('round-trips: build → parse', () => {
    const id = 'elic-abc12345';
    const data = buildCustomElicitationCallback(id);
    expect(parseCustomElicitationCallback(data)).toBe(id);
  });

  it('custom prefix is distinct from regular prefix', () => {
    expect(ELICITATION_CUSTOM_CALLBACK_PREFIX).not.toBe(ELICITATION_CALLBACK_PREFIX);
  });

  it('parseCustomElicitationCallback returns null for regular afk:e: callback', () => {
    const regular = buildElicitationCallback('elic-abc12345', 0);
    expect(parseCustomElicitationCallback(regular)).toBeNull();
  });

  it('parseCustomElicitationCallback returns null on null/empty input', () => {
    expect(parseCustomElicitationCallback(null)).toBeNull();
    expect(parseCustomElicitationCallback(undefined)).toBeNull();
    expect(parseCustomElicitationCallback('')).toBeNull();
  });

  it('stays under 64-byte limit for max-length id (48 chars)', () => {
    const maxId = 'a'.repeat(48);
    const data = buildCustomElicitationCallback(maxId);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  it('buildCustomElicitationCallback throws on invalid id', () => {
    expect(() => buildCustomElicitationCallback('')).toThrow(/invalid id/);
    expect(() => buildCustomElicitationCallback('../escape')).toThrow(/invalid id/);
  });

  it('parseCustomElicitationCallback returns null when id fails grammar', () => {
    const badData = `${ELICITATION_CUSTOM_CALLBACK_PREFIX}my/id`;
    expect(parseCustomElicitationCallback(badData)).toBeNull();
  });

  it('parseCustomElicitationCallback does NOT match afk:e: regular prefix accidentally', () => {
    // afk:ec: starts with afk:e: — verify parseElicitationCallback returns null for custom callbacks
    // (the existing parser will proceed with rest='c:<id>', colonIdx=1, indexStr='c' → NaN → null)
    const customData = buildCustomElicitationCallback('elic-abc12345');
    // Regular parser returns null for custom callback data
    expect(parseElicitationCallback(customData)).toBeNull();
  });
});
