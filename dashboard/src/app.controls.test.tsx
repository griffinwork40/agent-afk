import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { clearCommandsCache } from './components/composer';
import { apiFetch } from './lib/api';
import type { CommandResponse } from './types/command-wire';

vi.mock('./lib/api', () => ({
  apiFetch: vi.fn(), getToken: () => null,
  ApiError: class extends Error {},
}));
vi.mock('./hooks/use-sessions', () => ({
  useSessions: () => ({
    sessions: [
      { id: 'one', mode: 'live', title: 'First session', model: 'haiku' },
      { id: 'two', mode: 'live', title: 'Second session', model: 'sonnet' },
    ], loading: false,
  }),
}));
vi.mock('./hooks/use-pending-approvals', () => ({
  usePendingApprovals: () => ({ approvals: [], pendingSessionIds: new Set() }),
}));
vi.mock('./hooks/use-scroll-pin', () => ({
  useScrollPin: () => ({ containerRef: { current: null }, scrollToBottom: vi.fn(), isPinned: true }),
}));

let streams: ReadableStreamDefaultController<Uint8Array>[];
let fetchStream: ReturnType<typeof vi.fn>;
let response: CommandResponse;

beforeEach(() => {
  vi.clearAllMocks();
  clearCommandsCache();
  streams = [];
  fetchStream = vi.fn().mockImplementation(async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }),
  }));
  vi.stubGlobal('fetch', fetchStream);
  response = { blocks: [], control: { kind: 'continue' } };
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/models') return { models: [] };
    if (url === '/api/commands') return { commands: [] };
    return response;
  });
});
afterEach(() => vi.unstubAllGlobals());

