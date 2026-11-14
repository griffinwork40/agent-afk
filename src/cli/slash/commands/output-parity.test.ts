import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as usageModule from '../../commands/usage.js';
import * as sessionControl from '../../../agent/session-control/index.js';
import { runSweep } from '../../../agent/worktree/worktree-sweep.js';
import { readOauthPending } from '../../../agent/mcp/oauth.js';
import { infoCommands } from './info.js';
import { coreCommands } from './core.js';
import { diffCmd } from './diff.js';
import { worktreeCmd } from './worktree.js';
import { createConsoleWriter } from '../writer.js';
import { createSessionStats } from '../session-stats.js';
import type { SlashContext } from '../types.js';
import type { OutputBlock } from '../output-blocks.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}));
vi.mock('../../commands/usage.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../commands/usage.js')>(),
  collectUsageSummary: vi.fn(),
}));
vi.mock('../../../agent/worktree/worktree-sweep.js', () => ({ runSweep: vi.fn() }));
vi.mock('../../../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utils/git.js')>(),
  resolveRepoRoot: vi.fn().mockResolvedValue('/repo'),
}));
vi.mock('../../../agent/mcp/oauth.js', () => ({ readOauthPending: vi.fn() }));
vi.mock('../registry.js', () => ({ list: () => [
  { name: '/help', summary: 'Show this help' },
  { name: '/tokens', summary: 'Token usage' },
  { name: '/diff', usage: '/diff [file]', summary: 'Show changes' },
] }));

const sdkUsage = {
  totalTokens: 12000, maxTokens: 200000, percentage: 6,
  autoCompactThreshold: 180000, isAutoCompactEnabled: true,
  apiUsage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000 },
  categories: [{ name: 'history', tokens: 9000 }, { name: 'system', tokens: 3000 }],
  systemTools: [{ name: 'read_file', tokens: 100 }], mcpTools: [{ name: 'search', tokens: 200 }],
  agents: [{ name: 'worker', tokens: 300 }],
  skills: { includedSkills: 2, totalSkills: 3, tokens: 400 },
  slashCommands: { includedCommands: 4, totalCommands: 5, tokens: 500 },
};
const rawDiff = 'diff --git a/a.ts b/a.ts\nindex 123..456 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n';
const cases = ['usage', 'usage-empty', 'usage-unavailable', 'tokens-sdk', 'tokens-local', 'mcp', 'mcp-auth', 'diff', 'worktree', 'help'] as const;
const initialLevel = chalk.level;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(180000);
  vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({ pid: process.pid }));
  vi.mocked(usageModule.collectUsageSummary).mockResolvedValue({
    asOfMs: 180000,
    providers: [{
      provider: 'anthropic', account: 'oauth', status: 'ok', ageMs: 0,
      fiveHour: { utilization: 0.42, utilizationPct: 42 },
      sevenDay: { utilization: 0.1, utilizationPct: 10 },
    }],
  } as never);
  vi.mocked(execFileSync).mockReturnValue(rawDiff);
  vi.mocked(readOauthPending).mockReturnValue({ browser: { authorizationUrl: 'https://example.test/oauth', timestamp: 60000 } } as never);
  vi.mocked(runSweep).mockResolvedValue({ candidates: [
    { path: '/repo/.afk-worktrees/topic', owner: 'interactive', verdict: 'active', ageMs: 60000 },
    { path: '/repo/.afk-worktrees/old', owner: 'diagnose', verdict: 'stale-clean', ageMs: 86400000 },
  ], warnings: [], removed: [], dryRun: true } as never);
});
afterEach(() => { chalk.level = initialLevel; vi.restoreAllMocks(); });

