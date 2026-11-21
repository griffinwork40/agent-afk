import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { debugLog, isDebugEnabled } from '../../utils/debug.js';
import { fakeHandle, type ScriptedSession } from './__test-utils__/acp-fake-session.js';
import { scriptFor } from './__test-utils__/acp-scripts.js';

vi.mock('./acp.session.js', async importOriginal => ({
  ...await importOriginal<typeof import('./acp.session.js')>(), buildAcpSession: vi.fn(),
}));
import { buildAcpSession } from './acp.session.js';
import { exitAfterServer, runAcpServer } from './acp.server.js';

afterEach(() => { vi.restoreAllMocks(); });

const request = (id: number, method: string, params: unknown) => ({ jsonrpc: '2.0', id, method, params });
function connect(output: Writable = new PassThrough()) {
  const input = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  if (output instanceof PassThrough) output.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) frames.push(JSON.parse(line) as Record<string, unknown>);
  });
  const done = runAcpServer({ model: 'o3', maxTurns: 10, input, output, shutdownDeadlineMs: 50, cancelGraceMs: 5 });
  return { input, output, frames, done, send(frame: unknown) { input.write(JSON.stringify(frame) + '\n'); } };
}
async function openSession(connection: ReturnType<typeof connect>): Promise<string> {
  connection.send(request(1, 'initialize', { protocolVersion: 1 }));
  await vi.waitFor(() => { expect(connection.frames).toHaveLength(1); });
  connection.send(request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] }));
  await vi.waitFor(() => { expect(connection.frames).toHaveLength(2); });
  return (connection.frames[1]!['result'] as { sessionId: string }).sessionId;
}

const epipe = () => Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

describe('ACP connection output safety', () => {
  it.each(['AFK_DEBUG', 'DEBUG'] as const)('keeps session construction debug output off the real stdout (%s)', async flag => {
    vi.spyOn(env, 'AFK_DEBUG', 'get').mockReturnValue(flag === 'AFK_DEBUG' ? '1' : undefined);
    vi.spyOn(env, 'DEBUG', 'get').mockReturnValue(flag === 'DEBUG' ? '1' : undefined);
    expect(isDebugEnabled()).toBe(true); // Live getter today; exercise the real debug helper, not a mock.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encoding, callback) => {
      stdout.push(String(chunk));
      // Like a real Writable, report completion asynchronously to the serial writer.
      const complete = typeof encoding === 'function' ? encoding : callback;
      setImmediate(() => complete?.());
      return true;
    });
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      debugLog('provider construction diagnostic');
      console.info('plugin info'); console.debug('plugin debug');
      return fakeHandle(options, scriptFor('text-turn', options.cwd ?? process.cwd()));
    });
    const originals = { log: console.log, info: console.info, debug: console.debug };
    // First exercise injected streams; diagnostics must not leak to real stdout either.
    const injected = connect();
    await openSession(injected);
    injected.input.end(); await injected.done;
    expect(stdout).toEqual([]);
    // Then use the actual process.stdout object as the frame sink.
    const input = new PassThrough();
    const done = runAcpServer({ model: 'o3', maxTurns: 1, input, output: process.stdout });
    input.write(JSON.stringify(request(1, 'initialize', { protocolVersion: 1 })) + '\n');
    await vi.waitFor(() => { expect(stdout).toHaveLength(1); });
    input.write(JSON.stringify(request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] })) + '\n');
    await vi.waitFor(() => { expect(stdout).toHaveLength(2); });
    input.end(); await done;
    expect(stdout.flatMap(chunk => chunk.trim().split('\n')).map(line => JSON.parse(line) as unknown))
      .toEqual([expect.objectContaining({ jsonrpc: '2.0', id: 1 }), expect.objectContaining({ jsonrpc: '2.0', id: 2 })]);
    expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain('provider construction diagnostic');
    expect(console.log).toBe(originals.log);
    expect(console.info).toBe(originals.info);
    expect(console.debug).toBe(originals.debug);
  });

  it('tears down an open session and active turn after output EPIPE without waiting for EOF', async () => {
    let session!: ScriptedSession;
    vi.mocked(buildAcpSession).mockImplementation(async options => {
      const handle = fakeHandle(options, scriptFor('cancel-during-stream', options.cwd ?? process.cwd()));
      session = handle.session as unknown as ScriptedSession;
      return handle;
    });
    const connection = connect();
    const originalListenerCount = connection.output.listenerCount('error') - 1;
    const sid = await openSession(connection);
    connection.send(request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Say hello' }] }));
    await vi.waitFor(() => { expect(connection.frames).toHaveLength(3); });
    expect(() => connection.output.emit('error', epipe())).not.toThrow();
    await expect(connection.done).resolves.toBeUndefined();
    expect(session.interrupt).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
    expect(connection.frames).toHaveLength(3); // Never write the cancelled reply to a broken sink.
    expect(connection.output.listenerCount('error')).toBe(originalListenerCount);
    expect(connection.input.destroyed).toBe(true);
  });

  it('handles an asynchronous write callback failure even when write returned true', async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { setImmediate(() => callback(epipe())); } });
    const connection = connect(output);
    connection.send(request(1, 'initialize', { protocolVersion: 1 }));
    await expect(connection.done).resolves.toBeUndefined();
    expect(output.destroyed).toBe(true);
    expect(output.listenerCount('error')).toBe(0);
  });

  it('restores console methods even when the input loop throws', async () => {
    const original = console.log;
    const connection = connect();
    connection.input.destroy(new Error('input failure'));
    await expect(connection.done).rejects.toThrow('input failure');
    expect(console.log).toBe(original);
  });

  it('absorbs a flush callback EPIPE after the server listener has been removed', async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { setImmediate(() => callback(epipe())); } });
    const exit = vi.fn();
    await expect(exitAfterServer(output, exit, 50)).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledOnce();
  });
});
