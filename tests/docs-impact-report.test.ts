import { describe, expect, it } from 'vitest';
import { baseSurface, changedFiles, impactMarkdown, surfaceChanges, type GitRead } from '../scripts/lib/docs-impact.js';
import { featSinceDocs, reportMarkdown } from '../scripts/docs-report.js';
import type { Backlog, Surface } from '../scripts/lib/public-surface.js';

const current: Surface = { version: 1, symbols: [
  { kind: 'tool', name: 'alpha_tool', source: 'src/agent/alpha.ts' },
  { kind: 'slash', name: '/new', source: 'src/cli/new.ts' },
] };
const old: Surface = { version: 1, symbols: [
  { kind: 'tool', name: 'alpha_tool', source: 'src/agent/alpha.ts' },
  { kind: 'hook', name: 'OldHook', source: 'src/agent/old.ts' },
] };
const pages = [{ path: 'website/content/docs/guides/alpha.mdx', text: 'Use `alpha_tool` here. {/* `OldHook` */}' }];

function fakeGit(): GitRead {
  return (args) => {
    if (args[0] === 'diff') return 'src/agent/alpha.ts\nsrc/cli/new.ts\nREADME.md\n';
    if (args[0] === 'show') return JSON.stringify(old);
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
}

describe('docs impact', () => {
  it('maps changed source to committed symbols and handwritten pages, with snapshot delta', () => {
    const summary = impactMarkdown('main', current, pages, fakeGit());
    expect(summary).toContain('Changed source files (2)');
    expect(summary).toContain('`tool:alpha_tool`: `website/content/docs/guides/alpha.mdx`');
    expect(summary).toContain('`slash:/new`: no handwritten page names it');
    expect(summary).toContain('Added public symbols (1)\n- `slash:/new`');
    expect(summary).toContain('Removed public symbols (1)\n- `hook:OldHook`');
    expect(surfaceChanges(current, old).added).toEqual([current.symbols[1]]);
  });

  it('falls back from three-dot to two-dot then to empty on missing ref', () => {
    const twoDot = changedFiles('main', (args) => {
      if (args[2] === 'main...HEAD') throw new Error('no merge base');
      return 'src/agent/alpha.ts\n';
    });
    expect(twoDot).toEqual({ files: ['src/agent/alpha.ts'], note: 'No merge base; used two-dot diff.' });
    const missing = changedFiles('missing', () => { throw new Error('missing ref'); });
    expect(missing.files).toEqual([]);
    expect(missing.note).toContain('unavailable');
    expect(impactMarkdown('missing', current, pages, () => { throw new Error('missing'); })).toContain('unavailable');
    expect(baseSurface('missing', () => { throw new Error('missing'); }).surface).toBeUndefined();
  });

  it('includes uncommitted working-tree edits alongside committed changes', () => {
    const result = changedFiles('main', (args) => {
      if (args[2] === 'main...HEAD') return 'src/agent/committed.ts\n';
      if (args[2] === 'HEAD') return 'src/cli/slash/commands/copy.ts\nsrc/agent/committed.ts\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    });
    expect(result).toEqual({ files: ['src/agent/committed.ts', 'src/cli/slash/commands/copy.ts'] });
  });

  it('ignores non-source changes and tolerates absent base snapshot', () => {
    const git: GitRead = (args) => { if (args[0] === 'show') throw new Error('no snapshot'); return 'website/foo.mdx\n'; };
    const summary = impactMarkdown('main', current, pages, git);
    expect(summary).toContain('Changed source files (0)\n- None');
    expect(summary).toContain('No readable public-surface snapshot');
  });
});

describe('impactMarkdown: safe base rendering', () => {
  it('HTML-escapes special chars in base so a malicious ref cannot create links or break code', () => {
    // Backtick in base: must not close a CommonMark code span
    const backtickBase = impactMarkdown('main`evil', current, pages, fakeGit());
    expect(backtickBase).not.toMatch(/`evil/);       // no raw backtick → no code-span break
    expect(backtickBase).toContain('&#96;evil');     // HTML-entity escaped
    // The Base: line itself must not contain a raw backtick (checks only that line)
    const baseLine = backtickBase.split('\n').find((l) => l.startsWith('Base:')) ?? '';
    expect(baseLine).not.toMatch(/`/);

    // Angle brackets: must not create HTML links
    const ltGtBase = impactMarkdown('<script>alert(1)</script>', current, pages, fakeGit());
    expect(ltGtBase).not.toContain('<script>');
    expect(ltGtBase).toContain('&#60;script&#62;');

    // Ampersand entity injection
    const ampBase = impactMarkdown('a&b', current, pages, fakeGit());
    expect(ampBase).not.toMatch(/a&b/);
    expect(ampBase).toContain('a&#38;b');

    // Encode link punctuation as entities before Markdown parsing.
    const linkBase = impactMarkdown('](http://evil.example.com)', current, pages, fakeGit());
    const linkBaseLine = linkBase.split('\n').find((l) => l.startsWith('Base:')) ?? '';
    expect(linkBaseLine).toMatch(/^Base: <code>.*<\/code>$/);   // always wrapped in <code>

    const newlineBase = impactMarkdown('main\n# evil', current, pages, fakeGit());
    expect(newlineBase).toContain('<code>main&#10;&#35;&#32;evil</code>');
    const unavailable = impactMarkdown('main[click](https://evil)', current, pages, () => { throw new Error('missing'); });
    expect(unavailable).not.toContain('[click]');
    expect(unavailable).toContain('Note: Base main&#91;click&#93;&#40;https&#58;//evil&#41; unavailable');

    // Combination: base with backtick AND angle brackets
    const comboBase = impactMarkdown('`<b>xss</b>`', current, pages, fakeGit());
    expect(comboBase).not.toContain('`<b>');
    expect(comboBase).toContain('&#96;&#60;b&#62;xss&#60;/b&#62;&#96;');
  });

  it('wraps safe base in <code> tags (HTML rendering, not markdown code span)', () => {
    const md = impactMarkdown('origin/main', current, pages, fakeGit());
    expect(md).toContain('<code>origin/main</code>');
    expect(md).not.toMatch(/Base: `[^`]/);   // must NOT use backtick code span
  });
});

describe('docs report', () => {
  it('renders backlog, generated-only kinds and safe feat subjects', () => {
    const backlog: Backlog = { version: 1, entries: [{ kind: 'slash', name: '/new', reason: 'Pending guide', added: '2026-10-18' }] };
    const git: GitRead = (args) => args[1] === '-1' ? 'aabbccdd\n'
      : 'deadbee\tfeat(cli): add new command\nfeed123\tfix: typo\n';
    const report = reportMarkdown(current, backlog, pages, featSinceDocs(git));
    expect(report).toContain('`slash:/new` (2026-10-18): Pending guide');
    expect(report).toContain('Public symbols named only in generated references (1)\n- `slash:/new`');
    expect(report).toContain('`deadbee` feat(cli): add new command');
    expect(report).not.toContain('fix: typo');
    expect(report).toContain('website/docs-backlog.json');
    expect(report).toContain('pnpm docs:refs:check');
  });

  it('redacts likely secrets from commit subjects and backlog reasons', () => {
    const git: GitRead = (args) => args[1] === '-1' ? 'aabbccdd\n'
      : 'deadbee\tfeat: avoid sk-ant-abcdefghijklmnop\n';
    const backlog: Backlog = { version: 1, entries: [{ kind: 'tool', name: 'alpha_tool', added: '2026-10-18', reason: 'Bearer abcdef0123456789' }] };
    const report = reportMarkdown(current, backlog, pages, featSinceDocs(git));
    expect(report).not.toContain('sk-ant-abcdefghijklmnop');
    expect(report).not.toContain('abcdef0123456789');
    expect(report).toContain('[REDACTED]');
  });

  it('reports missing history without throwing', () => {
    expect(featSinceDocs(() => { throw new Error('unavailable'); })).toEqual({ commits: [], note: 'Git history unavailable.' });
    expect(featSinceDocs(() => '')).toEqual({ commits: [], note: 'No prior docs-content commit found.' });
  });
});
