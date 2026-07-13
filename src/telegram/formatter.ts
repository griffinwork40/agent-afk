/**
 * Message formatting utilities for Telegram
 * @module telegram/formatter
 */

/**
 * Maximum message length for Telegram (4096 chars)
 */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a long message into chunks that fit Telegram's limit
 * Tries to split on newlines or sentences when possible
 * 
 * @param text - Text to split
 * @param maxLength - Maximum length per chunk (default: 4096)
 * @returns Array of message chunks
 */
export function splitLongMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitIndex = maxLength;
    
    // Look for newline within last 500 chars of the chunk
    const newlineIndex = remaining.lastIndexOf('\n', maxLength);
    if (newlineIndex > maxLength - 500 && newlineIndex > 0) {
      splitIndex = newlineIndex + 1;
    } else {
      // Look for sentence end (. ! ?) within last 200 chars
      const sentenceMatch = remaining.slice(0, maxLength).match(/[.!?]\s+(?=[A-Z])/g);
      if (sentenceMatch && sentenceMatch.length > 0) {
        const lastMatch = sentenceMatch[sentenceMatch.length - 1];
        if (lastMatch) {
          const lastSentenceEnd = remaining.lastIndexOf(lastMatch, maxLength);
          if (lastSentenceEnd > maxLength - 200 && lastSentenceEnd > 0) {
            splitIndex = lastSentenceEnd + 2;
          }
        }
      } else {
        // Look for any space within last 100 chars
        const spaceIndex = remaining.lastIndexOf(' ', maxLength);
        if (spaceIndex > maxLength - 100 && spaceIndex > 0) {
          splitIndex = spaceIndex + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

/**
 * Convert markdown to Telegram HTML for parse_mode: 'HTML'.
 * Escapes & < > then converts **bold**, *italic*, `code`, fenced blocks, links.
 * Use with ctx.reply(text, { parse_mode: 'HTML' }) so formatting renders in chat.
 *
 * Implementation note: fenced blocks and inline code spans are extracted to
 * STX/ETX-delimited placeholder tokens (\x02FENCED<n>\x03, \x02CODE<n>\x03)
 * before bold/italic/link transforms run — preventing those regexes from
 * firing inside code content.  Sentinels are restored at the end.  Step 0
 * strips any raw \x02/\x03 bytes from the input to prevent sentinel collision.
 *
 * @param text - Markdown from agent (e.g. streamed content)
 * @returns HTML string safe for Telegram HTML parse_mode
 */
export function markdownToTelegramHtml(text: string): string {
  // 0. Strip any bare STX/ETX bytes from input so they can't collide with
  //    the placeholder sentinels used below.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x02\x03]/g, '');

  // 1. Escape HTML so we don't break tags or inject markup.
  // This runs before code conversion so that content inside code fences is
  // properly escaped (e.g. `x < 5` → `x &lt; 5`).
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Extract fenced code blocks to STX/ETX-delimited placeholders so that
  //    subsequent bold/italic passes don't corrupt content inside them.
  //    STX (\x02) and ETX (\x03) cannot appear in normal markdown text (step 0).
  //    Require a newline after the opening fence (T2 fix): ```identifier``` on a
  //    single line would misparse the word after ``` as a language tag and drop it.
  const fencedBlocks: string[] = [];
  out = out.replace(/^ {0,3}```([\w]*)\n([\s\S]*?)```/gm, (_match, lang: string, inner: string) => {
    const idx = fencedBlocks.length;
    // Loud-fail empty fences. Without this guard, the lazy [\s\S]*? capture
    // returns inner='' for ```lang\n``` and emits <pre></pre>, which Telegram
    // renders as a visually blank gap that silently swallows the language tag.
    // A model that emits "you can run:\n```bash\n```" then prose ends up looking
    // like it forgot to include the command — which it did, but the renderer
    // should surface that, not hide it.
    if (inner.trim() === '') {
      const label = lang ? `(empty ${lang} block)` : '(empty code block)';
      fencedBlocks.push(`<i>${label}</i>`);
    } else {
      fencedBlocks.push(`<pre>${inner}</pre>`);
    }
    return `\x02FENCED${idx}\x03`;
  });

  // 3. Extract inline code spans to placeholders for the same reason.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, inner: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${inner}</code>`);
    return `\x02CODE${idx}\x03`;
  });

  // 4. Bold ** or __
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/__([^_]+)__/g, '<b>$1</b>');

  // 5. Italic * or _.
  // For * we keep the simple non-star guard.
  // For _ we require non-word context on both sides so that identifiers like
  // snake_case_names and __dunder__ are never italicised.
  out = out.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  // External constraint: underscore-italic must only match at word boundaries,
  // not inside identifiers. The leading non-word char (or start-of-string) is
  // captured in group 1 and re-emitted so it is not consumed.
  out = out.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/gm, '$1<i>$2</i>');

  // 6. Strikethrough
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // 7. Links [text](url).
  // The & in the URL was already escaped to &amp; in step 1; do NOT re-escape
  // it here or we produce &amp;amp; in the href attribute.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, url: string) =>
      '<a href="' + url.replace(/"/g, '&quot;') + '">' + label + '</a>'
  );

  // 8. Headers: drop # prefix, keep text
  out = out.replace(/^#{1,6}\s+/gm, '');

  // 9. Safety net: interleaved/overlapping emphasis markers (e.g. "**a _b** c_")
  // can yield improperly-NESTED tags like "<b>a <i>b</b> c</i>", which Telegram
  // rejects with HTTP 400 "can't parse entities" — failing or degrading the send.
  // Code/pre/link tags are emitted as atomic, always-balanced units, so any
  // imbalance is necessarily from emphasis (<b>/<i>/<s>); drop just those to
  // recover guaranteed-valid, readable HTML instead of breaking the message.
  //
  // Invariant: this MUST precede the code/fenced restore below. While they are
  // still placeholders, the balance check and strip see only real emphasis/link
  // tags — never the restored content. That matters because an empty fence is
  // emitted as a <i>(empty … block)</i> placeholder; restoring it first would
  // expose that <i> to the strip and silently de-italicise the label whenever an
  // unrelated mis-nested emphasis run in the same message trips the net.
  if (!telegramHtmlTagsBalanced(out)) {
    out = out.replace(/<\/?[bis]>/g, '');
  }

  // 10. Restore code spans, then fenced blocks, AFTER the safety net — so no regex
  // re-scans the restored HTML content and the empty-fence <i> label survives the
  // strip above. Inline code before fenced to prevent nested substitution.
  out = out.replace(/\x02CODE(\d+)\x03/g, (_m, i: string) => codeSpans[Number(i)] ?? _m);
  out = out.replace(/\x02FENCED(\d+)\x03/g, (_m, i: string) => fencedBlocks[Number(i)] ?? _m);

  return out;
}

