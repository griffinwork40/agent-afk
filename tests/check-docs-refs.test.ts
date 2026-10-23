import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../scripts/lib/docs-reference.js';
import { checkDocsRefs } from '../scripts/check-docs-refs.js';
import { buildKnown, configSchemaPaths, DYNAMIC_TOOLS, loadKnown, parseCliReference } from '../scripts/lib/docs-refs-known.js';
import { afkSegments, tokenize } from '../scripts/lib/docs-refs-command.js';
import type { Surface } from '../scripts/lib/public-surface.js';

const surface: Surface = { version: 1, symbols: [
  { kind: 'command', name: 'afk' }, { kind: 'command', name: 'afk interactive' }, { kind: 'command', name: 'afk chat' }, { kind: 'command', name: 'afk schedule' },
  { kind: 'command', name: 'afk schedule add' }, { kind: 'command', name: 'afk provider' }, { kind: 'command', name: 'afk provider auth' },
  { kind: 'flag', name: 'afk --version' }, { kind: 'flag', name: 'afk interactive --resume' }, { kind: 'flag', name: 'afk schedule add --cron' },
  { kind: 'env', name: 'AFK_MODEL' }, { kind: 'env', name: 'AFK_MODEL_LARGE_BASE_URL' }, { kind: 'env', name: 'AFK_WORKTREE_BASE' },
  { kind: 'slash', name: '/model' }, { kind: 'tool', name: 'read_file' }, { kind: 'hook', name: 'PreToolUse' },
  { kind: 'config', name: 'models.large' }, { kind: 'config', name: 'telegram.notify.mode' },
] };
const known = buildKnown(surface, repoRoot);
const check = (text: string, path = 'guides/x.mdx'): string[] => checkDocsRefs([{ path, text }], known);