function context(): { ctx: SlashContext; bytes: () => string } {
  let output = '';
  const stats = createSessionStats('sonnet');
  stats.turnTokens = [{ input: 1000, output: 500, cache: 9000 }];
  return { ctx: {
    stats,
    session: { current: {
      getContextUsage: vi.fn().mockResolvedValue(sdkUsage),
      waitForInitialization: vi.fn().mockResolvedValue({ mcpServers: [
        { name: 'search', status: 'connected' }, { name: 'browser', status: 'oauth_pending' }, 'legacy',
      ] }),
    } },
    out: createConsoleWriter({ fn: (line) => { output += `${line}\n`; }, rawFn: (text) => { output += text; } }),
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext, bytes: () => output };
}

// Golden snapshots captured BEFORE Stage2 migration against 4766e627f. During
// Stage1 fan-in, core/info/info.mcp receipts were advanced verbatim to Stage1
// 848207a334c63f31f154ddcce8fce44b9c9bb076 (pre-structured migration). Its canonical
// controls/read services intentionally replace inline logic, while these read/help
// console scenarios retain the same bytes. No snapshots were regenerated at fan-in.
// Original source receipts are in __fixtures__/stage2-original; diff/worktree stay
// at 4766e627f. Both modes exercise production Writer; ANSI bytes are not stripped.
describe.each([0, 1] as const)('original console bytes (color=%i)', (level) => {
  it.each(cases)('%s', async (scenario) => {
    chalk.level = level;
    const { ctx, bytes } = context();
    if (scenario === 'usage-empty') vi.mocked(usageModule.collectUsageSummary).mockResolvedValue({ asOfMs: 180000, providers: [] } as never);
    if (scenario === 'usage-unavailable') vi.mocked(usageModule.collectUsageSummary).mockResolvedValue({
      asOfMs: 180000,
      providers: [{ provider: 'anthropic', account: 'oauth', status: 'error', errorDetail: 'No token' }],
    } as never);
    if (scenario === 'tokens-local') vi.mocked(ctx.session.current.getContextUsage).mockRejectedValue(new Error('offline'));
    const name = scenario.startsWith('tokens-') ? '/tokens' : scenario.startsWith('usage') ? '/usage' : scenario.startsWith('mcp') ? '/mcp' : `/${scenario}`;
    const command = [...infoCommands, ...coreCommands, diffCmd, worktreeCmd].find((cmd) => cmd.name === name)!;
    await command.handler(ctx, scenario === 'mcp-auth' ? 'auth' : scenario === 'worktree' ? 'list' : '');
    if (level === 1) expect(bytes()).toContain('\u001b[');
    expect(bytes()).toMatchSnapshot();
  });
});

describe('Stage1 canonical read services survive structured migration', () => {
  it('/usage renders the multi-provider collectUsageSummary result', async () => {
    vi.mocked(usageModule.collectUsageSummary).mockResolvedValue({
      asOfMs: 180000,
      providers: [{
        provider: 'anthropic', account: 'oauth', status: 'ok', ageMs: 0,
        fiveHour: { utilization: 0.73, utilizationPct: 73 },
      }],
    } as never);
    const { ctx } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/usage')!.handler(ctx, '');
    expect(usageModule.collectUsageSummary).toHaveBeenCalledOnce();
    expect(blocks[0]).toMatchObject({ kind: 'keyValue', entries: expect.arrayContaining([{ key: 'anthropic / oauth', value: 'ok' }]) });
  });

  it('/tokens renders the canonical local DTO rather than recalculating stats', async () => {
    const read = vi.spyOn(sessionControl, 'readTokenUsage').mockResolvedValue({
      kind: 'local', input: 2000, output: 500, cache: 9000, total: 2500,
      contextUsed: 17000, contextLimit: 100000, percentage: 17, model: 'haiku',
    });
    const { ctx } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/tokens')!.handler(ctx, '');
    expect(read).toHaveBeenCalledExactlyOnceWith(ctx.session.current, ctx.stats);
    expect(ctx.session.current.getContextUsage).not.toHaveBeenCalled();
    expect(blocks[0]).toMatchObject({ kind: 'keyValue', entries: expect.arrayContaining([
      { key: 'input', value: '2k' }, { key: 'total', value: '2.5k' },
      { key: 'context', value: '17% of 100k  (haiku)' },
    ]) });
  });

  it('/mcp renders the canonical server reader result', async () => {
    const read = vi.spyOn(sessionControl, 'readMcpStatus').mockResolvedValue([
      { name: 'canonical-server', status: 'connected' },
    ] as never);
    const { ctx } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/mcp')!.handler(ctx, '');
    expect(read).toHaveBeenCalledExactlyOnceWith(ctx.session.current);
    expect(ctx.session.current.waitForInitialization).not.toHaveBeenCalled();
    expect(blocks[0]).toMatchObject({ kind: 'table', rows: [['canonical-server', 'connected']] });
  });

  it('/mcp auth renders canonical pending OAuth links', async () => {
    const read = vi.spyOn(sessionControl, 'readMcpOauthPending').mockResolvedValue({
      canonical: { authorizationUrl: 'https://example.test/canonical', timestamp: 60000 },
    } as never);
    const { ctx } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/mcp')!.handler(ctx, 'auth');
    expect(read).toHaveBeenCalledOnce();
    expect(blocks[0]).toMatchObject({ kind: 'link', label: 'Authorize canonical', url: 'https://example.test/canonical' });
  });
});

describe('structured command output uses source data', () => {
  it.each([
    ['/usage', '', 'keyValue'], ['/tokens', '', 'keyValue'], ['/mcp', '', 'table'],
    ['/mcp', 'auth', 'link'], ['/diff', 'a.ts', 'diff'], ['/worktree', 'list', 'table'], ['/help', '', 'list'],
  ] as const)('%s %s emits %s', async (name, args, kind) => {
    const { ctx, bytes } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    const command = [...infoCommands, ...coreCommands, diffCmd, worktreeCmd].find((cmd) => cmd.name === name)!;
    await command.handler(ctx, args);
    expect(blocks.some((block) => block.kind === kind)).toBe(true);
    for (const block of blocks) {
      expect(typeof block.text).toBe('string');
      expect(typeof block.ansi).toBe('string');
      expect(block.text).not.toContain('\u001b[');
    }
    if (name === '/usage') expect(blocks[0]).toMatchObject({ kind: 'keyValue', entries: expect.arrayContaining([{ key: 'anthropic / oauth', value: 'ok' }]) });
    if (name === '/tokens') {
      expect(blocks.map((block) => block.kind)).toEqual(['keyValue', 'keyValue', 'table', 'keyValue']);
      expect(blocks[2]).toMatchObject({ rows: [['history', '9k'], ['system', '3k']] });
    }
    if (name === '/mcp' && !args) expect(blocks[0]).toMatchObject({ rows: [['search', 'connected'], ['browser', 'oauth_pending'], ['legacy', '']] });
    if (kind === 'link') expect(blocks[0]).toMatchObject({ url: 'https://example.test/oauth', label: 'Authorize browser' });
    if (kind === 'diff') {
      expect(blocks[0]).toMatchObject({ kind: 'keyValue', title: 'Uncommitted changes', entries: [
        { key: 'Path', value: 'a.ts' }, { key: 'Files', value: '1' },
        { key: 'Additions', value: '1' }, { key: 'Deletions', value: '1' },
      ] });
      expect(blocks[1]).toMatchObject({ diff: rawDiff, fileName: 'a.ts' });
      expect(bytes()).toBe('');
    }
    if (name === '/worktree') expect(blocks[0]).toMatchObject({ rows: [
      ['/repo/.afk-worktrees/topic', 'interactive', '1h', 'active', 'no', 'yes'],
      ['/repo/.afk-worktrees/old', 'diagnose', '1d', 'stale-clean', 'warn', 'yes'],
    ] });
    if (name === '/help') expect(blocks[0]).toMatchObject({ items: [
      { text: '/help', description: 'Show this help' }, { text: '/tokens', description: 'Token usage' },
      { text: '/diff [file]', description: 'Show changes' },
    ] });
  });

  it('preserves the empty usage explanation on structured surfaces', async () => {
    vi.mocked(usageModule.collectUsageSummary).mockResolvedValue({ asOfMs: 180000, providers: [] } as never);
    const { ctx } = context();
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/usage')!.handler(ctx, '');
    expect(blocks[0]).toMatchObject({ kind: 'keyValue', entries: [
      { key: 'Status', value: 'No providers found.' },
    ] });
  });

  it('local token fallback also emits structured values', async () => {
    const { ctx } = context();
    vi.mocked(ctx.session.current.getContextUsage).mockRejectedValue(new Error('offline'));
    const blocks: OutputBlock[] = [];
    ctx.out.block = (block) => { blocks.push(block); };
    await infoCommands.find((cmd) => cmd.name === '/tokens')!.handler(ctx, '');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'keyValue', entries: expect.arrayContaining([{ key: 'total', value: '1.5k' }]) });
  });
});
