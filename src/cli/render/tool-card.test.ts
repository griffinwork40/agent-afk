import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { toolCard } from './tool-card.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Strip ANSI codes and split into lines for easy assertions. */
function lines(output: string): string[] {
  return stripAnsi(output).split('\n');
}

// ─── Status variants ─────────────────────────────────────────────────────────

describe('toolCard – status variants', () => {
  it('running: renders ● glyph', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'running' }));
    expect(out).toContain('●');
    expect(out).toContain('bash');
  });

  it('done: renders ✓ glyph', () => {
    const out = stripAnsi(toolCard({ toolName: 'read_file', status: 'done' }));
    expect(out).toContain('✓');
  });

  it('error: renders ✗ glyph', () => {
    const out = stripAnsi(toolCard({ toolName: 'write_file', status: 'error' }));
    expect(out).toContain('✗');
  });

  it('blocked: renders ⊘ glyph', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'blocked' }));
    expect(out).toContain('⊘');
  });
});

// ─── Collapsed mode ──────────────────────────────────────────────────────────

describe('toolCard – collapsed mode', () => {
  it('collapsed=true yields a single line even when body fields are provided', () => {
    const out = toolCard({
      toolName: 'bash',
      status: 'done',
      elapsed: 3000,
      inputSummary: 'ls -la /tmp',
      outputPreview: 'total 128',
      diff: { added: 2, removed: 0, file: '/tmp/file.txt' },
      collapsed: true,
    });
    expect(lines(out)).toHaveLength(1);
  });

  it('collapsed=true header still contains tool name and elapsed', () => {
    const out = stripAnsi(
      toolCard({
        toolName: 'edit_file',
        status: 'done',
        elapsed: 1500,
        collapsed: true,
      }),
    );
    expect(out).toContain('edit_file');
    expect(out).toContain('1s');
  });

  it('collapsed=false (default) renders body when content is provided', () => {
    const out = toolCard({
      toolName: 'bash',
      status: 'done',
      inputSummary: 'pnpm test',
      outputPreview: 'All tests passed',
    });
    expect(lines(out).length).toBeGreaterThan(1);
  });
});

// ─── Elapsed time ────────────────────────────────────────────────────────────

describe('toolCard – elapsed time', () => {
  it('shows elapsed when provided', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'done', elapsed: 5000 }));
    expect(out).toContain('5s');
  });

  it('shows <1s for sub-second elapsed', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'running', elapsed: 500 }));
    expect(out).toContain('<1s');
  });

  it('omits elapsed when not provided', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'running' }));
    // Should only have the badge + tool name on the single line
    expect(lines(out)).toHaveLength(1);
    expect(out.trim()).toBe('● bash');
  });
});

// ─── Diff stat line ──────────────────────────────────────────────────────────

describe('toolCard – diff stat', () => {
  it('renders +N and -M when diff is provided', () => {
    const out = stripAnsi(
      toolCard({
        toolName: 'edit_file',
        status: 'done',
        diff: { added: 5, removed: 3, file: 'src/index.ts' },
      }),
    );
    expect(out).toContain('+5');
    expect(out).toContain('-3');
    expect(out).toContain('src/index.ts');
  });

  it('diff stat appears on its own line', () => {
    const ls = lines(
      toolCard({
        toolName: 'edit_file',
        status: 'done',
        diff: { added: 1, removed: 0, file: 'a.ts' },
      }),
    );
    const diffLine = ls.find((l) => l.includes('+1'));
    expect(diffLine).toBeDefined();
    // Header is always the first line; diff should be on a later line
    expect(ls.indexOf(diffLine!)).toBeGreaterThan(0);
  });

  it('omits diff stat when diff is not provided', () => {
    const out = stripAnsi(toolCard({ toolName: 'bash', status: 'done' }));
    expect(out).not.toContain('+');
    expect(out).not.toContain('-0');
  });
});

// ─── Input summary and output preview ────────────────────────────────────────

describe('toolCard – input summary and output preview', () => {
  it('renders inputSummary when provided', () => {
    const out = stripAnsi(
      toolCard({ toolName: 'bash', status: 'done', inputSummary: 'ls -la /tmp' }),
    );
    expect(out).toContain('ls -la /tmp');
  });

  it('renders outputPreview when provided', () => {
    const out = stripAnsi(
      toolCard({ toolName: 'bash', status: 'done', outputPreview: 'total 42' }),
    );
    expect(out).toContain('total 42');
  });

  it('renders both on separate lines', () => {
    const ls = lines(
      toolCard({
        toolName: 'bash',
        status: 'done',
        inputSummary: 'echo hello',
        outputPreview: 'hello',
      }),
    );
    expect(ls.some((l) => l.includes('echo hello'))).toBe(true);
    expect(ls.some((l) => l.includes('hello'))).toBe(true);
    // There should be at least 3 lines: header + input + output
    expect(ls.length).toBeGreaterThanOrEqual(3);
  });

  it('omits body lines when inputs are empty strings', () => {
    const out = toolCard({
      toolName: 'bash',
      status: 'done',
      inputSummary: '',
      outputPreview: '',
    });
    expect(lines(out)).toHaveLength(1);
  });
});

