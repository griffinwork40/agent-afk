/** Real StreamRenderer lifecycle fixtures, with deterministic events and no model calls.
 * The compositor is borrowed just as it is from the persistent input surface.
 * Completed scenarios dispose the renderer but leave that surface armed.
 * The live scenario deliberately stops BEFORE content/dispose: its captured final
 * frame is the pre-content frame, not a reconstruction from committed text alone.
 */
import { TerminalCompositor } from '../../src/cli/terminal-compositor.js';
import { StreamRenderer } from '../../src/cli/_lib/stream-renderer.js';
import type { Writer } from '../../src/cli/slash/types.js';
import type { PtyDriveCtx, PtyScenario, PtyExpect } from './scenarios.js';

const CONTENT_HUG = process.env['AFK_PTY_CONTENT_HUG'] === '1';
const settle = (ms = 60): Promise<void> => new Promise(r => setTimeout(r, ms));

function minimalScrollRegion(stdout: NodeJS.WriteStream) {
  return {
    withFullScrollRegion<T>(fn: () => T): T {
      stdout.write('\x1b[s\x1b[r\x1b[u');
      try { return fn(); } finally {
        stdout.write(`\x1b[s\x1b[1;${stdout.rows ?? 24}r\x1b[u`);
      }
    },
    getExtraRows(): number { return 0; },
  };
}
function plainWriter(stdout: NodeJS.WriteStream): Writer {
  const line = (text: string): void => { stdout.write(`${text}\n`); };
  return { line, raw: line, info: line, warn: line, error: line, success: line };
}
async function surface({ stdout, stdin }: PtyDriveCtx): Promise<TerminalCompositor> {
  const compositor = new TerminalCompositor({
    contentHug: CONTENT_HUG, stdout, stdin, onCancel: () => {},
    scrollRegion: minimalScrollRegion(stdout), anchorRow: 1,
  });
  await compositor.arm();
  return compositor;
}
function renderer(stdout: NodeJS.WriteStream, compositor: TerminalCompositor | undefined,
  name: string, purpose: string, args?: string, onCancel?: () => void): StreamRenderer {
  return new StreamRenderer({
    out: plainWriter(stdout), compositor, reducedMotion: true, captureMode: false,
    thinkingMode: 'off', skillIdentity: { name, purpose, arguments: args }, onCancel,
  });
}
function content(r: StreamRenderer, text: string): void {
  r.process({ type: 'chunk', chunk: { type: 'content', content: `${text}\n\n` } });
}
async function finish(r: StreamRenderer): Promise<void> {
  r.process({ type: 'done' });
  await r.dispose();
  await settle();
}
function scenario(description: string, drive: PtyScenario['drive'], expect: PtyExpect): PtyScenario {
  return { description, cols: 80, rows: 24, ref: 'stream-renderer.ts:arm/process/dispose', drive, expect };
}

