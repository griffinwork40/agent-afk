/**
 * Background-process envelopes at the inter-round boundary.
 *
 * Regression: a `bash run_in_background` job that settled MID-TURN sat in the
 * ProcessJobNotifier until the turn ended, then the auto-resume wake started a
 * whole extra model turn just to re-report an outcome the model had already
 * learned (it had waited on the pid and read the log), printing a duplicate
 * Done block. The fix drains process envelopes at the next tool-round boundary
 * of the running turn, behind the same human barrier as peer messages.
 *
 * Uses the real ProcessJobRegistry + ProcessJobNotifier and the real
 * anthropic-direct applyBeforeNextRound; the session and compositor are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AdmissionQueue } from '../../../agent/peer/admission-queue.js';
import { ProcessJobRegistry } from '../../../agent/shell-jobs/process-jobs.js';
import { applyBeforeNextRound } from '../../../agent/providers/anthropic-direct/loop/inter-round.js';
import { ProcessJobNotifier } from './process-job-notifier.js';
import { installPeerBoundary, setupPeerBoundary } from './loop-iteration.boundary.js';

let dir: string;
let reg: ProcessJobRegistry;
let notifier: ProcessJobNotifier;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-proc-boundary-'));
  reg = new ProcessJobRegistry({ logDir: dir, sweep: false, cancelGraceMs: 300, closeGraceMs: 200, reapGraceMs: 200 });
  notifier = new ProcessJobNotifier(reg);
});

afterEach(async () => {
  notifier.dispose();
  await reg.killAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession() {
  let callback: (() => string | undefined) | undefined;
  return {
    setBeforeNextRound: vi.fn((cb: (() => string | undefined) | undefined) => { callback = cb; }),
    invokeCallback: () => callback?.(),
  };
}

/** Peer notifier with nothing buffered (only what boundary.ts reads). */
function makeEmptyPeerNotifier(buffered: string[] = []) {
  return {
    hasPendingInjections: () => buffered.length > 0,
    peekEnvelopes: () => buffered.map((body, i) => ({
      envelope: { v: 1 as const, messageId: `m-${i}`, from: { id: `s-${i}` }, to: 'me', hop: 0, ts: new Date().toISOString(), body },
      sessionId: 'fake',
    })),
    consumeEnvelopes: (n: number) => { buffered.splice(0, n); return ''; },
    drainInjections: () => '',
  };
}

/** Minimal env: only PATH, which the shell needs to resolve built-ins. */
const MINIMAL_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };

async function settledJob(command = 'exit 0') {
  const job = reg.start({ command, env: MINIMAL_ENV });
  await reg.waitFor(job.id);
  return job;
}

describe('process envelopes at the inter-round boundary', () => {
  it('delivers a job that settled mid-turn inside the running turn, so turn end has nothing to wake for', async () => {
    const session = makeSession();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: makeEmptyPeerNotifier() as never,
      admissionQueue: new AdmissionQueue(),
      processJobNotifier: notifier,
    });
    // The settle fires onInjectable mid-turn; the real tryAutoResume no-ops
    // then (surface busy) and re-checks hasPendingInjections at turn end.
    const wake = vi.fn();
    notifier.onInjectable = wake;
    const job = await settledJob('exit 3');
    expect(wake).toHaveBeenCalledTimes(1);

    const steering = session.invokeCallback();
    expect(steering).toContain(`<background-process-result job="${job.id}" status="failed" exit_code="3"`);
    // Turn-end re-check: delivered in-turn, so no extra wake turn is needed.
    expect(notifier.hasPendingInjections()).toBe(false);
    // The human notice is independent of model delivery and still shows.
    expect(notifier.drainNotices()[0]).toContain(`${job.id} failed exit 3`);
  });

  it('the anthropic provider pushes the envelope as a fresh user turn after the tool_result batch', async () => {
    const session = makeSession();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: makeEmptyPeerNotifier() as never,
      admissionQueue: new AdmissionQueue(),
      processJobNotifier: notifier,
    });
    const job = await settledJob();
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'pid 123 has exited' }] },
    ];
    applyBeforeNextRound({ messages, traceWriter: undefined } as never, session.invokeCallback());
    expect(messages).toHaveLength(2);
    const pushed = messages[1] as { role: string; content: Array<{ type: string; text: string }> };
    expect(pushed.role).toBe('user');
    expect(pushed.content[0]?.text).toContain(`job="${job.id}" status="completed" exit_code="0"`);
  });

  it('a running job is not delivered; it arrives at the first boundary after it settles', async () => {
    const session = makeSession();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: makeEmptyPeerNotifier() as never,
      admissionQueue: new AdmissionQueue(),
      processJobNotifier: notifier,
    });
    // Sentinel-file handshake: the job polls until a file appears, so we
    // guarantee it is still running when the first boundary check fires — no
    // timing assumptions, no sleep-duration races on loaded runners.
    const sentinel = path.join(dir, 'sentinel-running');
    const job = reg.start({
      command: `while [ ! -f "${sentinel}" ]; do sleep 0.05; done`,
      env: MINIMAL_ENV,
    });
    // Job is still blocked → boundary delivers nothing.
    expect(session.invokeCallback()).toBeUndefined();
    // Unblock the job and wait for it to settle.
    fs.writeFileSync(sentinel, '');
    await reg.waitFor(job.id);
    expect(session.invokeCallback()).toContain(`job="${job.id}"`);
    expect(session.invokeCallback()).toBeUndefined();
  });

  it('the human barrier holds the envelope; it is not lost and is delivered once the barrier clears', async () => {
    const session = makeSession();
    let humanQueued = true;
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => ({ hasPendingSubmission: () => humanQueued }),
      peerNotifier: makeEmptyPeerNotifier() as never,
      admissionQueue: new AdmissionQueue(),
      processJobNotifier: notifier,
    });
    const job = await settledJob();
    expect(session.invokeCallback()).toBeUndefined();
    // Still buffered for the next-turn fallback (applyDeferPeers drains it).
    expect(notifier.hasPendingInjections()).toBe(true);
    humanQueued = false;
    expect(session.invokeCallback()).toContain(`job="${job.id}"`);
  });

  it('isQueuedHumanTurn also holds the envelope back', async () => {
    const session = makeSession();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: makeEmptyPeerNotifier() as never,
      admissionQueue: new AdmissionQueue(),
      isQueuedHumanTurn: () => true,
      processJobNotifier: notifier,
    });
    await settledJob();
    expect(session.invokeCallback()).toBeUndefined();
    expect(notifier.hasPendingInjections()).toBe(true);
  });

  it('process envelopes precede peer messages in one steering block', async () => {
    const session = makeSession();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: makeEmptyPeerNotifier(['peer says hi']) as never,
      admissionQueue: new AdmissionQueue(),
      processJobNotifier: notifier,
    });
    await settledJob();
    const steering = session.invokeCallback() ?? '';
    const procAt = steering.indexOf('<background-process-result');
    const peerAt = steering.indexOf('peer says hi');
    expect(procAt).toBeGreaterThanOrEqual(0);
    expect(peerAt).toBeGreaterThan(procAt);
  });

  it('setupPeerBoundary threads the process notifier into the installed callback', async () => {
    const session = makeSession();
    const ctx = { session: { current: session } } as never;
    const surface = { getCompositor: () => null } as never;
    setupPeerBoundary(ctx, surface, makeEmptyPeerNotifier() as never, () => false, notifier);
    const job = await settledJob();
    expect(session.invokeCallback()).toContain(`job="${job.id}"`);
  });
});
