/**
 * Collector for afk `--format stream-json` events (docs/headless.md) read from
 * a remote run's `out.ndjson`.
 *
 * Contract: tolerant by design. Hosts run different afk versions, so unknown
 * event types and unparseable lines are ignored, never fatal. The final answer
 * is the last `message` event, unless content `chunk`s streamed after it (a
 * last round that never emitted its `message`), in which case those chunks are
 * the latest text and are returned instead.
 *
 * @module remote/remote-events
 */

export type TerminalEvent =
  | { type: 'done'; metadata?: Record<string, unknown> }
  | { type: 'error'; message: string };

export interface EventCollector {
  /** Feed one NDJSON line. Returns true when it was a terminal (`done`/`error`) event. */
  push(line: string): boolean;
  terminal(): TerminalEvent | undefined;
  finalMessage(): string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function createEventCollector(): EventCollector {
  let lastMessage: string | undefined;
  let chunks = '';
  let terminal: TerminalEvent | undefined;
  return {
    push(line) {
      const trimmed = line.trim();
      if (trimmed === '' || terminal !== undefined) return terminal !== undefined;
      let event: Record<string, unknown> | undefined;
      try {
        event = asRecord(JSON.parse(trimmed));
      } catch {
        return false;
      }
      if (event === undefined) return false;
      const type = event['type'];
      if (type === 'message') {
        const content = asRecord(event['message'])?.['content'];
        if (typeof content === 'string') { lastMessage = content; chunks = ''; }
      } else if (type === 'chunk') {
        const chunk = asRecord(event['chunk']);
        if (chunk?.['type'] === 'content' && typeof chunk['content'] === 'string') chunks += chunk['content'];
      } else if (type === 'done') {
        const metadata = asRecord(event['metadata']);
        terminal = metadata !== undefined ? { type: 'done', metadata } : { type: 'done' };
        return true;
      } else if (type === 'error') {
        const msg = asRecord(event['error'])?.['message'];
        terminal = { type: 'error', message: typeof msg === 'string' ? msg : 'unknown error' };
        return true;
      }
      return false;
    },
    terminal: () => terminal,
    finalMessage: () => (chunks !== '' ? chunks : lastMessage ?? ''),
  };
}
