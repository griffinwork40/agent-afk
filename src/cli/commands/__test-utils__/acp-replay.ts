import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { expect } from 'vitest';
import { runAcpServer } from '../acp.server.js';
import { getVersion } from '../../version.js';
import { AgentFrameValidator, type Frame, type Row } from './acp-frame-schema.js';
import { persistedId } from './acp-scripts.js';

/** Server model for golden replay: its verified context window is the transcripts' 200000. */
export const GOLDEN_MODEL = 'o3';

export function substitute(value: unknown, root: string, sessionId: string): unknown {
  if (typeof value === 'string') {
    if (value === persistedId) return sessionId;
    // Replace /workspace and /workspace/seg1/seg2/... with the real root,
    // rebuilding the path with the platform separator so Windows CI gets
    // backslashes throughout (e.g. /workspace/.git/config → C:\tmp\x\.git\config).
    return value.replace(/\/workspace((?:\/[\w.-]+)*)/g, (_match, rest: string) =>
      rest.length > 0 ? path.join(root, ...rest.slice(1).split('/')) : root);
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, root, sessionId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'agentInfo' && item && typeof item === 'object'
        ? { ...item, version: getVersion() } : substitute(item, root, sessionId)]));
  }
  return value;
}

function owner(frame: Frame): string {
  const params = frame['params'] as { update?: { sessionUpdate?: string } } | undefined;
  const update = params?.update?.sessionUpdate;
  if (update?.startsWith('tool')) return 'A2 acp.translate.ts';
  if (update) return 'A2 acp.translate.ts (or A4 acp.session-load.ts for replay)';
  return 'A1 acp.server.ts (A4 acp.session-load.ts for load/resume)';
}

export class GoldenConnection {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly frames: Frame[] = [];
  readonly schemaFailures: string[][] = [];
  readonly validator = new AgentFrameValidator();
  private changed?: () => void;
  private parseError?: Error;
  private stopped = false;
  private closed = false;
  private serverError?: unknown;
  private readonly reader = createInterface({ input: this.output, crlfDelay: Infinity });
  private readonly done: Promise<void>;
  constructor() {
    this.reader.on('line', line => {
      try {
        const frame = JSON.parse(line) as Frame;
        this.frames.push(frame);
        this.schemaFailures.push(this.validator.errors(frame));
      } catch (error) { this.parseError = new Error(`A1 emitted non-JSON stdout: ${line}`, { cause: error }); }
      this.changed?.();
    });
    // The golden usage_update size (200000) must come from a verified MODEL_CONTEXT_LIMITS
    // entry (profile D2 forbids guessing); `o3` is a 200k entry, `claude-sonnet-4-5` has none.
    this.done = runAcpServer({ model: GOLDEN_MODEL, maxTurns: 10, input: this.input, output: this.output })
      .catch((error: unknown) => { this.serverError = error; })
      .finally(() => { this.stopped = true; this.changed?.(); });
  }
  send(frame: Frame): void {
    this.validator.client(frame);
    this.input.write(`${JSON.stringify(frame)}\n`);
  }
  async frameAt(index: number, context: string): Promise<Frame> {
    while (!this.frames[index]) {
      if (this.parseError) throw this.parseError;
      if (this.stopped) throw new Error(`${context}: A1 server stopped before frame ${index + 1}: ${String(this.serverError)}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.changed = undefined;
          reject(new Error(`${context}: missing agent frame ${index + 1}; inspect A1 dispatch / A2 translator / A4 load`));
        }, 2000);
        this.changed = () => { clearTimeout(timer); this.changed = undefined; resolve(); };
      });
    }
    return this.frames[index]!;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    try {
      await Promise.race([this.done, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('A1 EOF cleanup hung (pending prompt)')), 2000);
        timer.unref();
        void this.done.then(() => clearTimeout(timer));
      })]);
      if (this.parseError) throw this.parseError;
      if (this.serverError) throw this.serverError;
    } finally {
      this.reader.close();
      this.input.destroy();
      this.output.destroy();
    }
  }
}

/** Feed each client row only after preceding agent rows have been observed and checked. */
export async function replayGolden(connection: GoldenConnection, rows: Row[], root: string, stem: string): Promise<void> {
  let sessionId = persistedId;
  let agentIndex = 0;
  for (const [line, row] of rows.entries()) {
    if (row.direction === 'client_to_agent') {
      connection.send(substitute(row.frame, root, sessionId) as Frame);
      continue;
    }
    const context = `${stem}.ndjson:${line + 1} (${owner(row.frame)})`;
    const actual = await connection.frameAt(agentIndex, context);
    // Only the opaque minted id is variable: never normalize status, fields, ids or order.
    const expectedResult = row.frame['result'] as { sessionId?: unknown } | undefined;
    const actualResult = actual['result'] as { sessionId?: unknown } | undefined;
    if (expectedResult?.sessionId === persistedId && typeof actualResult?.sessionId === 'string') {
      sessionId = actualResult.sessionId;
    }
    const expected = substitute(row.frame, root, sessionId);
    const errors = connection.schemaFailures[agentIndex] ?? [];
    expect(actual, `${context}; first differing agent frame ${agentIndex + 1}\nSchema: ${errors.join('\n') || 'valid'}`).toEqual(expected);
    expect(errors, `${context}: schema violation`).toEqual([]);
    agentIndex++;
  }
  await connection.close();
  expect(connection.frames, `${stem}: extra agent frames after golden transcript / EOF`).toHaveLength(agentIndex);
}
