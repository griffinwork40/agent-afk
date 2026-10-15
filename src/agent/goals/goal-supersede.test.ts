/**
 * Scenario 3 — #3714 failure-injection suite:
 * "Operator changes the goal while workers are running"
 *
 * Defect being pinned
 * -------------------
 * A session's goalPrompt is baked at construction time (inject.ts calls
 * injectGoalPrompt once; goal-store.ts comment at lines 50-55 documents
 * this explicitly). When the operator sets a new goal while a background
 * worker is running, `buildBgResultInjection` (bg-result-notifier.ts) later
 * delivers the worker's result with no awareness that the goal changed.
 * Nothing in the delivery path (BgResultNotifier, BackgroundAgentRegistry,
 * or src/agent/outcomes/) compares the goal at worker-start time to the goal
 * at result-delivery time, so there is no `superseded` annotation on the
 * injected envelope.
 *
 * Test strategy
 * -------------
 * Use real module seams without any model calls or network:
 *   • goal-store: real module with a temp SQLite DB (pattern from
 *     goal-store.test.ts) — records goal A at worker start, goal B at finish.
 *   • BgResultNotifier: driven end-to-end via a stub BackgroundAgentRegistry
 *     (EventEmitter with a markDelivered no-op), emitting a `settled` event
 *     so onSettled → drainInjections() exercises the real delivery path.
 *   • All scheduling is synchronous (deferred promises resolved inline).
 *
 * The test uses `it.fails` to assert the MISSING behavior so the suite stays
 * green today and flips automatically when the supersede feature is
 * implemented inside BgResultNotifier / the delivery path.
 *
 * Refs: #3714
 */

import type { BackgroundJob } from '../background-registry.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Temp DB for goal-store singleton ─────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

type GoalStoreModule = typeof import('./goal-store.js');
let goalStore: GoalStoreModule;

vi.mock('../../paths.js', () => ({
  getStateDatabasePath: () => dbPath,
}));

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goal-supersede-test-'));
  dbPath = join(tmpDir, 'test.db');
  vi.resetModules();
  goalStore = await import('./goal-store.js');
});

afterEach(() => {
  goalStore.closeStore();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal stub BackgroundJob sufficient for buildBgResultInjection.
 * No real registry or handle needed — the delivery path only reads job fields.
 */
function makeStubJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: 'job-scenario3-001',
    provenance: 'model',
    subagentId: 'sub-001',
    label: 'refactor the auth module',
    model: 'claude-opus-stub',
    startedAt: Date.now() - 5000,
    status: 'completed',
    endedAt: Date.now(),
    result: {
      id: 'sub-001',
      status: 'succeeded',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Refactor complete — auth module is clean.' }],
      },
    },
    parentSessionId: 'parent-session-001',
    lastActivityAt: Date.now(),
    ...overrides,
  } as BackgroundJob;
}

/**
 * Minimal stub registry that satisfies BgResultNotifier's constructor and
 * drainInjections() call signature.  Extends EventEmitter so we can emit
 * 'settled' synchronously in tests.
 */