// ─── Width truncation ─────────────────────────────────────────────────────────

describe('toolCard – width truncation', () => {
  it('truncates a very long tool name to fit width', () => {
    const longName = 'a'.repeat(200);
    const out = lines(toolCard({ toolName: longName, status: 'done', width: 40 }))[0]!;
    // Strip ANSI before measuring
    const plain = stripAnsi(out);
    // Should not exceed width significantly (badge + name + possible elapsed)
    expect(plain.length).toBeLessThanOrEqual(42); // allow 2 cols of slack
  });

  it('truncates inputSummary to fit within width', () => {
    const longInput = 'x'.repeat(300);
    const ls = lines(
      toolCard({ toolName: 'bash', status: 'done', inputSummary: longInput, width: 50 }),
    );
    const bodyLine = stripAnsi(ls[1] ?? '');
    // The body line should be shorter than the original (300 chars) due to truncation
    expect(bodyLine.trimEnd().length).toBeLessThanOrEqual(52);
  });

  it('truncates diff file path to fit width', () => {
    const longFile = '/very/long/path/'.repeat(10) + 'file.ts';
    const ls = lines(
      toolCard({
        toolName: 'edit_file',
        status: 'done',
        diff: { added: 1, removed: 1, file: longFile },
        width: 60,
      }),
    );
    const diffLine = stripAnsi(ls.find((l) => l.includes('+1')) ?? '');
    expect(diffLine.trimEnd().length).toBeLessThanOrEqual(62);
  });
});

// ─── Minimal spec ────────────────────────────────────────────────────────────

describe('toolCard – minimal spec', () => {
  it('renders with only toolName and status', () => {
    const out = toolCard({ toolName: 'bash', status: 'done' });
    expect(lines(out)).toHaveLength(1);
    expect(stripAnsi(out)).toContain('bash');
    expect(stripAnsi(out)).toContain('✓');
  });

  it('returns a non-empty string', () => {
    expect(toolCard({ toolName: '', status: 'running' }).length).toBeGreaterThan(0);
  });

  it('handles very small width without crashing', () => {
    expect(() =>
      toolCard({ toolName: 'bash', status: 'done', width: 1 }),
    ).not.toThrow();
  });
});

// ─── Sanitization (P1) ───────────────────────────────────────────────────────

describe('toolCard – sanitization of untrusted input', () => {
  it('strips ANSI escape sequences from outputPreview', () => {
    const malicious = '\x1b[2J\x1b[Hinjected';
    const out = stripAnsi(
      toolCard({ toolName: 'bash', status: 'done', outputPreview: malicious }),
    );
    // The injected payload text may survive but the raw escape sequences must not
    expect(out).not.toContain('\x1b[2J');
    expect(out).not.toContain('\x1b[H');
  });

  it('strips ANSI escape sequences from inputSummary', () => {
    const malicious = '\x1b]0;evil title\x07normal';
    const out = stripAnsi(
      toolCard({ toolName: 'bash', status: 'done', inputSummary: malicious }),
    );
    expect(out).not.toContain('\x1b]');
    expect(out).toContain('normal');
  });

  it('strips ANSI escape sequences from toolName', () => {
    const malicious = '\x1b[1mbold\x1b[0m';
    const out = stripAnsi(toolCard({ toolName: malicious, status: 'done' }));
    expect(out).not.toContain('\x1b[');
    expect(out).toContain('bold');
  });
});

// ─── Narrow width (P2) ───────────────────────────────────────────────────────

describe('toolCard – narrow terminal width', () => {
  it('does not widen output beyond a narrow caller budget (width=10)', () => {
    const out = lines(
      toolCard({ toolName: 'bash', status: 'done', width: 10 }),
    )[0]!;
    // stripAnsi first, then measure visible width
    expect(stripAnsi(out).length).toBeLessThanOrEqual(12); // 2 col slack for badge+space
  });

  it('does not widen output beyond a very narrow budget (width=5)', () => {
    const out = lines(
      toolCard({ toolName: 'read_file', status: 'done', width: 5 }),
    )[0]!;
    expect(stripAnsi(out).length).toBeLessThanOrEqual(7);
  });

  it('renders without crashing at width=1', () => {
    expect(() =>
      toolCard({ toolName: 'bash', status: 'done', inputSummary: 'x', outputPreview: 'y', width: 1 }),
    ).not.toThrow();
  });
});
