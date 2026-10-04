import { describe, expect, it } from 'vitest';
import { displayWidth, stripAnsi } from '../display.js';
import { formatProgressBanner } from '../commands/interactive/progress-banner.js';
import { formatSkillIdentity, sanitizeSkillIdentity, skillIdentityBanner } from './skill-identity-format.js';

describe('skill display identity', () => {
  it('keeps absent fields absent and never changes the input', () => {
    const input = Object.freeze({ name: 'review' });
    expect(sanitizeSkillIdentity(input)).toEqual(input);
    expect(formatSkillIdentity(input, 80)).toBe('/review');
  });
  it('strips escape sequences and normalizes controls before redacting', () => {
    const input = { name: '\x1b[31mreview\x1b[0m', purpose: 'check\n\tcode\x85 now', arguments: 'sk-ant-\x1b[31m' + 'a'.repeat(24) };
    const safe = sanitizeSkillIdentity(input);
    expect(safe.name).toBe('review');
    expect(safe.purpose).toBe('check code now');
    expect(safe.arguments).not.toContain('aaaa');
    expect(input.arguments).toContain('\x1b');
    expect(formatSkillIdentity({ name: '\x1b]0;evil\x07review' }, 80)).toBe('/review');
  });
  it.each(['--password hunter2', '--api-key=short', 'TOKEN=short', 'https://user:pass@example.com', 'Bearer short', '-----BEGIN PRIVATE KEY-----'])('omits credential-bearing arguments: %s', argumentsText => {
    expect(sanitizeSkillIdentity({ name: 'review', arguments: argumentsText }).arguments).toBe('[arguments omitted]');
  });
  it.each([0, 1, 20, 40, 80])('bounds total output to %i columns with graphemes intact', width => {
    const text = formatSkillIdentity({ name: '日本👩‍💻é'.repeat(12), purpose: 'check code '.repeat(30), arguments: 'a b '.repeat(90) }, width);
    expect(displayWidth(text)).toBeLessThanOrEqual(width);
    if (width > 0) expect(text).toContain('…');
    expect(text).not.toMatch(/[\ud800-\udbff]$/u);
  });
  it('prioritizes name then activity over optional context', () => {
    expect(formatSkillIdentity({ name: 'review', purpose: 'purpose', arguments: 'args' }, 40, 'reading files')).toBe('/review · reading files');
  });
  it.each([20, 40, 80])('preserves real progress activity and details at %i columns', width => {
    const lines = formatProgressBanner({
      taskId: 'task', description: 'Investigating a very long task description '.repeat(10),
      summary: 'old summary', totalTokens: 1200, toolUses: 2, durationMs: 1000,
    }, width, 'reading files');
    const banner = skillIdentityBanner({ name: 'review', purpose: 'optional purpose', arguments: 'optional args' }, lines, width);
    expect(stripAnsi(banner)).toContain('reading files');
    expect(banner.split('\n').slice(1)).toEqual(lines);
    expect(banner.split('\n')[0]).toBe('/review');
    for (const row of banner.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(width);
  });
  it.each([20, 40, 80])('preserves stopping feedback with a bounded long identity at %i columns', width => {
    const lines = formatProgressBanner({
      taskId: 'task', description: 'Investigating a very long task description '.repeat(10),
      totalTokens: 1200, toolUses: 2, durationMs: 1000,
    }, width, 'reading files', true);
    const name = '日本👩‍💻é'.repeat(12);
    const banner = skillIdentityBanner({ name, purpose: 'optional purpose' }, lines, width);
    expect(stripAnsi(banner)).toContain('stopping…');
    expect(banner).not.toContain('esc to interrupt');
    expect(banner.split('\n').slice(1)).toEqual(lines);
    expect(banner.split('\n')[0]).toBe(formatSkillIdentity({ name }, width));
    for (const row of banner.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(width);
  });
  it('redacts before truncation and bounds each optional field', () => {
    const safe = sanitizeSkillIdentity({ name: 'n '.repeat(60), purpose: 'p '.repeat(100), arguments: 'arg '.repeat(100) });
    expect(displayWidth(safe.name)).toBeLessThanOrEqual(32);
    expect(displayWidth(safe.purpose!)).toBeLessThanOrEqual(96);
    expect(displayWidth(safe.arguments!)).toBeLessThanOrEqual(96);
    expect(sanitizeSkillIdentity({ name: 'x', purpose: 'sk-ant-' + 'a'.repeat(200) }).purpose).toBe('[REDACTED]');
  });
});
