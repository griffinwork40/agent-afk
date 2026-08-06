/**
 * Core slash commands: /exit, /quit, /clear, /compact, /help
 *
 * These are the always-present navigation commands. They do not depend on
 * any Tier 2/3 infrastructure and remain functional even if other command
 * modules are removed.
 */

import ora from 'ora';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { list } from '../registry.js';
import { resetStats } from '../session-stats.js';
import { REPL_SPINNER_OPTIONS } from '../../commands/interactive/shared.js';
import { HookBlockedError, AbortError } from '../../../utils/errors.js';
import { renderSelector } from '../../input/selectors.js';
import type { SlashCommand } from '../types.js';

/** Compact human-readable byte size for the /compact microcompaction notice. */
function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}KB`;
  return `${n}B`;
}

const exitCmd: SlashCommand = {
  name: '/exit',
  aliases: ['/quit'],
  summary: 'Exit the session',
  hint: 'When you want to tear down the REPL — Ctrl+D on an empty prompt does the same.',
  async handler() {
    return 'exit';
  },
};

const clearCmd: SlashCommand = {
  name: '/clear',
  summary: 'Clear conversation history',
  hint: 'When the current thread has drifted off-topic or you want a clean slate without restarting the session.',
  async handler(ctx) {
    try {
      // We tear down and rebuild the SDK conversation rather than forwarding
      // the literal string `/clear` to the provider — providers treat that
      // as a normal user-text turn, so the model retains prior context.
      await ctx.session.current.reset();
      ctx.ui.clearScreen();
      resetStats(ctx.stats);
      ctx.ledger?.clear();
      ctx.out.success('Conversation history cleared.');
    } catch (err) {
      ctx.out.error(err instanceof Error ? err.message : 'Unknown error');
    }
    return 'continue';
  },
};

const compactCmd: SlashCommand = {
  name: '/compact',
  summary: 'Compact history (summarize older messages)',
  hint: 'When context is filling up but you want to keep the thread — summarizes old turns and keeps the recent ones intact.',
  async handler(ctx) {
    // When the persistent TerminalCompositor is armed (TTY REPL), route the
    // progress indicator through its in-frame spinner instead of a bare ora:
    // ora's imperative cursor writes race the compositor's frame repaints on
    // the same physical rows (see terminal-compositor.ts:~800), which is why
    // a user typing during compaction couldn't see their own keystrokes.
    // Non-TTY surfaces (Telegram, daemon, tests) have no compositor to race
    // with, so they keep the original bare-ora behavior unchanged.
    const compositor = ctx.getCompositor?.() ?? null;
    let spinner: ReturnType<typeof ora> | null = null;
    let spinnerActive = false;
    // Single stop point reused on every exit path below (success and catch)
    // so the two flavors of "turn the spinner off" can never drift out of
    // sync — a spinner left enabled is a worse bug than the race it replaces.
    const stopSpinner = (): void => {
      if (!spinnerActive) return;
      if (compositor) {
        compositor.setSpinner({ enabled: false });
      } else {
        spinner?.stop();
      }
      spinnerActive = false;
    };
    try {
      // Invariant: fire PreCompact before compaction so registered handlers can
      // block or observe the operation. block -> HookBlockedError -> skip.
      const session = ctx.session.current;
      const hookRegistry = session.hookRegistry;
      if (hookRegistry) {
        await hookRegistry.dispatch({
          event: 'PreCompact',
          sessionId: session.sessionId,
          trigger: 'manual',
        });
      }
      // Do not announce or animate compaction until PreCompact hooks have
      // allowed it. The compositor notice is durable scrollback, so emitting it
      // before dispatch would falsely claim summarization began when a hook
      // blocks the operation.
      if (compositor) {
        // The in-frame spinner carries no caller-supplied label — it rotates
        // work-derived/flavour verbs (see input/work-derived-verb.ts), and there
        // is no 'compact' tool category to map onto. Commit the intent line above
        // the frame instead, so the operator still learns WHAT is running; unlike
        // a spinner label it also survives into scrollback next to the result.
        ctx.out.info('Summarizing earlier turns...');
        compositor.setSpinner({ enabled: true });
        spinnerActive = true;
      } else {
        spinner = ora({
          text: palette.meta('Summarizing earlier turns...'),
          ...REPL_SPINNER_OPTIONS,
        }).start();
        spinnerActive = true;
      }
      const result = await session.compact();
      stopSpinner();
      if (!result.compacted) {
        const reason = result.reason ?? 'unknown';
        if (reason === 'aborted') {
          ctx.out.info('Compaction cancelled.');
        } else if (reason.startsWith('summarization-failed')) {
          ctx.out.error(`Compaction failed: ${reason}. History unchanged.`);
        } else if (reason === 'microcompacted') {
          // Deterministic tool-result microcompaction reclaimed bytes on a
          // short-but-full session where turn-granular summarization no-ops.
          const mc = result.microcompaction;
          const detail = mc
            ? ` — cleared ${mc.blocksCleared} tool result${mc.blocksCleared === 1 ? '' : 's'} (~${formatBytes(mc.bytesReclaimed)} reclaimed)`
            : '';
          ctx.out.success(`Reclaimed context${detail}.`);
        } else if (reason === 'nothing-to-summarize') {
          ctx.out.info('Nothing to compact — all history is within the keep window.');
        } else if (reason === 'not-supported') {
          ctx.out.warn('Compaction is not supported for this model or provider — use a Claude model to enable /compact.');
        } else if (reason === 'responses-compaction-unavailable') {
          // This backend refused the summarize request earlier in the session, so
          // the transport stays disabled until restart. Name the recovery path —
          // the raw token alone tells an operator nothing actionable.
          ctx.out.warn(
            'Summarization is unavailable on this backend — it refused the compaction request earlier this session. Start a new session, or set AFK_COMPACT_MODEL to a model this endpoint can serve.',
          );
        } else {
          ctx.out.info(`Nothing to compact (${reason}).`);
        }
      } else {
        const saved = result.tokensSavedEstimate
          ? ` (~${result.tokensSavedEstimate} input tokens saved)`
          : '';
        ctx.out.success(
          `Compacted ${result.messagesBefore} → ${result.messagesAfter} messages${saved}.`,
        );
      }
    } catch (err) {
      stopSpinner();
      if (err instanceof AbortError) throw err;
      if (err instanceof HookBlockedError) {
        ctx.out.info(`Compaction skipped: ${err.reason ?? 'blocked by hook'}`);
        return 'continue';
      }
      ctx.out.error(err instanceof Error ? err.message : 'Unknown error');
    }
    return 'continue';
  },
};

const rewindCmd: SlashCommand = {
  name: '/rewind',
  summary: 'Edit a previous message (rewind the conversation)',
  hint: 'When you want to go back and re-ask an earlier prompt — pick a message, the conversation rewinds to it, and its text loads into the input to edit and resend. (Also: press Esc twice at an empty prompt.)',
  async handler(ctx) {
    const session = ctx.session.current;
    const targets = session.listRewindTargets();
    if (targets.length === 0) {
      ctx.out.info('Nothing to rewind to — no earlier messages in this conversation.');
      return 'continue';
    }

    // renderSelector drives raw stdin directly, so release the persistent
    // compositor's keypress listener first and re-arm it after (the selector
    // contract — see input/selectors.ts). getCompositor is null on non-TTY.
    const compositor = ctx.getCompositor?.() ?? null;
    compositor?.suspendInput();
    let choice: number | ':cancel' | null;
    try {
      choice = await renderSelector(
        targets.map((t) => t.preview),
        new AbortController().signal,
      );
    } finally {
      compositor?.resumeInput();
    }

    if (choice === null) {
      ctx.out.info('Rewind requires an interactive terminal.');
      return 'continue';
    }
    if (choice === ':cancel') return 'continue';

    const target = targets[choice];
    if (!target) return 'continue';

    const result = await session.rewindConversation(target.turnIndex);
    if (!result.rewound) {
      const reason = result.reason ?? 'unknown';
      if (reason === 'not-supported') {
        ctx.out.warn(
          'Rewind is not supported for this provider — use a Claude model to enable /rewind.',
        );
      } else if (reason === 'session-busy' || reason === 'turn-in-flight') {
        ctx.out.info('Cannot rewind while a turn is running.');
      } else {
        ctx.out.info(`Cannot rewind (${reason}).`);
      }
      return 'continue';
    }

    ctx.out.success(
      `Rewound ${result.messagesBefore} → ${result.messagesAfter} messages. Edit the message below and press Enter to resend.`,
    );
    return { kind: 'prefill', message: result.reloadText ?? '' };
  },
};

const helpCmd: SlashCommand = {
  name: '/help',
  summary: 'Show this help',
  hint: 'When you want the full command list with usage strings — broader than this inline dropdown.',
  async handler(ctx) {
    const cmds = list();
    const maxName = cmds.reduce((m, c) => Math.max(m, c.name.length), 0) + 2;

    ctx.out.line();
    ctx.out.line(palette.bold(palette.brand('Commands')));
    ctx.out.line(divider());

    for (const cmd of cmds) {
      const name = cmd.usage ?? cmd.name;
      const padding = ' '.repeat(Math.max(0, maxName - name.length));
      ctx.out.line(`  ${palette.warning(name)}${padding} ${palette.dim(cmd.summary)}`);
    }
    ctx.out.line();
    ctx.out.line(palette.dim('  Tip: Ctrl+C interrupts a running turn; a second press exits.'));
    ctx.out.line(palette.dim('  Hidden: /keys for keybindings · @ to attach files · !cmd to run shell · Shift+Tab to change mode'));
    ctx.out.line();
    return 'continue';
  },
};

export const coreCommands: SlashCommand[] = [exitCmd, clearCmd, compactCmd, rewindCmd, helpCmd];
