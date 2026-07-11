import type { ReadWithAutocompleteResult } from '../../input-box.js';
import type { UserPromptSubmitContext } from '../../../agent/hooks.js';
import { formatSubmittedEcho } from '../../input/echo.js';
import { describeAttachmentSummary, type ImageAttachment } from '../../input/attachments.js';
import { dispatch as dispatchSlash, parse as parseSlash } from '../../slash/registry.js';
import {
  runPreflight,
  getPreflight,
  getSkillPreflightDir,
  stitchForwardManifest,
  type SkillInvocation,
} from '../../slash/preflight/index.js';
import { renderDebugBanner } from '../../debug-banner.js';
import { isDebugEnabled, debugLog } from '../../../utils/debug.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { cyclePermissionMode } from '../../permission-mode-cycle.js';
import {
  autoRegisterPluginPassthroughs,
  getPluginShadowingNoticeLines,
} from '../../slash/plugin-skills.js';
import type { InteractiveCtx } from './shared.js';
import { formatStatusFields } from './shared.js';
import { AbortError, HookBlockedError } from '../../../utils/errors.js';
import { HookHandlerTimeoutError } from '../../../agent/hook-registry.js';

import type { TranscriptHandle } from './transcript.js';
import { runTurn } from './turn-handler.js';
import { saveSession } from '../../session-store.js';
import type { InputSurface } from '../../input/input-surface.js';
import type { ReplHistory } from '../../input/history.js';
import { buildPrompt, type TurnState } from './repl-loop-shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

/** Per-handler timeout for the post-turn Stop notification. Tighter than the
 *  registry default (HOOK_HANDLER_TIMEOUT_MS = 30s) because Stop fires every
 *  REPL turn — a notification hook must not stall the prompt for 30s × N handlers. */
const STOP_HOOK_HANDLER_TIMEOUT_MS = 5_000;

