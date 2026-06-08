/**
 * Shared core for slash-skill dispatch turns.
 *
 * Invariant: built-in / user / project TS skills (`makeImmediateHandler`)
 * and plugin skills (`makeForwardHandler`) MUST use the same arm → preflight
 * → build → stream → dispose sequence around `buildSkillInvocationMessage`.
 * Centralizing the sequence here is the structural defence against
 * payload-shape drift between the two paths — the image-support-consistency
 * gap this helper was created to fix was caused by exactly that drift
 * (the immediate path was updated to thread image attachments through;
 * the plugin path was not).
 *
 * Invariant: preflight runs INSIDE the armed renderer via an optional
 * callback param, not as input data. That preserves the ordering where the
 * user sees the renderer's spinner during a slow preflight (e.g. `review-pr`
 * shelling out to `gh pr view` for 2s+). Moving preflight out of the armed
 * window would surface the slow preflights as silent dead air.
 *
 * Contract — ordered-operation sequence:
 *   1. `createSkillRenderer` constructs the renderer (sync).
 *   2. `renderer.arm()` mounts the compositor — spinner is now visible.
 *   3. `runPreflight` callback runs (if provided) — manifest read while
 *      the spinner ticks.
 *   4. Message is built; stream is consumed under `runWithSink`.
 *   5. `renderer.dispose()` runs in `finally` — arm-without-dispose is the
 *      failure mode the persistent-compositor borrow path was designed
 *      to prevent, so the finally is non-negotiable.
 *
 * Contract: errors propagate to the caller, which owns the per-skill error
 * message format (e.g. `${skill.name} failed: …`). This helper only owns
 * the renderer lifecycle and preflight-failure isolation.
 */

import type { SlashContext } from '../types.js';
import type { SkillMetadata } from '../../../skills/index.js';
import type { ImageAttachment } from '../../input/attachments.js';
import { createSkillRenderer } from './create-skill-renderer.js';
import { runWithSink } from '../../../agent/_lib/skill-sink-channel.js';
import { buildSkillInvocationMessage } from './skill-message-bridge.js';

export interface RunSkillDispatchTurnParams {
  /**
   * Skill name used for the renderer's visual badge AND as the dispatch
   * key inside the synthesized invocation message. Plain bare name — no
   * leading slash, no `<plugin>:` prefix.
   */
  skillName: string;
  /**
   * Skill metadata consumed by `buildSkillInvocationMessage`. For
   * built-in / user / project skills this is the registry-resolved
   * SkillMetadata. For plugin skills it's a synthesized minimal adapter
   * (name + handler stub + `context: 'inline'`). Only `.name` and
   * `.context` are read by the builder.
   */
  skillMeta: SkillMetadata;
  /** Raw argument string passed to the slash command. */
  args: string;
  /**
   * Optional preflight callback. Runs AFTER `renderer.arm()` so the
   * renderer's spinner is visible during any I/O the preflight performs
   * (e.g. `gh pr view`, `git status`). Returns the manifest block to
   * prepend, or undefined when no manifest applies. Errors thrown from
   * the callback are caught and treated as no-op preflight — the
   * dispatch proceeds with no manifest. Mirrors `runPreflight`'s own
   * "throws → null" failure isolation contract.
   */
  preflight?: () => Promise<string | undefined>;
  /**
   * Optional image attachments. Appended as image blocks at the tail of
   * the payload so the model sees them as part of the skill invocation
   * context. Plugin and built-in paths must share this contract — empty
   * or undefined means no images.
   */
  attachments?: readonly ImageAttachment[] | undefined;
}

/**
 * Arm a renderer, optionally run a preflight, send the skill-invocation
 * payload through the session stream, and dispose. The caller is
 * expected to wrap this in their own try/catch for error reporting;
 * this helper only owns the renderer lifecycle (arm/finally-dispose)
 * and preflight failure isolation.
 *
 * Returns the text of the final assistant `message` event seen on the stream
 * (`''` when none / when soft-stopped before any landed). Callers that don't
 * need it simply ignore the return; `/review --post` consumes it to publish
 * the verified review after the skill's terminal output.
 */
export async function runSkillDispatchTurn(
  ctx: SlashContext,
  params: RunSkillDispatchTurnParams,
): Promise<string> {
  const renderer = createSkillRenderer(ctx, {
    skillName: params.skillName,
    onCancel: () => {
      ctx.session.current.interrupt().catch(() => { /* best effort */ });
    },
  });

  let softStopRequested = false;
  // Captured for post-dispatch consumers (e.g. `/review --post`). The last
  // assistant message on the stream is the skill's terminal output — for
  // review that's the post-shadow-verify merge recommendation + findings.
  let finalAssistantText = '';

  try {
    await renderer.arm();

    // Install the per-dispatch ESC soft-stop handler. Mirrors runTurn's
    // wiring (turn-handler.ts ~line 189) — without this, ESC during a
    // /skill turn is silently dropped at the compositor's onSoftStop →
    // InputSurface.softStopHandler?.() no-op (the gap PR #546 called
    // out as a deferred follow-up). Cleared in finally.
    ctx.setSoftStopHandler?.(() => { softStopRequested = true; });

    // Preflight runs inside the armed renderer so the spinner is visible
    // during any I/O. Failure isolation matches `runPreflight`'s own
    // contract: a thrown preflight callback is logged-via-debug-only and
    // treated as null manifest — the dispatch proceeds unchanged.
    let manifestBlock: string | undefined;
    if (params.preflight) {
      try {
        manifestBlock = await params.preflight();
      } catch {
        // Preflight callbacks own their own error reporting (e.g.
        // `makeImmediateHandler`'s onError → ctx.out.warn). Swallow here
        // so a buggy callback can never block the skill from running.
        manifestBlock = undefined;
      }
    }

    const message = buildSkillInvocationMessage(
      params.skillMeta,
      params.args,
      manifestBlock,
      params.attachments,
    );
    // Install renderer.sink as the ambient progress sink so any subagents
    // forked during the SDK's tool-dispatch chain (SkillExecutor →
    // SubagentManager.forkSubagent) propagate their OutputEvent stream
    // into this renderer. AsyncLocalStorage carries the sink across the
    // SDK's async boundaries — see _lib/skill-sink-channel.ts.
    await runWithSink(renderer.sink, async () => {
      for await (const event of ctx.session.current.sendMessageStream(message)) {
        // Invariant: soft-stop halt MUST fire before the event is sinked
        // into the renderer. Mirrors turn-handler.ts ~line 225 — the
        // event-loop boundary between the HTTP stream pump and the
        // renderer state writer is what makes this ordering load-bearing.
        // session.interrupt() terminates the stream's async iterator
        // naturally (no throw); the break exits the for-await cleanly
        // and the finally block disposes the renderer.
        if (softStopRequested) {
          ctx.session.current.interrupt().catch(() => { /* best effort */ });
          break;
        }
        // Capture the latest assistant message text BEFORE sinking — read-only,
        // never mutates the event, and only runs when soft-stop did not break
        // above (so an interrupted skill yields no stale post-text).
        if (event.type === 'message' && event.message.role === 'assistant') {
          finalAssistantText = event.message.content;
        }
        renderer.sink(event);
      }
    });
  } finally {
    ctx.setSoftStopHandler?.(null);
    await renderer.dispose();
  }

  return finalAssistantText;
}
