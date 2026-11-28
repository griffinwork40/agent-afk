import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { fakeHandle, ScriptedSession } from './__test-utils__/acp-fake-session.js';
import { scriptFor } from './__test-utils__/acp-scripts.js';
import { AgentFrameValidator, fixtureRoot, schemaErrors, type Row } from './__test-utils__/acp-frame-schema.js';
import { GoldenConnection, replayGolden } from './__test-utils__/acp-replay.js';
import { seedHistory } from './__test-utils__/acp-history.js';
import { loadJournalMessages } from '../../agent/journal/reader.js';

// Only model/tool session construction is replaced. Keep the real teardown helper.
vi.mock('./acp.session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./acp.session.js')>();
  return { ...actual, buildAcpSession: vi.fn() };
});
import { buildAcpSession } from './acp.session.js';

const files = readdirSync(new URL('transcripts/', fixtureRoot)).filter(name => name.endsWith('.ndjson')).sort();
let temporaryRoot: string;
let root: string;
let connections: GoldenConnection[];
let sessions: ScriptedSession[];
let extraDirs: string[] = [];

beforeEach(() => {
  temporaryRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'acp-golden-')));
  root = temporaryRoot;
  connections = [];
  sessions = [];
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(env, 'AFK_STATE_DIR', 'get').mockReturnValue(path.join(root, 'state'));
  vi.mocked(buildAcpSession).mockReset();
});
afterEach(async () => {
  // Abort first: even a failed comparison during an outstanding permission must not hang cleanup.
  for (const session of sessions) session.abort();
  try { for (const connection of connections) await connection.close(); }
  finally {
    vi.restoreAllMocks();
    rmSync(temporaryRoot, { recursive: true, force: true });
    for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
    extraDirs = [];
  }
});
/** A launch directory that is a sibling of the session root, never an ancestor of it. */
function launchElsewhere(): string {
  const dir = path.join(temporaryRoot, '..', `${path.basename(temporaryRoot)}-launch`);
  mkdirSync(dir, { recursive: true });
  extraDirs.push(dir);
  expect(path.relative(dir, root).startsWith('..')).toBe(true);
  return dir;
}
function connect(): GoldenConnection {
  const connection = new GoldenConnection();
  connections.push(connection);
  return connection;
}
function rowsFor(file: string): Row[] {
  return readFileSync(new URL(`transcripts/${file}`, fixtureRoot), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Row);
}

describe('ACP golden transcripts against the real server (A1/A2/A3/A4 integration)', () => {
  it('has exactly one independent internal script for every frozen transcript', () => {
    expect(files).toHaveLength(12);
    for (const file of files) expect(scriptFor(file.replace('.ndjson', ''), root)).toBeDefined();
  });
  for (const file of files) {
    it(`replays ${file}`, async () => {
      const stem = file.replace('.ndjson', '');
      const script = scriptFor(stem, root);
      vi.mocked(buildAcpSession).mockImplementation(async options => {
        // D15: a live session journals under its own minted id, which a reload then replays.
        if (stem === 'load-live-session' && options.sessionId !== undefined) seedHistory(root, options.sessionId);
        const handle = fakeHandle(options, script);
        sessions.push(handle.session as unknown as ScriptedSession);
        return handle;
      });
      if (stem === 'load-replay' || stem === 'resume') seedHistory(root);
      // D14: the server is launched somewhere unrelated to the session directory.
      if (stem === 'session-cwd-outside-launch') vi.mocked(process.cwd).mockReturnValue(launchElsewhere());
      await replayGolden(connect(), rowsFor(file), root, stem);
      expect(script.executed, `${stem}: only approved tools execute`).toEqual(
        (['tool-read', 'tool-edit-diff', 'tool-bash-failed'] as string[]).includes(stem) ? ['tool-1'] : [],
      );
      // Replay may construct a provider but must never execute historical calls.
      if (stem === 'load-replay' || stem === 'load-live-session') expect(script.asked).toEqual([]);
      // D15: reloading a live session reuses its handle; nothing is rebuilt.
      if (stem === 'load-live-session') expect(buildAcpSession).toHaveBeenCalledTimes(1);
    });
  }
});

describe('A6 harness self-checks (independent of migration implementation)', () => {
  it('drives initialize over real streams and validates a deliberately corrupt observed reply', async () => {
    const connection = connect();
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };
    connection.send(initialize);
    const observed = await connection.frameAt(0, 'harness initialize');
    expect(observed['jsonrpc']).toBe('2.0');
    expect(observed['id']).toBe(1);
    expect(observed).toHaveProperty('result');
    // Passes on old and migrated servers: validation failure is not a permanent old-server assertion.
    const corrupt = { ...observed, result: { ...observed['result'] as object, protocolVersion: '1.0' } };
    const validator = new AgentFrameValidator();
    validator.client(initialize);
    expect(validator.errors(corrupt).join('\n')).toContain('InitializeResponse');
    expect(schemaErrors('InitializeResponse', corrupt.result)).toBeDefined();
  });

  it('seeds a real loadable journal with correlated historical tool blocks', () => {
    seedHistory(root);
    const messages = loadJournalMessages('11111111-1111-4111-8111-111111111111');
    expect(messages).toHaveLength(4);
    expect(messages?.[1]?.content[0]).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'read_file' });
    expect(messages?.[2]?.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tool-1' });
  });

  // Permission bridge removed: canUseTool self-check no longer applies.
});