function makeStubRegistry() {
  const emitter = new EventEmitter() as EventEmitter & {
    markDelivered: (jobId: string) => void;
  };
  emitter.markDelivered = (_jobId: string) => { /* no-op in tests */ };
  return emitter;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Scenario 3 (#3714): goal change while worker runs', () => {
  /**
   * Determinism check: the goal-store correctly records goal A then goal B.
   * This is NOT the defect — it verifies the precondition (store works).
   */
  it('records goal A at worker start and goal B after operator change', () => {
    // Worker starts under goal A
    goalStore.setGoal('refactor the auth module', 'parent-session-001');
    const goalAtStart = goalStore.getGoal();
    expect(goalAtStart?.text).toBe('refactor the auth module');
    expect(goalAtStart?.status).toBe('active');

    // Operator changes the goal while worker is running
    goalStore.setGoal('migrate the database schema', 'parent-session-001');
    const goalAtDelivery = goalStore.getGoal();
    expect(goalAtDelivery?.text).toBe('migrate the database schema');

    // Goal A is fully replaced — no trace of it in the store
    expect(goalAtDelivery?.text).not.toBe('refactor the auth module');
  });

  /**
   * Determinism check: the goalPrompt baked at worker-start time does NOT
   * reflect the later goal change. This documents the fixed-at-construction
   * invariant from inject.ts / goal-store.ts:50-55.
   */
  it('goalPrompt baked at worker start stays frozen while store advances', async () => {
    // Simulate what injectGoalPrompt does at session construction time
    goalStore.setGoal('refactor the auth module', 'parent-session-001');
    const { buildGoalPromptFragment } = await import('./goal-prompt.js');
    const bakedPrompt = buildGoalPromptFragment(); // snapshot at construction

    // Operator changes goal mid-flight
    goalStore.setGoal('migrate the database schema', 'parent-session-001');

    // The baked prompt is immutable — it still references goal A
    expect(bakedPrompt).toContain('refactor the auth module');
    expect(bakedPrompt).not.toContain('migrate the database schema');

    // The LIVE store now has goal B
    const livePrompt = buildGoalPromptFragment();
    expect(livePrompt).toContain('migrate the database schema');
  });

  /**
   * DEFECT PIN (#3714, Scenario 3) — uses it.fails.
   *
   * When the operator changes the goal after a worker starts but before it
   * finishes, the delivered result envelope should be annotated as superseded
   * so the model understands the result is no longer relevant to the current
   * objective.
   *
   * Driven end-to-end through BgResultNotifier: stub registry emits 'settled'
   * → onSettled buffers the job → drainInjections() calls
   * buildBgResultInjection(). This is the real delivery path where goal-epoch
   * comparison must be added; the assertion flips green once that logic lands.
   *
   * Current behavior: BgResultNotifier has no goal-epoch awareness and emits a
   * plain completion envelope with no superseded marker.
   *
   * Expected behavior (once fixed): the envelope should include a
   * `superseded="true"` attribute (or equivalent) when the goal at delivery
   * time differs from the goal at worker-dispatch time.
   */
  it.fails(
    'delivered result is marked superseded when the goal changed while the worker ran',
    async () => {
      const { BgResultNotifier } = await import(
        '../../cli/commands/interactive/bg-result-notifier.js'
      );

      const registry = makeStubRegistry();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const notifier = new BgResultNotifier(registry as any);

      // Record goal A at worker dispatch
      goalStore.setGoal('refactor the auth module', 'parent-session-001');
      const goalTextAtDispatch = goalStore.getGoal()!.text;

      // Operator changes goal while worker is running
      goalStore.setGoal('migrate the database schema', 'parent-session-001');
      const goalTextAtDelivery = goalStore.getGoal()!.text;

      // The two goals must actually differ (precondition)
      expect(goalTextAtDispatch).not.toBe(goalTextAtDelivery);

      // Simulate the worker settling — triggers onSettled → buffers injection
      const job = makeStubJob();
      registry.emit('settled', job);

      // Drain the injection envelope (the real delivery path)
      const envelope = notifier.drainInjections();

      // DEFECT: today BgResultNotifier has no goal-epoch awareness, so
      // the envelope contains neither a superseded attribute nor any
      // indication that the result is stale relative to the current goal.
      // This assertion FAILS today (hence it.fails) and will pass once the
      // supersede feature is implemented in the delivery path.
      expect(envelope).toContain('superseded="true"');
    },
  );

  /**
   * Control case: when the goal does NOT change between dispatch and delivery,
   * the envelope must NOT carry a superseded marker.
   *
   * An implementation that marks every result as superseded regardless of
   * goal change would fail this case.
   */
  it('delivered result is NOT marked superseded when the goal was unchanged', async () => {
    const { BgResultNotifier } = await import(
      '../../cli/commands/interactive/bg-result-notifier.js'
    );

    const registry = makeStubRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifier = new BgResultNotifier(registry as any);

    // Goal is set once and never changed — same at dispatch and delivery
    goalStore.setGoal('refactor the auth module', 'parent-session-001');

    const job = makeStubJob();
    registry.emit('settled', job);

    const envelope = notifier.drainInjections();

    // Well-formed result envelope
    expect(envelope).toContain('<background-subagent-result');
    expect(envelope).toContain('status="completed"');
    expect(envelope).toContain('</background-subagent-result>');

    // No superseded annotation — goals matched, result is still relevant
    expect(envelope).not.toContain('superseded');
  });

  /**
   * Current behavior assertion (positive, non-it.fails):
   * Verifies that BgResultNotifier today emits an ordinary completion
   * envelope with no superseded marker — documenting the status quo so any
   * accidental partial fix is caught.
   */
  it('BgResultNotifier currently emits no superseded marker (status-quo pin)', async () => {
    const { BgResultNotifier } = await import(
      '../../cli/commands/interactive/bg-result-notifier.js'
    );

    const registry = makeStubRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifier = new BgResultNotifier(registry as any);

    // Goal changes between dispatch and delivery
    goalStore.setGoal('refactor the auth module', 'parent-session-001');
    goalStore.setGoal('migrate the database schema', 'parent-session-001');

    const job = makeStubJob();
    registry.emit('settled', job);

    const envelope = notifier.drainInjections();

    // Envelope is a well-formed background-subagent-result block
    expect(envelope).toContain('<background-subagent-result');
    expect(envelope).toContain('status="completed"');
    expect(envelope).toContain('</background-subagent-result>');

    // NO superseded annotation — this is the current (defective) behavior.
    // Remove this assertion when the feature lands.
    expect(envelope).not.toContain('superseded');
  });
});
