import { describe, it, expect } from 'vitest';
import { renderTelegramChoices } from './elicitation-choice-list.js';

describe('renderTelegramChoices', () => {
  it('leaves short choices as plain buttons with no body list', () => {
    const r = renderTelegramChoices(['Yes, ship it', 'No']);
    expect(r).toEqual({ bodySuffix: '', labels: ['Yes, ship it', 'No'] });
  });

  it('lists full choices in the body and numbers buttons when any label exceeds 64 bytes', () => {
    const long = `Refactor the <session> manager ${'and more '.repeat(10)}end`;
    const r = renderTelegramChoices([long, 'Skip']);
    expect(r.bodySuffix).toContain('1. Refactor the &lt;session&gt; manager');
    expect(r.bodySuffix).toContain('end');
    expect(r.bodySuffix).toContain('2. Skip');
    expect(r.labels[0]?.startsWith('1. ')).toBe(true);
    expect(r.labels[1]).toBe('2. Skip');
    for (const l of r.labels) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(64);
  });
});
