import { describe, it, expect } from 'vitest';
import { renderTelegramChoices, buildChoiceMessages, TELEGRAM_MAX_CHARS } from './elicitation-choice-list.js';

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

describe('buildChoiceMessages — 20 × 250-char choices', () => {
  // Build 20 choices each ~250 chars long — well over the 64-byte button label
  // limit, and collectively far beyond the 4096-char Telegram limit.
  const longChoice = (i: number) => `Option ${i + 1}: ${'x'.repeat(240)}`;
  const choices = Array.from({ length: 20 }, (_, i) => longChoice(i));
  const baseText = '💬 <b>Question from agent</b>\n\nWhich option?';

  const rendering = renderTelegramChoices(choices);

  it('rendering has overflow (bodySuffix non-empty)', () => {
    expect(rendering.bodySuffix).not.toBe('');
  });

  it('buildChoiceMessages splits into pre-messages when candidate exceeds 4096', () => {
    const candidate = baseText + rendering.bodySuffix;
    expect(candidate.length).toBeGreaterThan(TELEGRAM_MAX_CHARS);

    const result = buildChoiceMessages(baseText, rendering, choices);
    expect(result.preMessages.length).toBeGreaterThan(0);
  });

  it('every pre-message is ≤ 4096 chars', () => {
    const result = buildChoiceMessages(baseText, rendering, choices);
    for (const msg of result.preMessages) {
      expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    }
  });

  it('keyboardText is ≤ 4096 chars', () => {
    const result = buildChoiceMessages(baseText, rendering, choices);
    expect(result.keyboardText.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('every choice full text appears somewhere in the pre-messages', () => {
    const result = buildChoiceMessages(baseText, rendering, choices);
    const combined = result.preMessages.join('\n');
    for (let i = 0; i < choices.length; i++) {
      // The choice text is HTML-escaped in the list; 'x'.repeat(240) has no
      // special HTML chars so it appears verbatim.
      expect(combined).toContain(`${i + 1}. `);
      expect(combined).toContain('x'.repeat(10)); // representative substring
    }
  });

  it('all 20 full choices are present across pre-messages', () => {
    const result = buildChoiceMessages(baseText, rendering, choices);
    const combined = result.preMessages.join('\n');
    for (let i = 0; i < 20; i++) {
      expect(combined).toContain(`Option ${i + 1}:`);
    }
  });
});

describe('buildChoiceMessages — fits in one message', () => {
  it('returns empty preMessages and unchanged keyboardText when everything fits', () => {
    const choices = ['Alpha', 'Beta'];
    const rendering = renderTelegramChoices(choices);
    // Short choices → no overflow → bodySuffix is ''
    expect(rendering.bodySuffix).toBe('');
    const baseText = 'Pick one';
    const result = buildChoiceMessages(baseText, rendering, choices);
    expect(result.preMessages).toHaveLength(0);
    expect(result.keyboardText).toBe(baseText);
  });

  it('returns empty preMessages when overflow fits within 4096', () => {
    // One long choice but total still fits
    const long = 'A'.repeat(65); // just over 64-byte label limit
    const choices = [long, 'B'];
    const rendering = renderTelegramChoices(choices);
    expect(rendering.bodySuffix).not.toBe('');
    const baseText = 'Short question';
    const result = buildChoiceMessages(baseText, rendering, choices);
    expect(result.preMessages).toHaveLength(0);
    expect(result.keyboardText).toBe(baseText + rendering.bodySuffix);
  });
});
