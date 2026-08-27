/**
 * Always-on per-subagent conversation JSONL logger.
 *
 * `SubagentLogWriter` records every `OutputEvent` from a subagent's
 * `sendMessageStream` into a JSONL file at
 * `~/.afk/state/subagent-logs/<sessionLabel>/<subagentId>.jsonl`.
 * This powers the `/tasks:view` replay command.
 *
 * Unlike `BgJobLogWriter` (background-job-only), this fires for ALL
 * subagents (foreground and background) unless opted out via
 * `AFK_SUBAGENT_LOG=0`.
 *
 * Design mirrors `BgJobLogWriter` — lazy stream open, pending-line queue,
 * silent error suppression (subagent must never fail due to log IO).
 * No metadata sidecar; the trace's `subagent_lifecycle` events carry
 * timing/status.
 *
 * @module agent/subagent/log
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { env } from '../../config/env.js';
import {
  getSubagentLogPath,
  getSubagentLogSessionDir,
} from '../../paths.js';
import type { OutputEvent } from '../types/session-types.js';

/** Maximum bytes per subagent log file (1 MB). Writes beyond this are dropped. */
const MAX_LOG_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class SubagentLogWriter {
  readonly logPath: string;
  private stream: fs.WriteStream | null = null;
  private errored = false;
  private closed = false;
  private streamReady = false;
  private pendingLines: string[] = [];
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private bytesWritten = 0;

  constructor(
    readonly sessionLabel: string,
    readonly subagentId: string,
  ) {
    this.logPath = getSubagentLogPath(sessionLabel, subagentId);
    try {
      fs.mkdirSync(getSubagentLogSessionDir(sessionLabel), { recursive: true });
    } catch {
      this.errored = true;
    }
  }

  /** Whether subagent logging is enabled (not opted out). */
  static isEnabled(): boolean {
    return env.AFK_SUBAGENT_LOG !== '0';
  }

  /**
   * Append an OutputEvent as a JSONL line.
   * Silently no-ops on error, after close, or when the file exceeds MAX_LOG_BYTES.
   */
  write(event: OutputEvent): void {
    if (this.errored || this.closed || this.bytesWritten >= MAX_LOG_BYTES) return;
    const line = JSON.stringify(event) + '\n';
    if (!this.stream) {
      this.pendingLines.push(line);
      this.openStream();
      return;
    }
    if (!this.streamReady) {
      this.pendingLines.push(line);
      return;
    }
    this.writeLine(line);
  }

  /** Close the write stream. Flushes pending lines first. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Wait for stream to be ready so pending lines are flushed.
    if (this.readyPromise) await this.readyPromise;
    return new Promise<void>((resolve) => {
      if (!this.stream || this.errored) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
    });
  }

  private openStream(): void {
    if (this.stream) return;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    try {
      const s = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf8', mode: 0o600 });
      this.stream = s;
      s.once('open', () => {
        this.streamReady = true;
        for (const line of this.pendingLines) this.writeLine(line);
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
      s.once('error', () => {
        this.errored = true;
        this.pendingLines = [];
        this.readyResolve?.();
        this.readyResolve = null;
      });
    } catch {
      this.errored = true;
      this.readyResolve?.();
      this.readyResolve = null;
    }
  }

  // Invariant: bytesWritten tracks bytes ATTEMPTED (queued to the stream),
  // not bytes confirmed persisted to disk. This matches BgJobLogWriter's
  // accepted tradeoff — the cap is best-effort, not a durability guarantee.
  private writeLine(line: string): void {
    if (this.errored || !this.stream || this.bytesWritten >= MAX_LOG_BYTES) return;
    this.bytesWritten += Buffer.byteLength(line, 'utf8');
    this.stream.write(line);
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class SubagentLogReader {
  /**
   * Read all events from a subagent's log file.
   * Yields parsed OutputEvent objects in write order.
   * Gracefully yields nothing on missing file or parse errors.
   */
  static async *readEvents(
    sessionLabel: string,
    subagentId: string,
  ): AsyncGenerator<OutputEvent> {
    const logPath = getSubagentLogPath(sessionLabel, subagentId);
    let fileStream: fs.ReadStream;
    try {
      fileStream = fs.createReadStream(logPath, { encoding: 'utf8' });
    } catch {
      return;
    }
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as OutputEvent;
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Graceful on read errors (file deleted mid-read, etc.)
    } finally {
      rl.close();
      fileStream.destroy();
    }
  }

  /**
   * List subagent IDs that have logs in a given session.
   * Returns an array of subagentId strings (derived from filenames).
   */
  static async list(sessionLabel: string): Promise<string[]> {
    const dir = getSubagentLogSessionDir(sessionLabel);
    try {
      const entries = await fs.promises.readdir(dir);
      return entries
        .filter(e => e.endsWith('.jsonl'))
        .map(e => e.slice(0, -6)); // strip .jsonl
    } catch {
      return [];
    }
  }
}
