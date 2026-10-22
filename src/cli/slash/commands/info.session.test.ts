import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { infoCmd } from './info.session.js';
import { infoCommands } from './info.js';
import { createSessionStats } from '../session-stats.js';
import { createConsoleWriter } from '../writer.js';
import { BufferingWriter } from '../../../web-server/writer.buffer.js';
import type { SlashContext } from '../types.js';

const initialLevel = chalk.level;
afterEach(() => { chalk.level = initialLevel; });

function fixture() {
  let bytes = '';
  const stats = Object.assign(createSessionStats('sonnet'), {
    sessionId: 'session-123', name: 'example', permissionMode: 'plan' as const,
    totalTurns: 2, totalCostUsd: 0.25, unpricedTurns: 1, totalTokens: 1500,
    turnTokens: [{ input: 1000, output: 500, cache: 9000, footprint: 12000 }],
    cwd: '/repo',
  });
  const ctx = {
    stats,
    // Any accidental provider access fails, including initialization and context calls.
    session: new Proxy({}, { get: () => { throw new Error('Must read only local stats'); } }),
    out: createConsoleWriter({ fn: (line) => { bytes += `${line}\n`; } }),
    ui: { repaintStatusLine: vi.fn(), clearScreen: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, bytes: () => bytes };
}

const entries = [
  { key: 'Session', value: 'session-123' },
  { key: 'Name', value: 'example' },
  { key: 'Model', value: 'sonnet' },
  { key: 'Permission mode', value: 'plan' },
  { key: 'Turns', value: '2' },
  { key: 'Recorded cost', value: '$0.25' },
  { key: 'Unpriced turns', value: '1' },
  { key: 'Recorded tokens', value: '1.5k' },
  { key: 'Context (last turn)', value: '12k tokens' },
  { key: 'Directory', value: '/repo' },
];

describe('/info (new command; no preexisting console snapshot)', () => {
  it('is included in the registered info command family', () => {
    expect(infoCommands.filter((cmd) => cmd.name === '/info')).toEqual([infoCmd]);
  });

  it('renders exact plain console output without modifying stats or initializing SDK', async () => {
    chalk.level = 0;
    const { ctx, bytes } = fixture();
    const before = structuredClone(ctx.stats);
    expect(await infoCmd.handler(ctx, '')).toBe('continue');
    expect(bytes()).toBe('\nSession info\n'
      + '  Session             session-123\n'
      + '  Name                example\n'
      + '  Model               sonnet\n'
      + '  Permission mode     plan\n'
      + '  Turns               2\n'
      + '  Recorded cost       $0.25\n'
      + '  Unpriced turns      1\n'
      + '  Recorded tokens     1.5k\n'
      + '  Context (last turn) 12k tokens\n'
      + '  Directory           /repo\n\n');
    expect(ctx.stats).toEqual(before);
    expect(ctx.ui.repaintStatusLine).not.toHaveBeenCalled();
  });

  it('emits the factual fields as one key-value block via the web writer', async () => {
    const { ctx, bytes } = fixture();
    const writer = new BufferingWriter();
    ctx.out = writer.asWriterInterface();
    await infoCmd.handler(ctx, '');
    expect(writer.toOutputBlocks()).toEqual([{
      kind: 'keyValue', title: 'Session info', entries,
      text: 'Session info\n' + entries.map(({ key, value }) => `${key}: ${value}\n`).join(''),
      ansi: 'Session info\n' + entries.map(({ key, value }) => `${key}: ${value}\n`).join(''),
    }]);
    expect(bytes()).toBe('');
  });

  it('does not invent identity or context occupancy before a reported turn', async () => {
    const { ctx } = fixture();
    ctx.stats = createSessionStats('sonnet');
    const writer = new BufferingWriter();
    ctx.out = writer.asWriterInterface();
    await infoCmd.handler(ctx, '');
    expect(writer.toOutputBlocks()[0]).toMatchObject({ entries: expect.arrayContaining([
      { key: 'Session', value: 'Not assigned' }, { key: 'Name', value: 'Unnamed' },
      { key: 'Context (last turn)', value: 'Not reported' },
    ]) });
  });
});
