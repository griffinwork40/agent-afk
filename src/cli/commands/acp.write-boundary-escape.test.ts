/**
 * The write boundary: whatever builds a frame, its display fields are escaped
 * at the moment it is written (`session/update` and `session/request_permission`).
 */
import { describe, expect, it, vi } from 'vitest';
import { sanitizeDisplay } from './acp.translate.bounds.js';
import { sendUpdate } from './acp.prompt-turn.js';
import type { AcpClientPeer, SessionUpdate } from './acp.wire.js';

const RLO = '\u202E';
const ZWSP = '\u200B';

describe('sanitizeDisplay', () => {
  it('escapes title, locations[].path and options[].name, on the frame and on a nested update or toolCall', () => {
    const params = {
      sessionId: 's',
      toolCall: { toolCallId: 't', title: `bash ls ${RLO}x`, locations: [{ path: `/tmp/a${ZWSP}b`, line: 3 }], rawInput: { command: `ls ${RLO}x` } },
      options: [{ optionId: 'allow_once', name: `Allow${RLO} once`, kind: 'allow_once' }],
    };
    const out = sanitizeDisplay(params);
    expect(out.toolCall.title).toBe('bash ls <U+202E>x');
    expect(out.toolCall.locations).toEqual([{ path: '/tmp/a<U+200B>b', line: 3 }]);
    expect(out.options[0]?.name).toBe('Allow<U+202E> once');
    // Data stays byte-exact, and the input object is not mutated.
    expect(out.toolCall.rawInput).toEqual({ command: `ls ${RLO}x` });
    expect(out.options[0]?.optionId).toBe('allow_once');
    expect(params.toolCall.title).toBe(`bash ls ${RLO}x`);
  });

  it('turns control characters and line separators in display fields into spaces', () => {
    expect(sanitizeDisplay({ title: 'a\nb\u2028c\u0007d' }).title).toBe('a b c d');
  });

  it('is idempotent and leaves clean frames deeply equal', () => {
    const clean = { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'read_file a.txt', locations: [{ path: '/w/a.txt' }], content: [] } };
    expect(sanitizeDisplay(clean)).toEqual(clean);
    const dirty = { update: { title: `x${RLO}y` } };
    expect(sanitizeDisplay(sanitizeDisplay(dirty))).toEqual(sanitizeDisplay(dirty));
  });

  it('passes non-objects through', () => {
    expect(sanitizeDisplay(undefined)).toBeUndefined();
    expect(sanitizeDisplay('x')).toBe('x');
  });
});

describe('sendUpdate', () => {
  it('escapes display fields of an update that was built without any inner escaping', async () => {
    const notify = vi.fn(async () => {});
    const peer = { notify } as unknown as AcpClientPeer;
    const update = {
      sessionUpdate: 'tool_call_update', toolCallId: 't', title: `evil${RLO}title`, locations: [{ path: `p${RLO}q` }],
    } as unknown as SessionUpdate;
    await sendUpdate(peer, 's1', update);
    expect(notify).toHaveBeenCalledWith('session/update', {
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'evil<U+202E>title', locations: [{ path: 'p<U+202E>q' }] },
    });
  });
});
