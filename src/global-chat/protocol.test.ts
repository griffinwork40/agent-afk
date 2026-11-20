import { describe, expect, it } from 'vitest';
import {
  canonicalAdmin, canonicalHello, canonicalPost, canonicalReport, PROTOCOL_VERSION,
  PROTOCOL_ID, ROOM, MAX_TEXT_CHARS, MAX_LINKS, MAX_FRAME_BYTES, BACKLOG_SIZE,
  RETENTION_MS, CLOCK_SKEW_MS, REPORT_THRESHOLD, NAME_PATTERN, NAME_CHANGE_INTERVAL_MS,
} from './protocol.js';

describe('protocol v1', () => {
  it('locks the public constants', () => {
    expect([PROTOCOL_VERSION, PROTOCOL_ID, ROOM]).toEqual([1, 'afk-global-chat/v1', 'global']);
    expect([MAX_TEXT_CHARS, MAX_LINKS, MAX_FRAME_BYTES, BACKLOG_SIZE]).toEqual([500, 2, 4096, 50]);
    expect([RETENTION_MS, CLOCK_SKEW_MS, REPORT_THRESHOLD, NAME_CHANGE_INTERVAL_MS])
      .toEqual([604800000, 120000, 3, 86400000]);
    expect(NAME_PATTERN.source).toBe('^[a-z0-9_-]{2,16}$');
  });
  it('uses exactly the specified signing field order', () => {
    const prefix = 'afk-global-chat/v1\n';
    expect(canonicalHello({ ts: 12, pubkey: 'key', name: 'alice' }))
      .toBe(prefix + 'hello\nglobal\n12\nkey\nalice');
    expect(canonicalPost({ id: 'id', ts: 12, name: 'alice', text: 'hi 🎉' }))
      .toBe(prefix + 'post\nglobal\nid\n12\nalice\nhi 🎉');
    expect(canonicalReport({ id: 'id', ts: 12, target: 'target' }))
      .toBe(prefix + 'report\nglobal\nid\n12\ntarget');
    expect(canonicalAdmin({ id: 'id', ts: 12, op: 'mode', arg: 'closed' }))
      .toBe(prefix + 'admin\nglobal\nid\n12\nmode\nclosed');
  });
});
