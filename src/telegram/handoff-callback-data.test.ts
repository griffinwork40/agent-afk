import { describe, it, expect } from 'vitest';
import {
  buildHandoffCallback,
  parseHandoffCallback,
  HANDOFF_CALLBACK_PREFIX,
} from './handoff-callback-data.js';

describe('buildHandoffCallback', () => {
  it('builds a valid callback string', () => {
    const result = buildHandoffCallback('q-1716000000000-abc123', 2);
    expect(result).toBe('afk:h:2:q-1716000000000-abc123');
  });

  it('uses the correct prefix', () => {
    const result = buildHandoffCallback('task-1', 0);
    expect(result.startsWith(HANDOFF_CALLBACK_PREFIX)).toBe(true);
  });

  it('throws on invalid taskId characters', () => {
    expect(() => buildHandoffCallback('../evil', 0)).toThrow('invalid taskId');
  });

  it('throws on negative choiceIndex', () => {
    expect(() => buildHandoffCallback('task-1', -1)).toThrow('non-negative integer');
  });

  it('throws when payload exceeds 64 bytes', () => {
    const longId = 'a'.repeat(128); // max length
    // afk:h:0:<128 chars> = 6 + 2 + 128 = 136 bytes
    expect(() => buildHandoffCallback(longId, 0)).toThrow('exceeds');
  });
});

describe('parseHandoffCallback', () => {
  it('roundtrips with buildHandoffCallback', () => {
    const taskId = 'q-1716000000000-abc123';
    const data = buildHandoffCallback(taskId, 3);
    const parsed = parseHandoffCallback(data);
    expect(parsed).toEqual({ taskId, choiceIndex: 3 });
  });

  it('returns null for empty input', () => {
    expect(parseHandoffCallback(null)).toBeNull();
    expect(parseHandoffCallback(undefined)).toBeNull();
    expect(parseHandoffCallback('')).toBeNull();
  });

  it('returns null for wrong prefix', () => {
    expect(parseHandoffCallback('afk:e:0:task-1')).toBeNull();
    expect(parseHandoffCallback('afk:f:p:task-1')).toBeNull();
  });

  it('returns null for invalid choiceIndex', () => {
    expect(parseHandoffCallback('afk:h:abc:task-1')).toBeNull();
    expect(parseHandoffCallback('afk:h:-1:task-1')).toBeNull();
  });

  it('returns null for invalid taskId', () => {
    expect(parseHandoffCallback('afk:h:0:../evil')).toBeNull();
    expect(parseHandoffCallback('afk:h:0:')).toBeNull();
  });

  it('returns null for oversized payload', () => {
    // Manually craft a payload that exceeds 64 bytes
    const data = 'afk:h:0:' + 'a'.repeat(60);
    expect(parseHandoffCallback(data)).toBeNull();
  });
});
