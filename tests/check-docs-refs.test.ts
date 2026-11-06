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