async function selectFirst() {
  render(<App />);
  fireEvent.click(screen.getAllByText('First session')[0]!.closest('button')!);
  await waitFor(() => expect(streams).toHaveLength(1));
  return screen.getByRole('textbox');
}
async function command(ta: HTMLElement, input: string) {
  fireEvent.change(ta, { target: { value: input } });
  fireEvent.keyDown(ta, { key: 'Enter' });
  await waitFor(() => expect((ta as HTMLTextAreaElement).value).toBe(''));
}
function record(stream: number, id: number, text: string) {
  streams[stream]!.enqueue(new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify({ record: { kind: 'user', text }, replay: true })}\n\n`));
}

describe('Dashboard session controls', () => {
  it('shows SSE choice dialog and inline progress, submits answer and dismisses via settlement', async () => {
    await selectFirst();
    const send = (event: unknown) => streams[0]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    act(() => {
      send({ type: 'choice_request', request: { corrId: 'pick', title: 'Select model', options: [
        { value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' },
      ], cancellable: true } });
      send({ type: 'progress', corrId: 'compact', phase: 'start', label: 'Compacting', fraction: 0.3 });
    });
    expect(await screen.findByRole('dialog', { name: 'Select model' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Compacting');
    fireEvent.click(screen.getByRole('radio', { name: 'Sonnet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/one/choices/pick', {
      method: 'POST', body: JSON.stringify({ value: 'sonnet' }),
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select model' })).toBeNull());
    act(() => {
      send({ type: 'choice_settled', corrId: 'pick' });
      send({ type: 'progress', corrId: 'compact', phase: 'end', label: 'Compacting' });
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('settlement from another tab and navigation both dismiss stale choices', async () => {
    await selectFirst();
    const frame = 'data: {"type":"choice_request","request":{"corrId":"remote","title":"Remote choice","options":[{"value":"yes","label":"Yes"}]}}\n\n';
    act(() => streams[0]!.enqueue(new TextEncoder().encode(frame)));
    await screen.findByRole('dialog', { name: 'Remote choice' });
    act(() => streams[0]!.enqueue(new TextEncoder().encode('data: {"type":"choice_settled","corrId":"remote"}\n\n')));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remote choice' })).toBeNull());
    act(() => streams[0]!.enqueue(new TextEncoder().encode(frame)));
    await screen.findByRole('dialog', { name: 'Remote choice' });
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    expect(screen.queryByRole('dialog', { name: 'Remote choice' })).toBeNull();
  });

  it('clear response before SSE reset retains fresh confirmation without reopening the reader', async () => {
    const ta = await selectFirst();
    act(() => {
      record(0, 1, 'Old transcript message');
      streams[0]!.enqueue(new TextEncoder().encode('id: 2\ndata: {"record":{"kind":"done"},"replay":true}\n\n'));
    });
    await screen.findByText('Old transcript message');
    response = { blocks: [{ text: 'Old command output', ansi: 'Old command output' }], control: { kind: 'continue' } };
    await command(ta, '/cost ');
    expect(screen.getByText('Old command output')).toBeTruthy();

    response = { blocks: [{ text: 'Conversation cleared.', ansi: 'Conversation cleared.' }], control: { kind: 'clear' } };
    await command(ta, '/clear ');
    act(() => streams[0]!.enqueue(new TextEncoder().encode('data: {"reset":true}\n\n')));
    await waitFor(() => expect(screen.queryByText('Old transcript message')).toBeNull());
    expect(streams).toHaveLength(1);
    expect(screen.queryByText('Old command output')).toBeNull();
    expect(screen.getByText('Conversation cleared.')).toBeTruthy();
    act(() => record(0, 1, 'New transcript message'));
    await screen.findByText('New transcript message');
    expect(screen.getByText('Conversation cleared.')).toBeTruthy();
  });

  it('server reset from another tab drops local output and queued prompts, then keeps new records', async () => {
    const ta = await selectFirst();
    response = {
      blocks: [{ kind: 'table', title: 'Obsolete local output', columns: ['Cost'], rows: [['$5']], text: 'Old cost $5', ansi: 'Old cost $5' }],
      control: { kind: 'continue' },
    };
    await command(ta, '/cost ');
    expect(screen.getByRole('table', { name: 'Obsolete local output' })).toBeTruthy();
    act(() => record(0, 1, 'Active old question'));
    await screen.findByText('Active old question');
    await command(ta, 'Queued before remote clear');
    await screen.findByText('Queued before remote clear');
    act(() => streams[0]!.enqueue(new TextEncoder().encode(
      'data: {"reset":true}\n\nid: new-generation:0\ndata: {"record":{"kind":"user","text":"Fresh remote generation"},"replay":false}\n\n',
    )));
    await screen.findByText('Fresh remote generation');
    expect(screen.queryByText('Active old question')).toBeNull();
    expect(screen.queryByText('Obsolete local output')).toBeNull();
    expect(screen.queryByText('Queued before remote clear')).toBeNull();
    expect(fetchStream).toHaveBeenCalledTimes(1);
  });

  it('SSE reset before clear response retains confirmation but a subsequent remote reset removes it', async () => {
    const ta = await selectFirst();
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === '/api/models') return { models: [] };
      if (url === '/api/commands') return { commands: [] };
      return new Promise((done) => { resolve = done; });
    });
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    act(() => streams[0]!.enqueue(new TextEncoder().encode('data: {"reset":true}\n\n')));
    await act(async () => resolve({ blocks: [{ text: 'Fresh confirmation', ansi: 'Fresh confirmation' }], control: { kind: 'clear' } }));
    await screen.findByText('Fresh confirmation');
    act(() => streams[0]!.enqueue(new TextEncoder().encode('data: {"reset":true}\n\n')));
    await waitFor(() => expect(screen.queryByText('Fresh confirmation')).toBeNull());
    expect(fetchStream).toHaveBeenCalledTimes(1);
  });

  it('failed clear keeps existing outputs and does not restart the stream', async () => {
    const ta = await selectFirst();
    response = { blocks: [{ text: 'Keep this output', ansi: 'Keep this output' }], control: { kind: 'continue' } };
    await command(ta, '/cost ');
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Reset failed'));
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await screen.findByText('Error: Reset failed');
    expect(screen.getByText('Keep this output')).toBeTruthy();
    expect(streams).toHaveLength(1);
    expect((ta as HTMLTextAreaElement).value).toBe('/clear ');
  });

  it('reflects authoritative /model in selector and sidebar, and session navigation restores each model', async () => {
    const ta = await selectFirst();
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/commands'))).toBe(false);
    response = { blocks: [], control: { kind: 'continue' }, session: { model: 'org/CaseSensitiveModel' } };
    await command(ta, '/model org/CaseSensitiveModel');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('org/CaseSensitiveModel');
    expect(screen.getAllByText('org/CaseSensitiveModel').length).toBeGreaterThan(1);
    expect(screen.getByTitle('Session model').textContent).toBe('org/CaseSensitiveModel');
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('sonnet');
    await act(async () => fireEvent.click(screen.getAllByText('First session')[0]!.closest('button')!));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('org/CaseSensitiveModel');
  });

  it('model selector sends /model and does not change model before successful metadata', async () => {
    await selectFirst();
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/one/commands', {
      method: 'POST', body: JSON.stringify({ input: '/model opus' }),
    }));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
    await act(async () => resolve({ blocks: [], control: { kind: 'continue' }, session: { model: 'opus' } }));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('opus');
  });

  it('does not optimistically update model when the server rejects the picker change', async () => {
    await selectFirst();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Model unavailable'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    await screen.findByText('Error: Model unavailable');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
  });

  it('ignores a delayed clear response after navigation to another session', async () => {
    const ta = await selectFirst();
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === '/api/models') return { models: [] };
      if (url === '/api/commands') return { commands: [] };
      return new Promise((done) => { resolve = done; });
    });
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    act(() => record(1, 1, 'Second session transcript'));
    await screen.findByText('Second session transcript');
    await act(async () => resolve({ blocks: [{ text: 'Old session cleared', ansi: 'Old session cleared' }], control: { kind: 'clear' } }));
    expect(screen.getByText('Second session transcript')).toBeTruthy();
    expect(screen.queryByText('Old session cleared')).toBeNull();
    expect(streams).toHaveLength(2);
  });

  it('/thinking metadata hides existing and new reasoning, and live restores retained data', async () => {
    const ta = await selectFirst();
    const thinking = (id: number, text: string) => streams[0]!.enqueue(new TextEncoder().encode(
      `id: ${id}\ndata: ${JSON.stringify({ record: { kind: 'thinking', text }, replay: true })}\n\n`,
    ));
    act(() => thinking(1, 'Existing reasoning'));
    await screen.findByText('Existing reasoning');
    response = { blocks: [], control: { kind: 'continue' }, session: { thinkingUi: 'off' } };
    await command(ta, '/thinking off');
    expect(screen.queryByText('Existing reasoning')).toBeNull();
    act(() => thinking(2, 'Reasoning while hidden'));
    await act(async () => {});
    expect(screen.queryByText('Reasoning while hidden')).toBeNull();

    // Other controls must not reset the display preference.
    response = { blocks: [], control: { kind: 'continue' }, session: { name: 'Still hidden' } };
    await command(ta, '/name Still hidden');
    expect(screen.queryByText('Existing reasoning')).toBeNull();
    response = { blocks: [], control: { kind: 'continue' }, session: { thinkingUi: 'live' } };
    await command(ta, '/thinking live');
    expect(screen.getByText('Existing reasoning')).toBeTruthy();
    expect(screen.getByText('Reasoning while hidden')).toBeTruthy();
    expect(streams).toHaveLength(1);
  });

  it('/thinking display preference remains scoped to its session', async () => {
    const ta = await selectFirst();
    response = { blocks: [], control: { kind: 'continue' }, session: { thinkingUi: 'off' } };
    await command(ta, '/thinking off');
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    act(() => streams[1]!.enqueue(new TextEncoder().encode('id: 1\ndata: {"record":{"kind":"thinking","text":"Second reasoning"},"replay":true}\n\n')));
    await screen.findByText('Second reasoning');
    await act(async () => fireEvent.click(screen.getAllByText('First session')[0]!.closest('button')!));
    act(() => streams[2]!.enqueue(new TextEncoder().encode('id: 1\ndata: {"record":{"kind":"thinking","text":"First hidden reasoning"},"replay":true}\n\n')));
    await act(async () => {});
    expect(screen.queryByText('First hidden reasoning')).toBeNull();
  });

  it('keeps structured blocks and authoritative metadata together through a clear boundary', async () => {
    const ta = await selectFirst();
    response = {
      blocks: [
        { kind: 'keyValue', title: 'Model details', entries: [{ key: 'Provider', value: 'Anthropic' }], text: 'Provider: Anthropic', ansi: 'Provider: Anthropic' },
        { kind: 'table', title: 'Usage details', columns: ['Metric', 'Value'], rows: [['Turns', '3']], text: 'Turns 3', ansi: 'Turns 3' },
        { kind: 'list', title: 'Available tools', items: [{ text: 'read_file', description: 'Read source files' }], text: 'read_file', ansi: 'read_file' },
        { kind: 'diff', fileName: 'example.ts', diff: '-before\n+after\n', text: '-before\n+after\n', ansi: '-before\n+after\n' },
        { kind: 'link', label: 'Provider docs', url: 'https://example.com/docs', text: 'Provider docs', ansi: 'Provider docs' },
      ],
      control: { kind: 'continue' },
      session: { model: 'opus', name: 'Structured session', thinkingUi: 'off' },
    };
    await command(ta, '/model opus');
    expect(screen.getByRole('table', { name: 'Usage details' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model details' })).toBeTruthy();
    expect(screen.getByText('Read source files')).toBeTruthy();
    expect(screen.getByText('+after')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Provider docs' }).getAttribute('href')).toBe('https://example.com/docs');
    expect(screen.getByTitle('Session model').textContent).toBe('opus');
    expect(screen.getAllByText('Structured session').length).toBeGreaterThan(0);

    response = {
      blocks: [{ kind: 'keyValue', title: 'Clear result', entries: [{ key: 'Conversation', value: 'Reset complete' }], text: 'Conversation: Reset complete', ansi: 'Conversation: Reset complete' }],
      control: { kind: 'clear' },
    };
    await command(ta, '/clear ');
    act(() => streams[0]!.enqueue(new TextEncoder().encode(
      'data: {"reset":true}\n\nid: fresh:0\ndata: {"record":{"kind":"thinking","text":"Still hidden after clear"},"replay":false}\n\n',
    )));
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Usage details' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Clear result' })).toBeTruthy();
    expect(screen.getByText('Reset complete')).toBeTruthy();
    expect(screen.queryByText('Still hidden after clear')).toBeNull();
    expect(screen.getByTitle('Session model').textContent).toBe('opus');
    expect(fetchStream).toHaveBeenCalledTimes(1);
  });

  it('/name metadata updates sidebar title without parsing command output', async () => {
    const ta = await selectFirst();
    response = { blocks: [], control: { kind: 'continue' }, session: { name: 'Renamed project' } };
    await command(ta, '/name Renamed project');
    expect(screen.queryByText('First session')).toBeNull();
    expect(screen.getAllByText('Renamed project').length).toBeGreaterThan(0);
  });
});
