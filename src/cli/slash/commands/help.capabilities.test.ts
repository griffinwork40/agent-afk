import { describe, expect, it, vi } from 'vitest';
import { coreCommands } from './core.js';
import { createConsoleWriter } from '../writer.js';
import { createSessionStats } from '../session-stats.js';
import { webCapabilities, telegramCapabilities } from '../capabilities.js';
import type { SlashContext, SurfaceCapability } from '../types.js';

vi.mock('../registry.js', () => ({ list: () => [
  { name: '/cost', summary: 'Show cost' },
  { name: '/editor', summary: 'Open $EDITOR' },
  { name: '/keys', summary: 'Keybindings' },
] }));

const help = coreCommands.find((c) => c.name === '/help')!;

async function run(capabilities?: ReadonlySet<SurfaceCapability>): Promise<string> {
  let output = '';
  const ctx = {
    stats: createSessionStats('sonnet'),
    session: { current: {} },
    out: createConsoleWriter({ fn: (line) => { output += `${line}\n`; }, rawFn: (t) => { output += t; } }),
    ...(capabilities ? { capabilities } : {}),
  } as unknown as SlashContext;
  await help.handler(ctx, '');
  return output;
}

describe('/help respects surface capabilities', () => {
  it('REPL (no declared capabilities) lists everything, with terminal tips', async () => {
    const out = await run();
    expect(out).toContain('/editor');
    expect(out).toContain('/keys');
    expect(out).toContain('Ctrl+C');
  });

  it.each([['web', webCapabilities()], ['telegram', telegramCapabilities()]] as const)(
    '%s lists only runnable commands and drops terminal-only tips',
    async (_surface, caps) => {
      const out = await run(caps);
      expect(out).toContain('/cost');
      expect(out).not.toContain('/editor');
      expect(out).not.toContain('/keys');
      expect(out).not.toContain('Ctrl+C');
    },
  );
});