export const SKILL_IDENTITY_SCENARIOS: Record<string, PtyScenario> = {
  'skill-identity-immediate': scenario('actual renderer commits identity before immediate content', async ctx => {
    const c = await surface(ctx);
    const r = renderer(ctx.stdout, c, 'review', 'IMMED_PURPOSE_REVIEW', 'src/foo.ts');
    await r.arm();
    for (let i = 0; i < 30; i++) content(r, `IMMED_CONTENT_${String(i).padStart(2, '0')}`);
    content(r, 'IMMED_DONE');
    await finish(r);
  }, {
    exactlyOnce: ['IMMED_PURPOSE_REVIEW', 'args: src/foo.ts', 'IMMED_DONE'],
    inScrollback: ['IMMED_PURPOSE_REVIEW'],
    order: [['IMMED_PURPOSE_REVIEW', 'IMMED_CONTENT_00'], ['IMMED_CONTENT_00', 'IMMED_DONE']],
  }),
  'skill-identity-delayed': scenario('arm precedes delayed first content', async ctx => {
    const c = await surface(ctx);
    const r = renderer(ctx.stdout, c, 'ship', 'DELAY_PURPOSE_SHIP');
    await r.arm();
    await settle(120);
    r.process({ type: 'progress', progress: { taskId: 'delay', description: 'DELAY_LIVE_ONLY', totalTokens: 0, toolUses: 0, durationMs: 120 } });
    await settle();
    content(r, 'DELAY_CONTENT');
    await finish(r);
  }, {
    exactlyOnce: ['DELAY_PURPOSE_SHIP', 'DELAY_CONTENT'], absent: ['DELAY_LIVE_ONLY'],
    order: [['DELAY_PURPOSE_SHIP', 'DELAY_CONTENT']],
  }),
  'skill-identity-live-before-content': scenario('snapshot actual armed pre-content overlay without dispose', async ctx => {
    const c = await surface(ctx);
    const r = renderer(ctx.stdout, c, 'review', 'LIVE_PURPOSE_REVIEW', 'live.ts');
    await r.arm();
    await settle(120);
    // No process(content), no dispose and no manual overlay injection.
  }, {
    // Intro and live banner coexist. The combined row distinguishes the live
    // banner from the separate purpose/args lines in the committed intro.
    inViewport: ['/review · LIVE_PURPOSE_REVIEW'],
    exactlyOnce: ['/review · LIVE_PURPOSE_REVIEW'], absent: ['LIVE_CONTENT'],
  }),
  'skill-identity-cancelled': scenario('soft-stop after arm retains intro once and removes live overlay', async ctx => {
    const c = await surface(ctx);
    const r = renderer(ctx.stdout, c, 'diagnose', 'SOFT_CANCEL_PURPOSE');
    await r.arm();
    r.setSoftStopping(true);
    await settle();
    await r.dispose();
    await settle();
  }, { exactlyOnce: ['SOFT_CANCEL_PURPOSE'], absent: ['stopping…', '/diagnose · SOFT_CANCEL_PURPOSE'] }),
  // Known runtime defect, kept as an expected-failure regression in the suite:
  // dispose clears softStopping, but not interrupting, before its final flush.
  'skill-identity-interrupt-regression': scenario('Ctrl+C affordance should clear on dispose (known defect)', async ctx => {
    const c = await surface(ctx);
    let cancelled = false;
    const r = renderer(ctx.stdout, c, 'diagnose', 'CANCEL_PURPOSE', undefined, () => {
      cancelled = true;
      r.setInterrupting(true);
    });
    await r.arm();
    // Invoke the real borrowed-compositor callback; no model or session needed.
    c.getOnCancel()?.();
    if (!cancelled) throw new Error('renderer cancel callback was not installed');
    await settle();
    await r.dispose();
    await settle();
  }, { exactlyOnce: ['CANCEL_PURPOSE'], absent: ['interrupting', 'stopping…', '/diagnose · CANCEL_PURPOSE'] }),
  'skill-identity-back-to-back': scenario('two actual renderer lifetimes share the persistent surface', async ctx => {
    const c = await surface(ctx);
    const first = renderer(ctx.stdout, c, 'mint', 'B2B_SKILL_ONE');
    await first.arm();
    content(first, 'B2B_CONTENT_ONE');
    await finish(first);
    const second = renderer(ctx.stdout, c, 'ship', 'B2B_SKILL_TWO');
    await second.arm();
    content(second, 'B2B_CONTENT_TWO');
    await finish(second);
  }, {
    exactlyOnce: ['B2B_SKILL_ONE', 'B2B_SKILL_TWO', 'B2B_CONTENT_ONE', 'B2B_CONTENT_TWO'],
    order: [['B2B_SKILL_ONE', 'B2B_CONTENT_ONE'], ['B2B_CONTENT_ONE', 'B2B_SKILL_TWO'], ['B2B_SKILL_TWO', 'B2B_CONTENT_TWO']],
  }),
  'skill-identity-nested': scenario('nested renderer lifetimes with outer resume and teardown', async ctx => {
    const c = await surface(ctx);
    const outer = renderer(ctx.stdout, c, 'forge', 'NEST_OUTER_FORGE');
    await outer.arm();
    content(outer, 'NEST_OUTER_CONTENT');
    await settle();
    const inner = renderer(ctx.stdout, c, 'qualify', 'NEST_INNER_QUALIFY');
    await inner.arm();
    content(inner, 'NEST_INNER_CONTENT');
    await finish(inner);
    content(outer, 'NEST_OUTER_RESUMED');
    await finish(outer);
  }, {
    exactlyOnce: ['NEST_OUTER_FORGE', 'NEST_INNER_QUALIFY', 'NEST_OUTER_CONTENT', 'NEST_INNER_CONTENT', 'NEST_OUTER_RESUMED'],
    order: [['NEST_OUTER_FORGE', 'NEST_OUTER_CONTENT'], ['NEST_OUTER_CONTENT', 'NEST_INNER_QUALIFY'], ['NEST_INNER_QUALIFY', 'NEST_INNER_CONTENT'], ['NEST_INNER_CONTENT', 'NEST_OUTER_RESUMED']],
  }),
};

/** Run only with genuine stdio pipes: no forced TTY flag and no compositor. */
export async function drivePipedIdentity(stdout: NodeJS.WriteStream): Promise<void> {
  if (stdout.isTTY) throw new Error('piped fixture requires actual non-TTY stdout');
  const r = renderer(stdout, undefined, 'diagnose', 'PIPE_PURPOSE_DIAGNOSE', 'auth module');
  await r.arm();
  content(r, 'PIPE_CONTENT');
  await finish(r);
}
export type { PtyScenario, PtyExpect };