describe('docs refs: environment variables', () => {
  it('accepts known names and patterns, rejects unknown names and dead patterns', () => {
    expect(check('Set `AFK_MODEL` or AFK_MODEL_<TIER>_BASE_URL or `AFK_WORKTREE_*` or AFK_MODEL_{LARGE}_BASE_URL.')).toEqual([]);
    expect(check('Escaped AFK_MODEL_\\<TIER\\>_BASE_URL and AFK_MODEL_&lt;TIER&gt;_BASE_URL.')).toEqual([]);
    expect(check('Use AFK_MODLE.')).toEqual(['guides/x.mdx:1: env AFK_MODLE not found (did you mean AFK_MODEL?)']);
    expect(check('Use `AFK_GONE_*`.')).toEqual(['guides/x.mdx:1: env-pattern AFK_GONE_* not found']);
  });
  it('ReDoS: pathological consecutive wildcards finish in <100ms', () => {
    const start = Date.now();
    // AFK_*<A>*<B>*<C> produces consecutive wildcards — must not backtrack catastrophically
    check('AFK_*<A>*<B>*<C>_GONE');
    check('AFK_<X><Y><Z><W>_SUFFIX_GONE');
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('docs refs: afk command lines', () => {
  it('resolves the longest path and checks flags before separators', () => {
    expect(check('```bash\n$ afk schedule add --cron "0 2 * * *" | grep --color x && echo --no\n```')).toEqual([]);
    expect(check('```bash\nafk schedule add --cronn x\n```')).toEqual(['guides/x.mdx:2: flag afk schedule add --cronn not found (did you mean --cron?)']);
    expect(check('Run `afk --version` then `afk i --resume abc`.')).toEqual([]);
    expect(check('```sh\nafk schedule add \\\n  --bogus\n```')[0]).toMatch(/^guides\/x\.mdx:2: flag afk schedule add --bogus/);
    expect(check('```bash\nafk interactive --resume x # --not-a-flag\nafk interactive --resume x > out.txt\n```')).toEqual([]);
  });
  it('treats quoted and non-command words as prompts, but flags near misses and removed commands', () => {
    expect(check('```bash\nafk "fix the bug"\nafk fix the tests\nafk --resume abc\n```')).toEqual([]);
    expect(check('`afk shedule add`')).toEqual(['guides/x.mdx:1: command afk shedule not found (did you mean afk schedule?)']);
    expect(check('`afk grok login`')).toEqual(['guides/x.mdx:1: command afk grok not found (did you mean afk provider auth xai?)']);
    expect(check('```json\n{"cmd": "afk --nope"}\n```')).toEqual([]);
  });
  it('tokenizes quotes, separators, and env prefixes', () => {
    expect(tokenize(`afk "a b" 'c'|x`).map((t) => t.text)).toEqual(['afk', 'a b', 'c', '|', 'x']);
    expect(afkSegments('FOO=1 afk schedule && echo afk')).toHaveLength(1);
  });
});

describe('docs refs: reviewer regressions', () => {
  const bare = (text: string): string[] => check(text).map((f) => f.replace(/ \(did you mean .*\)$/, ''));
  const bogus = (line: number, path = 'afk schedule add'): string => `guides/x.mdx:${line}: flag ${path} --bogus not found`;
  it('#1 keeps checking option tokens after an unquoted placeholder', () => {
    expect(bare('```bash\nafk chat $PROMPT --bogus\n```')).toEqual([bogus(2, 'afk chat')]);
    expect(bare('```bash\nafk schedule add --name $NAME --bogus\n```')).toEqual([bogus(2)]);
    expect(bare('```bash\nafk schedule <subcommand> --anything\n```')).toEqual([]);
  });
  it('#2 treats runner prefixes and command substitution as afk invocations', () => {
    for (const prefix of ['npx', 'npx -y', 'pnpm', 'pnpm exec', 'bunx', 'yarn', 'npm exec --']) {
      expect(bare(`\`\`\`bash\n${prefix} afk schedule add --bogus\n\`\`\``)).toEqual([bogus(2)]);
    }
    expect(bare('```bash\necho $(afk schedule add --bogus)\n```')).toEqual([bogus(2)]);
    expect(bare('```bash\necho `afk schedule add --bogus`\n```')).toEqual([bogus(2)]);
    expect(bare('Run `npx afk schedule add --bogus` or `pnpm exec afk schedule add --bogus`.')).toEqual([bogus(1), bogus(1)]);
    expect(bare('Run `X=$(afk schedule add --bogus)`.')).toEqual([bogus(1)]);
  });
  it('#3 consumes option arguments by arity and handles --flag=value', () => {
    expect(bare('```bash\nafk schedule add --name "--fake"\n```')).toEqual([]);
    expect(bare('```bash\nafk --model sonnet schedule add --cron "0 2 * * *"\n```')).toEqual([]);
    expect(bare('```bash\nafk -m sonnet schedule add --cron=x --bogus=1\n```')).toEqual([bogus(2)]);
  });
  it('#4 checks shell-like and unlabeled fences, the latter only for afk-first lines', () => {
    for (const lang of ['terminal', 'ps1', 'pwsh', 'powershell', 'console', 'shell', 'shellsession', 'cmd']) {
      expect(bare(`\`\`\`${lang}\nafk schedule add --bogus\n\`\`\``)).toEqual([bogus(2)]);
    }
    expect(bare('```\n$ afk schedule add --bogus\nPS> afk schedule add --bogus\n> npx afk schedule add --bogus\n```')).toEqual([bogus(2), bogus(3), bogus(4)]);
    expect(bare('```\necho afk --bogus\ncat x | afk --bogus\nafk is great --bogus? no\n```')).toEqual([]);
    expect(bare('```md\nafk schedule add --bogus\n```')).toEqual([bogus(2)]);
  });
});

describe('docs refs: slash, config, tools, hooks', () => {
  it('checks slash tokens but not paths, filesystem roots, or API paths', () => {
    expect(check('Use `/model sonnet`, `/tmp`, `/usr/bin`, `/v1`, `~/x/y`, `/a.txt`, and [x](/guides/y).')).toEqual([]);
    expect(check('Use `/modle`.')).toEqual(['guides/x.mdx:1: slash /modle not found (did you mean /model?)']);
  });
  it('checks dotted config tokens under known roots, allowing map children and prefixes', () => {
    expect(check('`models.large`, `models.large.contextWindow`, `telegram.notify`, `telegram.notify.*`, `telegram.chatAliases.ops`')).toEqual([]);
    expect(check('`telegram.notify.mood`')[0]).toMatch(/config telegram\.notify\.mood not found/);
    expect(check('`package.json` and `foo.bar`')).toEqual([]);
  });
  it('checks tool and hook phrases plus reference headings', () => {
    expect(check('The `read_file` tool and `PreToolUse` hook, `emit_progress` tool.')).toEqual([]);
    expect(check('The `fetch_page` tool fires a `PreToolCall` event.')).toEqual([
      'guides/x.mdx:1: tool fetch_page not found', 'guides/x.mdx:1: hook PreToolCall not found (did you mean PreToolUse?)']);
    expect(check('### `old_tool`', 'reference/tools.mdx')).toEqual(['reference/tools.mdx:1: tool old_tool not found']);
    expect(check('## `Notify`', 'reference/hooks.mdx')).toEqual(['reference/hooks.mdx:1: hook Notify not found']);
  });
});

describe('docs refs: comments and opt-outs', () => {
  it('ignores comments, ignore-next-line, and ignore blocks without shifting line numbers', () => {
    expect(check('{/* AFK_NOPE */}\n<!-- `/nope` -->')).toEqual([]);
    expect(check('{/* docs-refs-ignore-next-line */}\nThe old `/bypass` command.\n`/bypass`')).toEqual(['guides/x.mdx:3: slash /bypass not found']);
    expect(check('{/* docs-refs-ignore-start */}\n`/a1`\n`/b2`\n{/* docs-refs-ignore-end */}\n`/zq9x`')).toEqual(['guides/x.mdx:5: slash /zq9x not found']);
  });
  it('ignore markers written as MDX comments suppress findings (convention: markers live in {/* */})', () => {
    // Contract: ignoredLines reads raw text so {/* docs-refs-ignore-* */} markers work as intended.
    // stripComments is line-preserving so line numbers stay aligned between findings and ignored set.
    expect(check('{/* docs-refs-ignore-next-line */}\nThe old `/bypass` command.\n`/bypass`')).toEqual(['guides/x.mdx:3: slash /bypass not found']);
    // Marker on line 1 suppresses line 2 only; line 3 is still reported.
    expect(check('{/* docs-refs-ignore-start */}\n`/a1`\n{/* docs-refs-ignore-end */}\n`/zq9x`')).toEqual(['guides/x.mdx:4: slash /zq9x not found']);
  });
});

describe('docs refs: known-symbol sources', () => {
  it('reads aliases/short flags from the generated CLI reference and file-only config keys', () => {
    const cli = parseCliReference('## `afk chat`\n\nAliases: `c`\n\n| `-m, --model <model>` | x |  |\n| `-w, --worktree [branch]` | x |  |\n| `--json` | x |  |');
    expect(cli.get('afk chat')).toEqual({ aliases: ['c'], flags: ['-m', '--model', '-w', '--worktree', '--json'],
      args: { '-m': 'required', '--model': 'required', '-w': 'optional', '--worktree': 'optional' } });
    const paths = configSchemaPaths('interface ConfigFileSchema { a?: { b?: string; m?: Record<string, number> }; c?: number[] }');
    expect(paths).toEqual(['a', 'a.b', 'a.m', 'a.m.*', 'c']);
  });
  it('keeps dynamic tools declared in their source', () => {
    for (const [name, file] of Object.entries(DYNAMIC_TOOLS)) expect(readFileSync(join(repoRoot, file), 'utf8')).toContain(name);
  });
  it('passes on the real corpus', async () => {
    const real = await loadKnown(repoRoot);
    expect(real.commands.get('afk i')?.path).toBe('afk interactive');
    expect(real.slash.has('/mem')).toBe(true);
  });
});

describe('docs refs: fenced slash command refs (spec #6)', () => {
  it('flags stale slash refs inside shell fences', () => {
    expect(check('```bash\n/modle sonnet\n```')).toEqual(['guides/x.mdx:2: slash /modle not found (did you mean /model?)']);
    expect(check('```sh\n/modle\n```')).toEqual(['guides/x.mdx:2: slash /modle not found (did you mean /model?)']);
    expect(check('```bash\nafk chat\n/modle\n```')).toHaveLength(1);
  });
  it('accepts valid slash refs inside shell fences', () => {
    expect(check('```bash\n/model sonnet\n/model\n```')).toEqual([]);
  });
  it('does not false-positive on filesystem paths inside shell fences', () => {
    expect(check('```bash\ncat /tmp/out.txt\nls /usr/bin\n```')).toEqual([]);
  });
  it('does not flag slash refs inside non-shell fences (e.g. json)', () => {
    expect(check('```json\n{"cmd": "/modle"}\n```')).toEqual([]);
  });
  it('does not flag filesystem paths that look like slash commands in prose', () => {
    expect(check('Copy to `/tmp/out.txt` or `/usr/local/bin`.')).toEqual([]);
  });
});

describe('docs refs: slash refs in unlabeled and non-shell fences (spec #8)', () => {
  const bare = (text: string): string[] => check(text).map((f) => f.replace(/ \(did you mean .*\)$/, ''));
  it('flags stale slash refs in backtick spans inside unlabeled fences on afk-first lines', () => {
    // unlabeled fence, afk-first line with inline backtick span containing stale slash
    expect(bare('```\nafk chat `/modle`\n```')).toEqual(['guides/x.mdx:2: slash /modle not found']);
  });
  it('checks standalone slash invocations in unlabeled and tilde fences', () => {
    expect(bare('```\n/modle arg\n```')).toEqual(['guides/x.mdx:2: slash /modle not found']);
    expect(bare('~~~\n/modle arg\n~~~')).toEqual(['guides/x.mdx:2: slash /modle not found']);
    expect(bare('```text\n/modle arg\n```')).toEqual(['guides/x.mdx:2: slash /modle not found']);
  });
  it('does not flag stale slash refs in bare words on non-afk unlabeled fence lines', () => {
    // unlabeled fence, non-afk line — /modle is not checked
    expect(bare('```\necho /modle\n```')).toEqual([]);
  });
  it('flags stale slash refs in backtick spans inside text fences on afk-first lines', () => {
    expect(bare('```text\nafk chat `/modle`\n```')).toEqual(['guides/x.mdx:2: slash /modle not found']);
  });
  it('flags stale slash refs in backtick spans inside tilde fences on afk-first lines', () => {
    expect(bare('~~~\nafk chat `/modle`\n~~~')).toEqual(['guides/x.mdx:2: slash /modle not found']);
  });
  it('does not false-positive on bare /word path args in shell fences', () => {
    // cat /tmp/out.txt — /tmp is an FS root, not a slash command
    expect(bare('```bash\ncat /tmp/out.txt\n```')).toEqual([]);
    // ls /usr/bin — /usr is an FS root
    expect(bare('```bash\nls /usr/bin\n```')).toEqual([]);
    // a non-FS /word preceded by a shell command word is a path arg, not a slash ref
    expect(bare('```bash\ncat /model\n```')).toEqual([]);
  });
  it('flags bare /word slash ref at line start in shell fence after a separator', () => {
    // After a pipe separator, /modle at line start is a slash ref, not a path arg
    expect(bare('```bash\ntrue; /modle\n```')).toEqual(['guides/x.mdx:2: slash /modle not found']);
  });
  it('continuation line slash check works in shell fences', () => {
    // Multi-line continuation: inline span slash check fires at the line where the span appears (line 3)
    expect(bare('```bash\nafk chat \\\n  `/modle`\n```')).toEqual(['guides/x.mdx:3: slash /modle not found']);
  });
  it('retains known FS roots as non-slash in shell fences', () => {
    for (const root of ['/tmp', '/usr', '/etc', '/var', '/bin', '/opt', '/dev', '/home', '/proc', '/mnt', '/sbin']) {
      expect(bare(`\`\`\`bash\nls ${root}\n\`\`\``)).toEqual([]);
    }
  });
});

describe('docs refs: unknown nested subcommand without suggestion (spec #7)', () => {
  it('emits a finding for an unknown subcommand even when no near suggestion exists', () => {
    // 'afk schedule zzz' — 'zzz' is too distant from 'add' for a near match, but schedule has children
    const findings = check('```bash\nafk schedule zzz\n```');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^guides\/x\.mdx:2: command afk schedule zzz not found/);
  });
  it('still emits a near-match suggestion when one exists', () => {
    expect(check('`afk schedule aad`')).toEqual(['guides/x.mdx:1: command afk schedule aad not found (did you mean afk schedule add?)']);
  });
  it('does not emit a finding for a valid positional prompt at root', () => {
    expect(check('```bash\nafk fix the bug\n```')).toEqual([]);
  });
  it('does not emit a finding for a quoted word at a subcommand', () => {
    expect(check('```bash\nafk schedule "my task"\n```')).toEqual([]);
  });
});
