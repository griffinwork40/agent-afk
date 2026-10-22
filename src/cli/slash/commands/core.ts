/**
 * Core slash commands: /exit, /quit, /clear, /compact, /help
 *
 * These are the always-present navigation commands. They do not depend on
 * any Tier 2/3 infrastructure and remain functional even if other command
 * modules are removed.
 */

import { randomUUID } from 'node:crypto';
import ora from 'ora';
import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { list } from '../registry.js';
import { missingCapabilities } from '../capabilities.js';
import { writeList } from '../output-blocks.js';
import { clearConversation, compactConversation } from '../../../agent/session-control/index.js';
import { REPL_SPINNER_OPTIONS } from '../../commands/interactive/shared.js';
import { HookBlockedError, AbortError } from '../../../utils/errors.js';
import type { SlashCommand } from '../types.js';
import { rewindCmd } from './core.rewind.js';

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
      await clearConversation(ctx.session.current, ctx.stats, ctx.ledger);
      ctx.ui.clearScreen();
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
    // Explicit non-TTY surfaces receive text progress; legacy contexts without
    // capability declarations retain their original bare-ora fallback.
    const compositor = ctx.progress ? null : (ctx.getCompositor?.() ?? null);
    const corrId = randomUUID();
    let progressActive = false;
    let spinner: ReturnType<typeof ora> | null = null;
    let spinnerActive = false;
    // Single stop point reused on every exit path below (success and catch)
    // so the two flavors of "turn the spinner off" can never drift out of
    // sync — a spinner left enabled is a worse bug than the race it replaces.
    const stopSpinner = (): void => {
      if (progressActive) {
        progressActive = false;
        ctx.progress?.({ corrId, phase: 'end', label: 'Summarizing earlier turns...' });
      }
      if (!spinnerActive) return;
      if (compositor) {
        compositor.setSpinner({ enabled: false });
      } else {
        spinner?.stop();
      }
      spinnerActive = false;
    };
    try {
      const result = await compactConversation(ctx.session.current, (phase) => {
        if (phase === 'end') { stopSpinner(); return; }
        if (ctx.progress) {
          progressActive = true;
          ctx.progress({ corrId, phase: 'start', label: 'Summarizing earlier turns...' });
          return;
        }
        // Progress starts only after PreCompact permits it. Explicit non-TTY
        // surfaces capture text; legacy REPL contexts keep their ora fallback.
        if (compositor) {
          ctx.out.info('Summarizing earlier turns...');
          compositor.setSpinner({ enabled: true });
          spinnerActive = true;
        } else if (ctx.capabilities && !ctx.capabilities.has('tty')) {
          ctx.out.info('Summarizing earlier turns...');
        } else {
          spinner = ora({
            text: palette.meta('Summarizing earlier turns...'),
            ...REPL_SPINNER_OPTIONS,
          }).start();
          spinnerActive = true;
        }
      });
      const { promptsBefore, promptsAfter } = result;
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
            'Summarization is unavailable on this backend — it refused the compaction request earlier this session. Start a new session, or set AFK_COMPACT_MODEL to a model on a different provider (cross-provider compaction is supported).',
          );
        } else {
          ctx.out.info(`Nothing to compact (${reason}).`);
        }
      } else {
        const saved = result.tokensSavedEstimate
          ? ` (~${result.tokensSavedEstimate} input tokens saved)`
          : '';
        ctx.out.success(
          `Compacted ${promptsBefore} → ${promptsAfter} prompts${saved}.`,
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

const helpCmd: SlashCommand = {
  name: '/help',
  summary: 'Show this help',
  hint: 'When you want the full command list with usage strings — broader than this inline dropdown.',
  async handler(ctx) {
    // Contract: a surface that declares capabilities sees only the commands it
    // can run (web and Telegram listed refused ones like /editor before). The
    // REPL declares none, so its listing and bytes are unchanged.
    const provided = ctx.capabilities;
    const cmds = list().filter((cmd) => provided === undefined || missingCapabilities(cmd, provided).length === 0);
    const maxName = cmds.reduce((m, c) => Math.max(m, c.name.length), 0) + 2;

    writeList(ctx.out, {
      title: 'Commands',
      items: cmds.map((cmd) => ({ text: cmd.usage ?? cmd.name, description: cmd.summary })),
    }, () => {
      ctx.out.line();
      ctx.out.line(palette.bold(palette.brand('Commands')));
      ctx.out.line(divider());

      for (const cmd of cmds) {
        const name = cmd.usage ?? cmd.name;
        const padding = ' '.repeat(Math.max(0, maxName - name.length));
        ctx.out.line(`  ${palette.warning(name)}${padding} ${palette.dim(cmd.summary)}`);
      }
      ctx.out.line();
    });
    if (provided === undefined || provided.has('tty')) {
      ctx.out.line(palette.dim('  Tip: Ctrl+C interrupts a running turn; a second press exits.'));
      ctx.out.line(palette.dim('  Hidden: /keys for keybindings · @ to attach files · !cmd to run shell · Shift+Tab to change mode'));
      ctx.out.line();
    }
    return 'continue';
  },
};

export const coreCommands: SlashCommand[] = [exitCmd, clearCmd, compactCmd, rewindCmd, helpCmd];
