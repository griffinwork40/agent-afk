import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { buildHandoffCallback, parseHandoffCallback } from './handoff-callback-data.js';

const questionId = '12345678-1234-4123-a123-123456789abc';

describe('buildHandoffCallback', () => {
  it('encodes a UUID v4 without including even a maximum-length task ID', () => {
    const data = buildHandoffCallback({ taskId: 'a'.repeat(128), questionId }, 19);
    expect(data).toBe(`afk:h:q:19:${questionId}`);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseHandoffCallback(data)).toEqual({ questionId, choiceIndex: 19 });
  });

  it('builds the legacy form only when the question ID is absent', () => {
    const taskId = 'q-1716000000000-abc123';
    const data = buildHandoffCallback({ taskId }, 3);
    expect(data).toBe(`afk:h:3:${taskId}`);
    expect(parseHandoffCallback(data)).toEqual({ taskId, choiceIndex: 3 });
  });

  it('rejects a malformed question ID rather than falling back to the task ID', () => {
    expect(() => buildHandoffCallback({ taskId: 'task-1', questionId: '' }, 0)).toThrow('invalid questionId');
    expect(() => buildHandoffCallback({ taskId: 'task-1', questionId: 'not-a-uuid' }, 0)).toThrow('invalid questionId');
  });

  it('rejects an invalid legacy task ID', () => {
    expect(() => buildHandoffCallback({ taskId: '../evil' }, 0)).toThrow('invalid taskId');
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects choice index %s', (index) => {
    expect(() => buildHandoffCallback({ taskId: 'task-1', questionId }, index)).toThrow('non-negative safe integer');
  });

  it('enforces the 64-byte boundary for legacy records', () => {
    const taskId = 'a'.repeat(56); // prefix and single-digit index use 8 bytes
    const data = buildHandoffCallback({ taskId }, 0);
    expect(Buffer.byteLength(data, 'utf8')).toBe(64);
    expect(parseHandoffCallback(data)).toEqual({ taskId, choiceIndex: 0 });
    expect(() => buildHandoffCallback({ taskId: `${taskId}a` }, 0)).toThrow('exceeds');
    expect(parseHandoffCallback(`${data}a`)).toBeNull();
  });
});

describe('parseHandoffCallback', () => {
  it.each([
    null, undefined, '', 'afk:e:0:task-1', 'afk:f:p:task-1',
    'afk:h:abc:task-1', 'afk:h:-1:task-1', 'afk:h:0:../evil', 'afk:h:0:',
    `afk:h:q:01:${questionId}`, `afk:h:q:1e0:${questionId}`, `afk:h:q:-0:${questionId}`,
    `afk:h:q:9007199254740992:${questionId}`, `afk:h:q:0:${questionId}:extra`,
    'afk:h:q:0:12345678-1234-5123-a123-123456789abc', // wrong UUID version
    'afk:h:q:0:12345678-1234-4123-7123-123456789abc', // wrong UUID variant
  ])('rejects malformed data %j', (data) => {
    expect(parseHandoffCallback(data)).toBeNull();
  });
});
