/**
 * Tokenize raw stdin chunks for the global chat view into key events.
 *
 * Contract: a chunk wrapped in bracketed-paste markers, or any multi-character
 * chunk containing a line break, is a paste and becomes one `text` event (the
 * model flattens it), so pasted text is never sent without a separate Enter. A lone Esc byte is `escape`;
 * Ctrl+C anywhere in the chunk is `interrupt`. Unknown escape sequences are
 * dropped, never inserted.
 *
 * @module cli/commands/interactive/global-chat-keys
 */

export type ChatKey =
  | { kind: 'text'; text: string }
  | { kind: 'enter' } | { kind: 'backspace' } | { kind: 'clear' }
  | { kind: 'escape' } | { kind: 'interrupt' }
  | { kind: 'pageUp' } | { kind: 'pageDown' } | { kind: 'lineUp' } | { kind: 'lineDown' };

const PASTE_START = '\x1b[200~';
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.)?/s;
const NAMED: Readonly<Record<string, ChatKey>> = {
  '\x1b[5~': { kind: 'pageUp' }, '\x1b[6~': { kind: 'pageDown' },
  '\x1b[1;2A': { kind: 'lineUp' }, '\x1b[1;2B': { kind: 'lineDown' },
  '\x1b[a': { kind: 'lineUp' }, '\x1b[b': { kind: 'lineDown' },
};

export function parseKeys(input: Buffer | string): ChatKey[] {
  const s = typeof input === 'string' ? input : input.toString('utf8');
  if (s.includes('\x03')) return [{ kind: 'interrupt' }];
  if (s === '\x1b') return [{ kind: 'escape' }];
  if (s.startsWith(PASTE_START)) return [{ kind: 'text', text: s }];
  // A line break inside a multi-character chunk is pasted text, never a send.
  if (s.length > 1 && s !== '\r\n' && /[\r\n]/.test(s)) return [{ kind: 'text', text: s }];
  const keys: ChatKey[] = [];
  let text = '';
  const flush = (): void => { if (text) { keys.push({ kind: 'text', text }); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (ch === '\x1b') {
      const seq = ESC_SEQ.exec(s.slice(i))?.[0] ?? ch;
      flush();
      const named = NAMED[seq];
      if (named) keys.push(named);
      i += seq.length;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flush();
      if (!(ch === '\n' && s[i - 1] === '\r')) keys.push({ kind: 'enter' });
    } else if (ch === '\x7f' || ch === '\b') { flush(); keys.push({ kind: 'backspace' }); }
    else if (ch === '\x15') { flush(); keys.push({ kind: 'clear' }); }
    else if (ch.charCodeAt(0) >= 0x20) text += ch;
    i++;
  }
  flush();
  return keys;
}
