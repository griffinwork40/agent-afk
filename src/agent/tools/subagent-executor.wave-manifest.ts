/**
 * Wave-manifest tracking concern extracted from SubagentExecutor.
 *
 * Manages the per-wave state (waveId + callId set) used by SubagentExecutor to
 * write structured wave manifests for root-level parallel agent batches.
 *
 * @module agent/tools/subagent-executor.wave-manifest
 */

import { buildWaveUnit, createManifest, updateWaveUnit } from '../manifest/write.js';
import { parseAgentInput } from './subagent/input-parse.js';
import { env } from '../../config/env.js';
import type { ToolCall } from './types.js';

export class WaveManifestTracker {
  private currentWaveId: string | undefined = undefined;
  private currentWaveCallIds: Set<string> = new Set();

  /**
   * Called BEFORE a parallel batch of ≥2 agent tool calls starts.
   * Creates a wave manifest with all units in 'pending' status.
   * Fire-and-forget: never throws.
   *
   * @param calls        The parallel ToolCall batch.
   * @param sessionId    Parent session id stamped on the manifest.
   * @param traceLabel   Trace label (nullable) stamped on the manifest.
   * @param depth        Executor nesting depth — only depth-0 writes manifests.
   * @param currentCwd   Current working directory used as cwd fallback.
   */
  notifyWaveStart(
    calls: ReadonlyArray<ToolCall>,
    sessionId: string,
    traceLabel: string | null,
    depth: number,
    currentCwd: string | undefined,
  ): void {
    if (env.AFK_WAVE_MANIFEST_DISABLED === '1') return;
    if (calls.length < 2) return;
    // Only root-level sessions write manifests (depth === 0).
    if (depth !== 0) return;
    try {
      const units = calls.map((call) => {
        let parsed: { prompt: string; model?: string; cwd?: string } | undefined;
        try {
          parsed = parseAgentInput(call.input);
        } catch {
          parsed = undefined;
        }
        const prompt = parsed?.prompt ?? '';
        const model = parsed?.model ?? 'sonnet';
        const cwd = parsed?.cwd ?? currentCwd;
        return buildWaveUnit({ id: call.id, prompt, cwd, model });
      });
      const waveId = createManifest({
        source: 'agent-tool',
        parentSessionId: sessionId,
        traceLabel,
        units,
      });
      if (waveId !== undefined) {
        this.currentWaveId = waveId;
        this.currentWaveCallIds = new Set(calls.map((c) => c.id));
      }
    } catch {
      // Fire-and-forget: manifest errors must never abort a wave.
    }
  }

  /**
   * Called AFTER all units in a parallel batch have settled. Clears wave state.
   */
  notifyWaveEnd(): void {
    this.currentWaveId = undefined;
    this.currentWaveCallIds = new Set();
  }

  /**
   * Update a unit's status in the current wave manifest. No-op when no wave
   * is active or the call is not part of the current wave.
   * Fire-and-forget: never throws.
   */
  updateUnit(
    callId: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
    cwd?: string,
  ): void {
    const waveId = this.currentWaveId;
    if (waveId === undefined) return;
    if (!this.currentWaveCallIds.has(callId)) return;
    const extra: { errorMessage?: string; cwd?: string } | undefined =
      error !== undefined || cwd !== undefined
        ? { ...(error !== undefined ? { errorMessage: error } : {}), ...(cwd !== undefined ? { cwd } : {}) }
        : undefined;
    updateWaveUnit(waveId, callId, status, extra);
  }

  /** The active wave id, or undefined when no wave is in progress. */
  get waveId(): string | undefined {
    return this.currentWaveId;
  }
}
