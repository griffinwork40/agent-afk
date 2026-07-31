import { describe, it, expect } from 'vitest';
import { refreshEnvironmentDate } from './date-rollover.js';
import { formatEnvironmentFragment } from '../../../awareness/index.js';
import { assembleSystemPrompt, buildStableSystemPrefix } from './system-prompt.js';

const TZ = 'America/New_York';
/** 2026-07-30 18:00 UTC = Thursday 14:00 in New York. */
const THU = new Date('2026-07-30T18:00:00Z');
/** 2026-07-31 04:00 UTC = Friday 00:00 in New York — one minute past rollover. */
const FRI = new Date('2026-07-31T04:01:00Z');

function envBlock(now: Date): string {
  return formatEnvironmentFragment({ cwd: '/repo', now, timeZone: TZ });
}

describe('refreshEnvironmentDate', () => {
  it('is a no-op within the same local day', () => {
    const prompt = `PREAMBLE\n\n${envBlock(THU)}`;
    const sameDayLater = new Date('2026-07-30T23:59:00Z'); // still Thursday in NY
    const out = refreshEnvironmentDate(prompt, sameDayLater, TZ);
    expect(out).toBe(prompt);
  });

  it('re-renders the date line once the local day has rolled over', () => {
    const prompt = `PREAMBLE\n\n${envBlock(THU)}`;
    expect(prompt).toContain('- Date: Thursday, 2026-07-30 (America/New_York)');

    const out = refreshEnvironmentDate(prompt, FRI, TZ);
    expect(out).toContain('- Date: Friday, 2026-07-31 (America/New_York)');
    expect(out).not.toContain('Thursday, 2026-07-30');
  });

  it('rewrites exactly one line and preserves every other byte', () => {
    const prompt = [
      'TOOLS',
      '',
      '# Operator configuration\nbe terse',
      '',
      formatEnvironmentFragment({
        cwd: '/repo',
        now: THU,
        timeZone: TZ,
        sessionId: 'abcdef1234',
        surface: 'repl',
        workspace: { branch: 'main', headSha: 'deadbee', dirty: false, dirtyCount: 0, remoteUrl: null },
      }),
      '',
      'Available skills:\n- orient',
    ].join('\n');

    const out = refreshEnvironmentDate(prompt, FRI, TZ);
    const before = prompt.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    expect(after[changed[0] as number]).toBe('- Date: Friday, 2026-07-31 (America/New_York)');
    // Trailing lines of the block and the manifest after it survive intact.
    expect(out).toContain('- Session: abcdef12 (repl)');
    expect(out).toContain('- Workspace: main @ deadbee (clean)');
    expect(out.endsWith('Available skills:\n- orient')).toBe(true);
  });

  it('anchors on the LAST environment block, so a decoy in operator text cannot win', () => {
    const decoy = '# Environment\n- Working directory: /fake\n- Date: Monday, 1999-01-04 (UTC)';
    const prompt = `${decoy}\n\n${envBlock(THU)}`;
    const out = refreshEnvironmentDate(prompt, FRI, TZ);
    expect(out).toContain(decoy); // untouched
    expect(out).toContain('- Date: Friday, 2026-07-31 (America/New_York)');
  });

  it('passes through unchanged when there is no environment block', () => {
    const prompt = 'just a system prompt\nwith no environment fragment';
    expect(refreshEnvironmentDate(prompt, FRI, TZ)).toBe(prompt);
  });

  it('passes through unchanged when the block has no date line', () => {
    const prompt = '# Environment\n- Working directory: /repo\n- Session: abc (repl)';
    expect(refreshEnvironmentDate(prompt, FRI, TZ)).toBe(prompt);
  });

  it('passes through unchanged when the cwd line is unterminated (block is truncated)', () => {
    const prompt = '# Environment\n- Working directory: /repo';
    expect(refreshEnvironmentDate(prompt, FRI, TZ)).toBe(prompt);
  });

  it('handles the date line being the final line of the prompt', () => {
    const prompt = '# Environment\n- Working directory: /repo\n- Date: Thursday, 2026-07-30 (America/New_York)';
    const out = refreshEnvironmentDate(prompt, FRI, TZ);
    expect(out).toBe('# Environment\n- Working directory: /repo\n- Date: Friday, 2026-07-31 (America/New_York)');
  });

  it('does not throw on an invalid timezone', () => {
    const prompt = `X\n\n${envBlock(THU)}`;
    expect(() => refreshEnvironmentDate(prompt, FRI, 'Not/AZone')).not.toThrow();
  });

  // Drift guard: the refresher and the assembler must share one renderer. If
  // they ever diverge, this goes red — and in production a divergence would
  // look like a rollover on EVERY turn, busting the prompt cache continuously.
  it('is a no-op against a freshly assembled prompt at the same instant', () => {
    const assembled = assembleSystemPrompt(
      buildStableSystemPrefix({
        toolBase: 'TOOL',
        memoryPrompt: 'MEM',
        hotMemory: '',
        manifest: 'SKILLS',
        userSystem: 'OPERATOR',
      }),
      '/repo',
      { surface: 'repl', sessionId: 'abcdef1234', depth: undefined, maxDepth: undefined, workspace: null },
    );
    expect(refreshEnvironmentDate(assembled)).toBe(assembled);
  });
});
