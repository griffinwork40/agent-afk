import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { queryLspDiagnostics } from './lsp-diagnostics.js';
import { queryLspSymbol } from './lsp-symbols.js';
import { withPooledFile, type QueryContext } from '../../lsp/query.js';
import { DiagnosticsStore } from '../../lsp/diagnostics-store.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn() }));
vi.mock('../../lsp/query.js', async (original) => ({
  ...await original<typeof import('../../lsp/query.js')>(),
  withPooledFile: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('AFK_LSP_DIAGNOSTICS_TIMEOUT_MS', '100');
  vi.stubEnv('AFK_LSP_SYMBOLS_TIMEOUT_MS', '100');
  vi.mocked(readFile).mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('aborts during the diagnostics wait after the source read completes', async () => {
  vi.mocked(readFile).mockResolvedValueOnce('text');
  const diagnostics = new DiagnosticsStore();
  const waitFor = vi.spyOn(diagnostics, 'waitFor');
  const unsubscribe = vi.fn();
  const ctx = {
    client: { diagnostics, onExit: () => unsubscribe },
    sync: { uri: 'file:///source.ts', version: 1, changed: true },
    seqBeforeSync: 0,
    remainingMs: () => 100,
  } as unknown as QueryContext;
  vi.mocked(withPooledFile).mockImplementationOnce(async (_spec, _path, _content, _opts, fn) => fn(ctx));
  const controller = new AbortController();
  const result = queryLspDiagnostics('/source.ts', undefined, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(waitFor).toHaveBeenCalledWith('file:///source.ts', 1, 0, 100, controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  expect(await result).toEqual([]);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

const queries = [
  { name: 'diagnostics', run: (signal?: AbortSignal) => queryLspDiagnostics('/source.ts', undefined, signal), timeout: [], aborted: [] },
  { name: 'symbols', run: (signal?: AbortSignal) => queryLspSymbol('/source.ts', 'definition', 1, 1, undefined, undefined, signal),
    timeout: { locations: [], error: 'LSP symbols timed out (increase AFK_LSP_SYMBOLS_TIMEOUT_MS)' }, aborted: { locations: [], error: 'Aborted' } },
];

describe.each(queries)('$name source-read deadline', ({ run, timeout, aborted }) => {
  it('returns at the deadline even when readFile ignores its abort signal', async () => {
    const result = run();
    const options = vi.mocked(readFile).mock.calls[0]![1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual(timeout);
    expect(options.signal.aborted).toBe(true);
    expect(withPooledFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns on caller abort while the source read is stalled', async () => {
    const controller = new AbortController();
    const result = run(controller.signal);
    controller.abort();
    expect(await result).toEqual(aborted);
    expect(withPooledFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read when already aborted', async () => {
    expect(await run(AbortSignal.abort())).toEqual(aborted);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('deducts successful read time from the pooled query budget', async () => {
    vi.mocked(readFile).mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve('text'), 60)));
    vi.mocked(withPooledFile).mockResolvedValueOnce(null);
    const result = run();
    await vi.advanceTimersByTimeAsync(60);
    await result;
    expect(withPooledFile).toHaveBeenCalledWith(expect.anything(), '/source.ts', 'text',
      expect.objectContaining({ timeoutMs: 40 }), expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
