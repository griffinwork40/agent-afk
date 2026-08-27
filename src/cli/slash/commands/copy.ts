/**
 * /copy (alias /cp) — copy agent output to the system clipboard.
 *
 * Three modes:
 *   - `/copy`       — copies the last assistant turn's raw markdown (the whole
 *                     response, clean of ANSI and tool-lane chrome).
 *   - `/copy N`     — copies the Nth code block from the last turn, using the
 *                     render-time register populated by `renderCodeBlock()`. The
 *                     index matches the dim `/cp N` hint shown on each code block
 *                     header, so users never have to count.
 *   - `/copy plain` — strips markdown syntax first; suitable for Slack, email,
 *                     and other plain-text contexts.
 *
 * Gated on interactive REPL + TTY (same guard as /fork) so Telegram/daemon
 * callers never fire OSC 52 escape bytes at the wrong terminal.
 */

import { palette } from '../../palette.js';
import { copyToClipboard } from '../../clipboard.js';
import { getCodeBlock, getCodeBlocks } from '../../code-block-register.js';
import { stripMarkdown } from './copy.strip-markdown.js';
import type { SlashCommand } from '../types.js';

export const copyCmd: SlashCommand = {
  name: '/copy',
  aliases: ['/cp'],
  summary: 'Copy last response or a code block to clipboard',
  usage: '/copy [N|plain]',
  hint: 'When you need to paste agent output into another terminal or editor. Use /cp N to grab a specific code block — the index is shown on each block header. Use /copy plain for Slack/email-friendly output.',
  async handler(ctx, args) {
    const { stats, out } = ctx;

    // Interactive-surface guard (same as /fork): only attempt clipboard on a
    // local interactive REPL with a real TTY. Without this, a Telegram/daemon
    // caller on a host with its own TTY would fire OSC 52 escape bytes into
    // the host's terminal while claiming "copied" to the remote user.
    const interactive =
      typeof ctx.requestResume === 'function' && process.stdout.isTTY === true;

    if (!interactive) {
      out.warn('Clipboard not available on this surface — use /transcript to review output.');
      return 'continue';
    }

    // Guard: need at least one completed turn.
    if (stats.turns.length === 0) {
      out.info('Nothing to copy — no assistant responses yet.');
      return 'continue';
    }

    const lastTurn = stats.turns[stats.turns.length - 1];
    const assistantText = lastTurn?.assistant;
    if (!assistantText) {
      out.info('Last turn has no assistant response.');
      return 'continue';
    }

    const trimmed = args.trim();

    // `/copy N` — grab a specific code block by index.
    if (trimmed && /^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      const block = getCodeBlock(n);
      if (!block) {
        const all = getCodeBlocks();
        if (all.length === 0) {
          out.info('No code blocks in the last response.');
        } else {
          out.warn(
            `Block ${n} not found — last response has ${all.length} code block${all.length === 1 ? '' : 's'} ` +
            `(1–${all.length}).`,
          );
        }
        return 'continue';
      }

      const copied = copyToClipboard(block.text);
      if (copied) {
        const lines = block.text.split('\n').length;
        out.success(
          `Copied block ${n} ` +
          palette.dim(`(${block.lang}, ${lines} line${lines === 1 ? '' : 's'})`) +
          palette.dim(' to clipboard'),
        );
      } else {
        out.warn('Clipboard write failed — the block content is in /transcript.');
      }
      return 'continue';
    }

    // `/copy plain` — strip markdown, then copy.
    if (trimmed === 'plain') {
      const plain = stripMarkdown(assistantText);
      const copied = copyToClipboard(plain);
      if (copied) {
        const chars = plain.length;
        const lines = plain.split('\n').length;
        out.success(
          `Copied last response (plain) ` +
          palette.dim(`(${chars} chars, ${lines} line${lines === 1 ? '' : 's'})`) +
          palette.dim(' to clipboard'),
        );
      } else {
        out.warn('Clipboard write failed — the full response is in /transcript.');
      }
      return 'continue';
    }

    // Unrecognized non-empty arg — help the user.
    if (trimmed) {
      out.warn(`Unknown argument "${trimmed}". Usage: /copy (whole response), /copy N (code block N), or /copy plain (strip markdown).`);
      return 'continue';
    }

    // `/copy` (no args) — copy the whole last assistant response.
    const copied = copyToClipboard(assistantText);
    if (copied) {
      const chars = assistantText.length;
      const lines = assistantText.split('\n').length;
      out.success(
        `Copied last response ` +
        palette.dim(`(${chars} chars, ${lines} line${lines === 1 ? '' : 's'})`) +
        palette.dim(' to clipboard'),
      );
    } else {
      out.warn('Clipboard write failed — the full response is in /transcript.');
    }

    return 'continue';
  },
};
