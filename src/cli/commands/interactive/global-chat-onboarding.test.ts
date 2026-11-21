import { describe, it, expect } from 'vitest';
import { NOTICE_MIN_COLUMNS, NOTICE_MIN_ROWS, renderNotice, renderNameScreen, nameFeedback, NOTICE_LINES } from './global-chat-onboarding.js';
import { displayWidth, stripAnsi } from '../../display.js';

describe('onboarding screens', () => {
  it('notice fits one 80x24 screen and covers the required points', () => {
    expect(NOTICE_LINES.length + 1).toBeLessThanOrEqual(24);
    const text = renderNotice(80, 24).map(stripAnsi).join('\n');
    for (const s of ['public', '7 days', 'public key', 'salted', 'only if banned', 'agent context', 'no chat tool', 'not sandboxed', 'no spam', 'no secrets', '/global off']) {
      expect(text).toContain(s);
    }
    for (const l of renderNotice(80, 24)) expect(displayWidth(l)).toBeLessThanOrEqual(80);
  });
  it('requires a full notice before consent can be requested', () => {
    const text = stripAnsi(renderNotice(NOTICE_MIN_COLUMNS - 1, NOTICE_MIN_ROWS).join('\n'));
    expect(text).toContain(`Enlarge window to ${NOTICE_MIN_COLUMNS}x${NOTICE_MIN_ROWS}`);
    expect(text).not.toContain('Join?');
  });
  it('clamps to small sizes', () => {
    for (const [c, r] of [[10, 3], [0, 0], [30, 30]] as const) {
      const lines = renderNotice(c, r);
      expect(lines).toHaveLength(r);
      for (const l of [...lines, ...renderNameScreen('abc', 'err', false, c, r)]) expect(displayWidth(l)).toBeLessThanOrEqual(c);
    }
  });
  it('gives inline name feedback', () => {
    expect(nameFeedback('').ok).toBe(false);
    expect(nameFeedback('a').text).toContain('2 to 16');
    expect(nameFeedback('admin').text).toContain('reserved');
    expect(nameFeedback('neo').ok).toBe(true);
    expect(stripAnsi(renderNameScreen('neo', null, true, 80, 24).join('\n'))).toContain('Saving');
    expect(stripAnsi(renderNameScreen('neo', 'Bad thing', false, 80, 24).join('\n'))).toContain('Bad thing');
  });
});