/**
 * True iff every HTML tag in `html` is properly closed and correctly nested — a
 * simple stack check over the tags markdownToTelegramHtml emits (b, i, s, code,
 * pre, a). Used as a safety net so a mis-nested emphasis run never produces HTML
 * that Telegram rejects with a 400 "can't parse entities".
 */
function telegramHtmlTagsBalanced(html: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = (m[2] ?? '').toLowerCase();
    if (m[1] === '/') {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

/**
 * Escape HTML special characters for use in Telegram HTML parse mode.
 * Escapes & (must be first), <, >, and ".
 *
 * @param text - Plain text to escape
 * @returns HTML-safe string
 */
export function escapeHtml(text: string): string {
  // Ampersand MUST be replaced first — otherwise '&lt;' would become '&amp;lt;'
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a filesystem error (ENOENT/EACCES) for display to the user.
 *
 * @param code - NodeJS errno code (e.g. 'ENOENT', 'EACCES')
 * @param path - The resolved filesystem path that caused the error
 * @returns User-facing error string
 */
export function formatSystemError(code: string, path: string): string {
  if (code === 'ENOENT') return `❌ Directory not found: ${path}`;
  if (code === 'EACCES') return `❌ Permission denied: ${path}`;
  return `❌ Unexpected error (${code}): ${path}`;
}

/**
 * Format a queue-position acknowledgment for an enqueued message.
 *
 * @param depth - 1-based position in the queue
 * @returns User-facing status string
 */
export function formatQueued(depth: number): string {
  return `⏳ Queued (#${depth} in line)`;
}

/**
 * Escape Telegram MarkdownV2 special characters
 * 
 * @param text - Text to escape
 * @returns Escaped text safe for MarkdownV2
 */
export function escapeMarkdown(text: string): string {
  // Characters that need escaping in MarkdownV2
  // Invariant: backslash MUST be the first element. The escape mechanism prepends \ to each match;
  // if \ ran later, every \ we just prepended would be re-escaped to \\ and Telegram would render
  // a literal double-backslash instead of an escape sequence.
  const specialChars = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  
  let escaped = text;
  for (const char of specialChars) {
    escaped = escaped.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }
  
  return escaped;
}

/**
 * Format error message for Telegram
 * 
 * @param error - Error object or message
 * @returns Formatted error message
 */
export function formatError(error: Error | string): string {
  const message = error instanceof Error ? error.message : error;
  return `❌ Error: ${message}`;
}

/**
 * Return a fixed opaque error message for unexpected internal failures.
 * Never interpolates runtime data — safe to send to any chat regardless
 * of what the underlying error contains.
 */
export function formatInternalError(): string {
  return '⚠️ An internal error occurred. Please try again.';
}

/**
 * Format slash-command help text (aligned with CLI interactive /help).
 * Optionally appends SDK-native slash commands when session used settingSources.
 *
 * @param sdkCommands - Optional list of slash command names from session.getSessionMetadata().slashCommands
 * @returns Help message listing bot commands and any SDK session commands
 */
export function formatHelp(sdkCommands?: string[]): string {
  const lines = [
    '📋 Commands:',
    '',
    '  /start      — Show welcome',
    '  /help       — Show this list',
    '  /clear      — Clear conversation history',
    '  /compact    — Summarize older messages',
    '  /model      — Switch Claude model',
    '  /cd         — Change working directory',
    '  /name       — Show or set the session name',
    '  /watch      — Live-tail a CLI session from this chat',
    '  /unwatch    — Stop watching a session',
    '',
    'Also works from the CLI.',
  ];
  if (sdkCommands && sdkCommands.length > 0) {
    lines.push(
      '',
      '📋 Session commands (from SDK, when using settingSources):',
      '',
      ...sdkCommands.map((name) => `  /${name.replace(/^\//, '')}`),
    );
  }
  lines.push('', 'Just send a message to chat with Claude.');
  return lines.join('\n');
}

/**
 * Format welcome message — short, action-oriented.
 * Shows the 3 most-used commands; refers to /help for the full list.
 * @returns Welcome message text
 */
export function formatWelcome(): string {
  return `👋 Welcome! I'm an agent-afk bot powered by Claude.

Send me a message to get started, or try:
  /clear — clear conversation history
  /model — switch model
  /cd    — change working directory

Type /help for all commands.`;
}

/**
 * Format model switch confirmation
 * 
 * @param model - New model name
 * @returns Confirmation message
 */
export function formatModelSwitch(model: string): string {
  const modelEmoji: Record<string, string> = {
    opus: '🚀',
    sonnet: '⚡',
    haiku: '🌸',
  };
  
  const emoji = modelEmoji[model] || '🤖';
  return `${emoji} Switched to Claude ${model.toUpperCase()}`;
}

/**
 * Format session clear confirmation (SDK /clear).
 *
 * @returns Clear confirmation message
 */
export function formatClear(): string {
  return '🔄 Conversation history cleared!';
}

/**
 * Format the current-cwd reply for `/cd` with no args.
 *
 * @param cwd - Effective cwd (per-session override or bot fallback), or undefined
 * @returns Status message
 */
export function formatCwdCurrent(cwd: string | undefined): string {
  if (!cwd) {
    return '📂 No cwd override set — using bot process default.\n\nUsage: /cd <path>';
  }
  return `📂 Current cwd: ${cwd}\n\nUsage: /cd <path>`;
}

/**
 * Format the cwd-switch confirmation. Notes that the next message starts
 * a fresh session — important UX signal because the current conversation
 * history is preserved but the AgentSession itself is torn down.
 *
 * @param cwd - The newly-set absolute path
 * @returns Confirmation message
 */
export function formatCwdSwitch(cwd: string): string {
  return `📂 cwd set to: ${cwd}\n\nNext message starts a fresh session in this directory.`;
}

/**
 * Format the current-name reply for `/name` with no args.
 *
 * @param name - The session's current name, or undefined when none is set
 * @returns Status message
 */
export function formatNameCurrent(name: string | undefined): string {
  if (!name) {
    return '🏷️ No name set.\n\nUsage: /name <name>';
  }
  return `🏷️ Session name: ${name}\n\nUsage: /name <name>`;
}

/**
 * Format the rejection shown when a supplied name slugifies to nothing
 * (e.g. only punctuation or symbols).
 *
 * @returns User-facing error string
 */
export function formatNameInvalid(): string {
  return formatError('Invalid name — use letters, numbers, spaces, or hyphens.');
}

/**
 * Format the `/name` set-confirmation. When `resumeCommand` is provided the
 * name was persisted now and the CLI resume line is shown; otherwise the name
 * was only set in memory and will be saved on the first turn.
 *
 * @param name - The slugified name that was set
 * @param resumeCommand - CLI resume command (e.g. `afk interactive --resume <name>`), or undefined
 * @returns Confirmation message
 */
export function formatNameSet(name: string, resumeCommand?: string): string {
  if (resumeCommand) {
    return `🏷️ Named: ${name}\n\nResume from CLI:\n${resumeCommand}`;
  }
  return `🏷️ Named: ${name} (saves on first turn)`;
}

/**
 * Format session reset confirmation (alias for formatClear for backward compatibility).
 *
 * @returns Reset confirmation message
 */
export function formatReset(): string {
  return formatClear();
}

/**
 * Format compact confirmation. With counts, surfaces how much shrank and
 * the rough token saving so the user sees the win.
 */
export function formatCompact(opts?: {
  before: number;
  after: number;
  tokensSavedEstimate?: number;
}): string {
  if (!opts) {
    return '📦 Conversation compacted (older messages summarized).';
  }
  const saved =
    opts.tokensSavedEstimate !== undefined && opts.tokensSavedEstimate > 0
      ? ` (~${formatTokenCount(opts.tokensSavedEstimate)} input tokens saved)`
      : '';
  return `📦 Compacted ${opts.before} → ${opts.after} messages${saved}.`;
}

/**
 * Format a no-op compaction notice. Reasons come from
 * `ProviderCompactResult.reason` (e.g. `history-too-short`, `not-supported`,
 * `aborted`, `summarization-failed: ...`).
 */
export function formatCompactNoop(reason: string): string {
  if (reason === 'aborted') return '📦 Compaction cancelled.';
  if (reason === 'history-too-short') return '📦 Not enough history to compact yet.';
  if (reason === 'not-supported') return "📦 Compaction isn't available for the current model.";
  if (reason.startsWith('summarization-failed')) {
    return `⚠️ Compaction failed: ${reason}. History unchanged.`;
  }
  return `📦 Nothing to compact (${reason}).`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

/**
 * Format the `/sessions` list body — one line per resumable conversation for
 * this chat, active one marked. Tappable switch buttons are attached by the
 * handler; this is the text shown above them. Structural param (a superset of
 * SessionManager.ChatSessionInfo) keeps the formatter decoupled from that module.
 */
export function formatSessionsList(
  sessions: ReadonlyArray<{ name?: string; model: string; turns: number; active: boolean }>,
): string {
  const lines = sessions.map((s, i) => {
    const marker = s.active ? '✅ ' : '';
    const label = s.name ? escapeHtml(s.name) : '(unnamed)';
    const turns = s.turns === 1 ? '1 turn' : `${s.turns} turns`;
    return `${i + 1}. ${marker}<b>${label}</b> · ${escapeHtml(s.model)} · ${turns}`;
  });
  return `🗂️ <b>Your sessions</b> (${sessions.length})\n\n${lines.join('\n')}\n\nTap one to switch. /new starts a fresh session.`;
}

/** Reply when a chat has no resumable sessions yet. */
export function formatNoSessions(): string {
  return '🗂️ No saved sessions yet.\n\nSend a message to start one, or /new for a fresh session.';
}

/** /switch (button) confirmation — lazy resume continues on the next message. */
export function formatSwitched(session: { name?: string }): string {
  const label = session.name ? `<b>${escapeHtml(session.name)}</b>` : 'that session';
  return `↩️ Switched to ${label}. Your next message continues it.`;
}

/** /new confirmation — the previous conversation is preserved + resumable. */
export function formatNewSession(): string {
  return '🆕 Started a fresh session. Your previous one is saved — /sessions to switch back.';
}

/** Shown when a switch/new is attempted while the active session is mid-turn. */
export function formatSessionBusy(): string {
  return '⏳ Finish or wait for the current turn before switching sessions.';
}

/** Shown when a switch target can no longer be found. */
export function formatSwitchNotFound(): string {
  return formatError('That session could no longer be found. /sessions to see the current list.');
}

/** Shown when switching to the already-active session. */
export function formatAlreadyActive(): string {
  return "✅ You're already on that session.";
}