async function runFirstTurnHookIfNeeded(ctx: InteractiveCtx, text: string): Promise<void> {
  // First-turn hook — awaited before any first-turn side effect that relies on
  // the session cwd. For born-named worktrees the hook creates the worktree this
  // turn will run in and points the session cwd at it, so it MUST complete
  // before plugin preflights or model tool calls compute a cwd — otherwise they
  // would run in the launch cwd (the parent repo) instead of the isolated
  // worktree.
  //
  // Single-fire: guarded on `totalTurns === 0`. Detach before awaiting so a
  // slow hook cannot re-fire if the loop is re-entered mid-await.
  if (ctx.firstTurnHook && ctx.stats.totalTurns === 0) {
    const hook = ctx.firstTurnHook;
    ctx.firstTurnHook = undefined;
    try {
      await hook(text);
    } catch (err) {
      // Defensive — hook implementations are expected to swallow their own
      // errors, but never let one break the REPL. When called before runTurn the
      // compositor is not yet armed, so completionWriter routes to a plain
      // console.log — no clear/repaint race to lose.
      ctx.completionWriter.fn(
        palette.warning('⚠ ') + 'first-turn hook failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/**
 * Phase 3 of the REPL loop — the main input loop.
 *
 * Owns the per-loop mutable state (seed buffer, deferred init metadata,
 * first-use notices) and runs the `while (true)` body: notification drain,
 * seed-buffer fast-path, readLine, shell-passthrough dispatch, slash dispatch,
 * plugin-forward preflight, and `runTurn`. Returns when a slash command
 * resolves to `'exit'` (after `ctx.rl.close()`); the caller's `finally` then
 * tears down the surface and footer subsystems.
 *
 * Reads the surface + footer subsystems built by the earlier phases and the
 * `installSoftStop` helper returned by {@link setupSurface}.
 */
export async function runInputLoop(
  ctx: InteractiveCtx,
  transcript: TranscriptHandle,
  turnState: TurnState,
  sigintHandler: () => void,
  surface: InputSurface,
  installSoftStop: (handler: (() => void) | null) => void,
  footer: FooterSubsystems,
  history: ReplHistory,
): Promise<void> {
  const { contextPane, loopStageBar, verdictLedger, shellPassthrough, bgResultNotifier } =
    footer;

  // Init metadata (tools/MCP/SDK version) only resolves once the SDK
  // receives the first user message. Logging it inline from the `.then`
  // would interleave with the turn-1 spinner. Capture and defer to the
  // top of the REPL loop so it prints cleanly between turns.
  // Gated on isDebugEnabled() — the banner's tool count is SDK-advertised,
  // not the whitelisted subset, so it's misleading and noisy by default.
  let pendingInitMeta: string | null = null;
  let pendingShadowingNotices: string[] = [];
  ctx.session.current.waitForInitialization().then(async (meta) => {
    if (isDebugEnabled()) {
      pendingInitMeta = renderDebugBanner(meta);
    }
    // Hot-swap the placeholder /skills and /agents commands with the live
    // SDK-discovered lists, and install passthrough handlers for every
    // plugin skill so `/mint`, `/forge`, etc. forward straight to the SDK
    // turn loop. Without this, the slash dispatcher treats every plugin
    // skill as an unknown command until the user manually runs
    // `/reload-plugins`. Inner registrars log + swallow their own errors,
    // so this never throws in practice.
    await autoRegisterPluginPassthroughs(ctx.session.current);
    // Vendored or user skills win bare-name collisions with plugin skills —
    // surface a one-time dim notice telling the user where the shadowed
    // plugin form is still reachable (e.g. `/example-plugin:mint`).
    if (isDebugEnabled()) {
      pendingShadowingNotices = getPluginShadowingNoticeLines();
    }
  }).catch(() => { /* init / plugin discovery non-critical */ });

  // Slash-command submit queue: a slash handler may return
  // `{ kind: 'submit', message: '...' }` to follow itself up with a
  // user-text turn. We stash that as `seedBuffer` and fire it on the
  // next iteration via the fast-path below — the mid-stream-queue use
  // (user types + Enters mid-turn) was retired in Stage 3e because the
  // persistent compositor now handles that natively (queued buffer →
  // setInputMode('idle') flush via the surface's onSubmit handler).
  //
  // Pre-seeded from `ctx.initialInput` when the session was launched with a
  // first-message argument (`afk "prompt"` / `afk /review`): the first loop
  // iteration takes the same fast-path, so the launch arg is echoed and
  // dispatched (slash command or model turn) exactly as if the user had typed
  // it and pressed Enter.
  let seedBuffer: { text: string; attachments: readonly ImageAttachment[] } | undefined =
    ctx.initialInput !== undefined
      ? { text: ctx.initialInput, attachments: [] }
      : undefined;

  // First-use notice for ! shell passthrough: shown once per session on the
  // first `!cmd` dispatch so users who relied on `!literal text` as model
  // input are informed of the behavior change and the opt-out flag.
  let shellPassthroughNoticePrinted = false;

  // Session-autosave failure notice. Per-turn autosave is best-effort (it must
  // never break the loop), but a PERSISTENT failure (EACCES, ENOSPC, read-only
  // FS) would silently drop ALL session persistence while the user assumes the
  // conversation is resumable. Surface the FIRST failure per session; stay
  // quiet afterwards so a broken disk doesn't spam the transcript every turn.
  let autosaveFailureLogged = false;

  while (true) {
      if (pendingInitMeta) {
        ctx.replRenderer.writeLine(pendingInitMeta);
        ctx.replRenderer.writeLine('');
        pendingInitMeta = null;
      }
      if (pendingShadowingNotices.length > 0) {
        for (const line of pendingShadowingNotices) ctx.replRenderer.writeLine(line);
        ctx.replRenderer.writeLine('');
        pendingShadowingNotices = [];
      }
      // Shell-passthrough completion notifications — one-line summary per
      // backgrounded `!&cmd` that finished since the last prompt. Kept
      // single-line (instead of `card({...})`) because shell jobs typically
      // produce dense output and a multi-line card adds vertical noise.
      // The injected output reaches the model via `pendingShellInjection`
      // below, so the human-visible notice is summary-only.
      const shellNotifications = shellPassthrough.drainNotifications();
      for (const { job, result } of shellNotifications) {
        const glyph = result.errorReason === undefined ? '✓' : '✗';
        const exitPart = result.errorReason === 'abort'
          ? 'killed'
          : result.errorReason === 'timeout'
            ? 'timed out'
            : result.errorReason === 'signal-killed'
              ? 'killed by signal'
              : `exit ${result.exitCode ?? 0}`;
        const seconds = Math.max(0, Math.round(result.durationMs / 100) / 10);
        ctx.replRenderer.writeLine(
          palette.dim(`  ${glyph} [${job.id}] ${exitPart} · ${seconds}s · `) + job.command,
        );
      }
      // Background-subagent completion notifications — one line per settled
      // `agent`-tool background job (mode:"background" or Ctrl+B promotion)
      // since the last prompt. The result itself reaches the model via
      // `bgResultNotifier.drainInjections()` below; this notice is
      // human-summary-only, matching the shell-job style above.
      const bgAgentNotifications = bgResultNotifier.drainNotifications();
      for (const { job } of bgAgentNotifications) {
        const glyph = job.status === 'completed' ? '✓' : job.status === 'failed' ? '✗' : '⊘';
        const seconds = job.endedAt !== undefined
          ? Math.max(0, Math.round((job.endedAt - job.startedAt) / 100) / 10)
          : 0;
        const label = job.label.length > 60 ? `${job.label.slice(0, 60)}…` : job.label;
        ctx.replRenderer.writeLine(
          palette.dim(`  ${glyph} [${job.jobId}] subagent ${job.status} · ${seconds}s · `) + label,
        );
      }
      const paneLines = contextPane.renderIfChanged(ctx.stats.sessionId);
      if (paneLines.length > 0) {
        for (const l of paneLines) ctx.replRenderer.writeLine(l);
        ctx.replRenderer.writeLine('');
      }
      // Verdict trajectory rail — rendered as a pinned DECSTBM-reserved footer
      // row by verdictLedger itself (started above). No inline writeLine here.
      let text: string;
      let attachments: ReadWithAutocompleteResult['attachments'];

      // Drain any implement-turn queued by an approved `exit_plan_mode` tool
      // call during the previous turn. The session held it (the per-turn tool
      // dispatcher can't reach this REPL loop), so we promote it to the seed
      // buffer here, post-turn — the model-proposed counterpart to `/plan off`'s
      // seeded save-and-implement handoff. A `/plan off` seed (set directly,
      // same turn) takes precedence if both are somehow present.
      if (seedBuffer === undefined) {
        const planExit = await ctx.session.current.takePendingPlanExitSeed();
        if (planExit !== undefined) {
          // #495: takePendingPlanExitSeed already applied the deferred flip to
          // the SESSION's mode, but the plan-mode gate and this loop's prompt
          // read `stats.permissionMode` (bootstrap wires the gate to
          // `() => stats.permissionMode`). Mirror the applied mode here — exactly
          // as `togglePlanMode` does for `/plan off` — or the gate stays
          // plan-locked and the operator's prompt indicator never flips.
          ctx.stats.permissionMode = planExit.mode;
          seedBuffer = { text: planExit.message, attachments: [] };
        }
      }

      if (seedBuffer !== undefined) {
        // Slash-command follow-up: a previous handler returned
        // { kind: 'submit', message } to chain itself with a user-text
        // turn. We auto-submit without a second Enter press — the user
        // already expressed intent by running the slash command.
        //
        // Echo routes through `ctx.replRenderer.writeLine` which, when
        // the persistent compositor is armed, commits above the live
        // overlay via compositor.commitAbove (matching the surface's
        // readLine echo path so scrollback parity holds).
        const queued = seedBuffer;
        seedBuffer = undefined;
        const prompt = buildPrompt(ctx.stats.permissionMode);
        const echo = formatSubmittedEcho({
          buffer: queued.text,
          promptText: prompt,
          isTTY: Boolean(process.stdout.isTTY),
          attachmentSummary: describeAttachmentSummary([...queued.attachments]),
        });
        ctx.replRenderer.writeLine(echo);
        text = queued.text.trim();
        attachments = queued.attachments as ReadWithAutocompleteResult['attachments'];
      } else {
        // Stage 3e: surface.readLine uses the persistent compositor's
        // onSubmit path when armed (TTY); falls back to readWithAutocomplete
        // on non-TTY surfaces. Shift+Tab and onSigint are wired ONCE at
        // armCompositor time (above) — no need to re-pass per-call.
        const result = await surface.readLine({
          promptFn: () => buildPrompt(ctx.stats.permissionMode),
          onSigint: sigintHandler,
          onShiftTab: () => {
            // Shift+Tab is the keyboard speed lane: it advances the permission-
            // mode ring default → plan → bypass → default (AFK is excluded —
            // it stays on /afk; if already in AFK, Shift+Tab exits it to
            // default). No seeded turn. (`/plan off`, by contrast, exits plan
            // and seeds a save-and-implement turn.)
            cyclePermissionMode(ctx.slashCtx).catch(() => {});
            ctx.statusLine.rearm();
          },
        });
        text = result.text.trim();
        attachments = result.attachments;
      }
      if (!text && attachments.length === 0) continue;

      // Shell-passthrough branch — `!cmd` foreground / `!&cmd` background.
      // Runs BEFORE the slash check so `!ls /tmp` (which contains a `/`)
      // is unambiguously a shell command, not a slash dispatch. The
      // handler awaits FG to completion before returning so the next
      // prompt appears AFTER the command finishes; BG returns
      // immediately and the completion notification surfaces at the top
      // of the next loop iteration.
      if (text.startsWith('!')) {
        // Respect --no-shell-passthrough (or AFK_SHELL_PASSTHROUGH): skip
        // dispatch entirely and fall through so the model receives the literal
        // `!text` input instead of shelling it out. The env opt-out accepts any
        // common falsy spelling (0 / false / off / no, case-insensitive) so
        // env-based lockdown policies don't silently leave the feature on when
        // they set e.g. AFK_SHELL_PASSTHROUGH=false. (PR #565 review: L1.)
        const shellPassthroughEnvOptOut = /^(0|false|off|no)$/i.test(
          env.AFK_SHELL_PASSTHROUGH ?? '',
        );
        const shellPassthroughEnabled =
          ctx.options.shellPassthrough !== false && !shellPassthroughEnvOptOut;

        if (shellPassthroughEnabled) {
          // First-use notice: inform users of the behavior change on the first
          // `!cmd` dispatch in this session so those who relied on `!literal`
          // as model input discover the opt-out flag promptly.
          if (!shellPassthroughNoticePrinted) {
            shellPassthroughNoticePrinted = true;
            ctx.replRenderer.writeLine(
              palette.dim(
                '  ℹ  ! prefix shells out. Pass --no-shell-passthrough (or set AFK_SHELL_PASSTHROUGH=0) to send ! text to the model instead.',
              ),
            );
          }
          const handled = await shellPassthrough.dispatch(text);
          if (handled) {
            ctx.statusLine.rearm();
            continue;
          }
        }
        // Fall through — either shell passthrough is disabled (literal text
        // sent to the model) or the dispatcher returned false (empty `!`
        // with no body; usage hint already emitted inside the dispatcher).
      }

      // C01: track whether this turn was handled by a native slash command so
      // the preflight block below only fires on the plugin-forward path.
      let isPluginForward = false;
      if (text.startsWith('/')) {
        const res = await dispatchSlash(text, ctx.slashCtx, attachments);
        if (res.handled) {
          if (res.result === 'exit') { ctx.rl.close(); return; }
          if (text === '/clear' || text.startsWith('/clear ')) {
            await transcript.rotateOnClear();
            ctx.replRenderer.writeLine(palette.dim(`  transcript: ${transcript.path()}`));
            // The conversation has been wiped — its verdict trajectory is
            // no longer meaningful. Drop the ledger so the next prompt
            // doesn't carry stale state into a fresh session.
            verdictLedger.reset();
          }
          if (
            res.result !== null &&
            typeof res.result === 'object' &&
            'kind' in res.result &&
            res.result.kind === 'submit'
          ) {
            seedBuffer = { text: res.result.message, attachments: attachments ?? [] };
            ctx.statusLine.rearm();
            continue;
          }
          ctx.statusLine.rearm();
          continue;
        }
        // dispatchSlash returned handled: false. This happens for two reasons:
        //   (a) `forward` — the plugin-skill passthrough: we should run the preflight.
        //   (b) Unrecognized command — falls through to the agent as plain text.
        // In both cases we are in the plugin-forward branch, not a native handler.
        isPluginForward = true;
      }


      // Persist to history ring (slash commands excluded — they're meta, not prompts).
      history.push(text);

      await runFirstTurnHookIfNeeded(ctx, text);

      // SkillPreflight — plugin-forward path only (C01).
      // When a slash command falls through `dispatchSlash` as `forward` —
      // the plugin-skill passthrough — we don't get a chance to mutate the
      // message via buildSkillInvocationMessage. Instead, run any
      // registered preflight here and *prepend* the manifest to the user
      // text. The plugin-skill body still expands from the `/<skill>` line
      // at the tail, so the manifest reads as preceding context that the
      // model has already seen by the time it dispatches the skill.
      //
      // Failure isolation: no preflight registered, or preflight returns
      // null/throws → text passes through verbatim, identical to today.
      // No working-tree mutation, no model round-trip.
      //
      // NOTE: native commands that `dispatchSlash` handles fully always
      // `continue` above and never reach this block — the `isPluginForward`
      // guard is belt-and-suspenders to make the constraint machine-checkable.
      let runText = text;
      if (isPluginForward) {
        const parsed = parseSlash(text);
        if (parsed) {
          // Strip leading '/' and any '<plugin>:' namespace → bare name.
          const bare = parsed.name.replace(/^\//, '').split(':').pop() ?? '';
          // M5: only create the artifact dir (mkdirSync) when a preflight is
          // actually registered for this skill — avoids filesystem noise on the
          // dominant no-preflight path.
          if (bare && getPreflight(bare)) {
            const inv: SkillInvocation = {
              skillName: bare,
              rawArgs: parsed.args,
              // Forward path is plugin-only today — user/project slash commands
              // are handled before this block and never reach the preflight path.
              // If user/project sources are ever forwarded here, derive source
              // from the skill registry origin (cf. builtin-skills.ts#originToSource).
              source: 'plugin',
              capabilities: { compose: true, subagents: true },
            };
            const sessionIdMaybe = ctx.session.current.sessionId;
            const artifactDir = getSkillPreflightDir(sessionIdMaybe);
            // P04: emit a structured debug trace event before/after runPreflight
            // so hot-path duration and success/failure are observable without a
            // full trace writer. Gated on isDebugEnabled() — no overhead in prod.
            // External constraint: debugLog is a no-op unless AFK_DEBUG=1.
            const preflightStart = Date.now();
            debugLog(`[afk trace] preflight.start commandName=${bare}`);
            let preflightSuccess = false;
            const pre = await runPreflight(
              inv,
              // Honor the session's effective cwd so preflights that shell
              // out to `git status` / file globs operate on the worktree,
              // not the Node host's process.cwd() (the parent repo when
              // launched with `afk i --worktree`). `stats.cwd` is stamped
              // at bootstrap.ts:328 with the same `process.cwd()` fallback.
              { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
              (err) => {
                // Surface preflight errors in debug mode; swallow in production
                // so a failing context-gather never blocks the skill from running.
                if (isDebugEnabled()) {
                  ctx.replRenderer.writeLine(
                    palette.warning(`⚠ preflight(${bare}) failed: `) +
                      (err instanceof Error ? err.message : String(err)),
                  );
                }
              },
            );
            preflightSuccess = pre !== null;
            debugLog(
              `[afk trace] preflight.end commandName=${bare} durationMs=${Date.now() - preflightStart} success=${preflightSuccess}`,
            );
            // C03: `pre?.manifestBlock` may be undefined (preflight returned null or
            // didn't produce a manifest). stitchForwardManifest is a no-op on
            // undefined/empty — it returns `text` unchanged in that case.
            // Manifest precedes the slash line at the tail so the
            // plugin-skill body expansion still fires. See
            // stitchForwardManifest for the <system-reminder> wrap
            // rationale — this path concatenates into a single user-text
            // payload so it needs an explicit structural marker.
            runText = stitchForwardManifest(pre?.manifestBlock, text);
          }
        }
      }

      // Prepend any pending shell-passthrough output blocks so the model
      // sees `!cmd` output as context for the next user message. Matches
      // Claude Code's transcript-injection semantics: shell output sits
      // between user messages, model reads it on the next turn. The
      // drain clears the buffer atomically — a single message carries
      // every output accumulated since the previous user turn.
      const shellInjection = shellPassthrough.drainInjections();
      if (shellInjection.length > 0) {
        runText = shellInjection + runText;
      }

      // Prepend any settled background-subagent results so the model sees
      // them as context for the next user message — same next-turn delivery
      // contract as shell passthrough above. Drain also emits a `delivered`
      // witness event per job; /bgsub:join remains available for replay.
      const bgAgentInjection = bgResultNotifier.drainInjections();
      if (bgAgentInjection.length > 0) {
        runText = bgAgentInjection + runText;
      }

      // UserPromptSubmit hook — fires before every turn submission.
      // Handlers may block the turn (HookBlockedError → continue loop),
      // inject additional context (prepended to runText), or approve silently.
      // A handler timeout (HookHandlerTimeoutError) fails closed like a block;
      // AbortError and any other throw propagate out of the loop unchanged.
      if (ctx.hookRegistry) {
        try {
          const upsCtx: UserPromptSubmitContext = {
            event: 'UserPromptSubmit',
            prompt: runText,
            sessionId: ctx.stats.sessionId,
          };
          const upsDecision = await ctx.hookRegistry.dispatch(upsCtx);
          if (upsDecision.injectContext) {
            runText = upsDecision.injectContext + runText;
          }
        } catch (err) {
          if (err instanceof HookBlockedError) {
            ctx.replRenderer.writeLine(
              palette.warning('⊘ Turn blocked by hook') +
                (err.reason ? palette.dim(`: ${sanitizeForDisplay(err.reason)}`) : ''),
            );
            ctx.statusLine.rearm();
            continue;
          }
          // A handler that exceeds HOOK_HANDLER_TIMEOUT_MS fails closed exactly
          // like a deliberate block. hook-registry re-throws
          // HookHandlerTimeoutError raw (so dispatchSubagentStop can distinguish
          // a timeout from a block); here we drop the turn with a notice rather
          // than letting the timeout unwind and crash the REPL loop.
          if (err instanceof HookHandlerTimeoutError) {
            ctx.replRenderer.writeLine(
              palette.warning('⊘ Turn blocked by hook') +
                palette.dim(`: handler timed out after ${err.timeoutMs}ms`),
            );
            ctx.statusLine.rearm();
            continue;
          }
          // AbortError (Ctrl-C teardown) and every other non-block, non-timeout
          // throw propagate out of the REPL loop unchanged.
          throw err;
        }
      }

      await runTurn({ text: runText, attachments }, ctx.session.current, ctx.stats, {
        setInFlight(v: boolean) { turnState.turnInFlight = v; },
        // Forward the promotion seam so Ctrl+B can background a running
        // foreground subagent (else fall back to whole-turn backgrounding).
        ...(ctx.subagentControl ? { subagentControl: ctx.subagentControl } : {}),
        async onUserMessage(userInput) {
          // Write the user's message to the transcript immediately — the
          // appendTurn below then closes the turn with the assistant block.
          await transcript.appendUser(userInput);
        },
        async onTurnComplete(userInput, assistantText) {
          await transcript.appendTurn(userInput, assistantText);
          // Per-turn session autosave → ~/.afk/state/sessions/<sessionId>.json.
          // recordTurn (turn-handler) already folded this turn into ctx.stats
          // and set the auto-name, so persist the live snapshot now. Keyed by
          // sessionId (no override) → one file updated in place, never a
          // duplicate. Crash-safe: a non-graceful exit no longer loses the
          // resumable session — only the markdown transcript was per-turn before.
          //
          // Guard on sessionId: saveSession falls back to a fresh
          // session-<now>.json filename when it's absent, which would spawn a
          // NEW file every turn. The provider sets sessionId by the first
          // turn's recordTurn in the common case; rare providers that emit none
          // fall back to the single on-exit save instead of forking sidecars.
          if (ctx.stats.sessionId) {
            try {
              saveSession(ctx.stats);
            } catch (err) {
              // Best-effort — autosave must never break the REPL loop. But
              // surface the FIRST failure per session (autosaveFailureLogged)
              // so a persistent EACCES/ENOSPC isn't silently swallowed every
              // turn while the user assumes the conversation is resumable.
              if (!autosaveFailureLogged) {
                autosaveFailureLogged = true;
                ctx.replRenderer.writeLine(
                  palette.warning('⚠ ') +
                    'session autosave failed — this conversation may not be resumable: ' +
                    (err instanceof Error ? err.message : String(err)),
                );
              }
            }
          }
        },
        async onAfterTurn() {
          await ctx.contextSampler.onTurn(ctx.stats.totalTurns);
          // Re-sample the git branch each turn (cheap, local). The PR lookup
          // (network) is detached inside refresh() and lands on a later repaint.
          await ctx.gitStatusSampler.refresh();
          ctx.statusLine.rearm();
          // Reset the loop-stage bar to 'observing' so the footer rail shows
          // a clean "waiting" state between turns rather than the last active
          // stage from the completed turn (which could be any of the five).
          loopStageBar?.repaint('observing');
        },
        rearmStatus: () => ctx.statusLine.rearm(),
        onTerminalState: (state) => verdictLedger?.push(state),
        setActiveCompositor: (c) => {
          // Publish the active compositor for the SIGINT handler (which
          // routes the interrupt notice through `commitAbove` when an
          // overlay is live). Do NOT call `ctx.replRenderer.setCompositor(c)`
          // here — the persistent compositor was already wired onto
          // `replRenderer` once at `armCompositor` time above, and
          // toggling it to `null` in turn-handler's finally would re-
          // expose the original Stage-3e bug: top-of-loop `writeLine`
          // calls would fall through to raw stdout.write while the
          // persistent compositor stays armed, corrupting log-update's
          // line tracker.
          turnState.activeCompositor = c;
        },
        setInterruptNotifier: (fn) => {
          turnState.notifyInterrupting = fn;
        },
        // The StatusLine doubles as a DECSTBM scroll-region guard so that
        // mid-turn `commitAbove` writes (tool labels, agent banners, etc.)
        // enter terminal scrollback instead of being silently clipped by
        // the persistent sub-region scroll.
        scrollRegion: ctx.statusLine,
        // Stage 3e: expose the surface's persistent compositor + per-turn
        // background/soft-stop handler swaps to the turn handler. All are
        // no-ops on non-TTY surfaces (surface.getCompositor() returns null;
        // set*Handler calls are benign mutations of null refs).
        getCompositor: () => surface.getCompositor(),
        setBackgroundHandler: (handler) => surface.setBackgroundHandler(handler),
        setSoftStopHandler: installSoftStop,
        setPausedState: (paused) => surface.setPausedState(paused),
        setPauseInterruptHandler: (handler) => surface.setPauseInterruptHandler(handler),
        async onContextProgress() {
          await ctx.contextSampler.refresh();
          ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler));
        },
        // Repaint the LoopStageBar footer row whenever the agent's loop stage
        // transitions.  The bar is a per-session singleton; the callback is
        // safe to call on non-TTY (LoopStageBar.repaint() TTY-gates itself).
        ...(loopStageBar ? { onStageChange: (stage) => loopStageBar!.repaint(stage) } : {}),
      }, ctx.stats.thinkingUi ?? ctx.options.thinkingUi, ctx.completionWriter,
        // Surface refs threaded into the per-turn StreamRenderer for the
        // legacy non-borrow path (non-TTY, when surface.getCompositor()
        // is null and the renderer constructs its own compositor). In
        // the persistent-compositor path, these refs are already wired
        // by armCompositor and the renderer's borrow skips this branch
        // — passing them anyway is a defensive belt-and-suspenders for
        // surfaces that haven't armed (e.g. a future test path).
        surface.toRunTurnRefs(buildPrompt(ctx.stats.permissionMode)),
      );

      // Contract: Stop fires post-turn as a notification event. AbortError
      // propagates (abort precedence is non-negotiable). HookBlockedError
      // surfaces a brief notice and continues -- block does NOT force REPL
      // continuation in v1 (deferred: block-to-force-continuation and
      // injectContext-into-next-turn need cross-turn state).
      //
      // Invariant: Stop fires only on non-throwing runTurn completions. Any
      // throw from runTurn (including model errors and abort) bypasses this
      // block entirely -- error and abort paths skip Stop by design. The
      // sequential placement (not finally) is intentional: Stop signals
      // successful turn completion, not turn exit.
      //
      // Invariant: slash-command-only iterations (res.handled paths above)
      // end in `continue` before reaching this block, so Stop does not fire
      // for slash-command-only turns. Only turns that invoke runTurn trigger
      // Stop.
      //
      // Contract: Stop dispatch uses STOP_HOOK_HANDLER_TIMEOUT_MS (5s) rather
      // than the registry default (30s) because Stop fires every REPL turn —
      // a notification hook must not stall the prompt for 30s × N handlers.
      if (ctx.hookRegistry) {
        try {
          await ctx.hookRegistry.dispatch(
            { event: 'Stop', sessionId: ctx.stats.sessionId },
            undefined,
            STOP_HOOK_HANDLER_TIMEOUT_MS,
          );
        } catch (err) {
          if (err instanceof AbortError) throw err;
          if (err instanceof HookHandlerTimeoutError) {
            debugLog('[stop hook] handler timed out');
            ctx.completionWriter.fn(palette.dim('  [stop hook] timed out'));
          } else if (err instanceof HookBlockedError) {
            ctx.completionWriter.fn(
              palette.dim(`  [stop hook] blocked: ${sanitizeForDisplay(err.reason ?? 'no reason given')}`),
            );
          } else {
            debugLog('[stop hook] unexpected error: ' + String(err));
          }
        }
      }
    }
}
