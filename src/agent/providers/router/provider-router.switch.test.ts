import { describe, expect, it } from 'vitest';
import { buildSwitchNotice, prependNotice } from './provider-router.switch.js';
import { wrapFrameworkContext } from '../../session/framework-context-envelope.js';
import { stripPreamble } from '../../session/preamble-strip.js';

const notice = buildSwitchNotice('model-a', 'model-b', 'anthropic', 'openai');
const envelope = wrapFrameworkContext('[hook] recent work digest');

describe('prependNotice keeps a leading harness envelope first', () => {
  it('inserts the notice after the envelope in string content', () => {
    const out = prependNotice(`${envelope}\n\nfix the test`, notice) as string;
    expect(out).toBe(`${envelope}\n\n${notice}\n\nfix the test`);
    expect(stripPreamble(out)).toBe(stripPreamble(`${notice}\n\nfix the test`));
  });

  it('inserts the notice block after an envelope block', () => {
    const blocks = [{ type: 'text' as const, text: envelope }, { type: 'text' as const, text: 'typed' }];
    expect(prependNotice(blocks, notice)).toEqual([blocks[0], { type: 'text', text: notice }, blocks[1]]);
  });

  it('leaves content without an envelope unchanged in shape', () => {
    expect(prependNotice('hello', notice)).toBe(`${notice}\n\nhello`);
    expect(prependNotice('', notice)).toBe(notice);
    const typed = '<framework-context-notes> mine';
    expect(prependNotice(typed, notice)).toBe(`${notice}\n\n${typed}`);
    expect(prependNotice([{ type: 'text', text: 'x' }], notice)).toEqual([{ type: 'text', text: notice }, { type: 'text', text: 'x' }]);
  });
});
