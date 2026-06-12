/**
 * Tests for the `browser_act` tool handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserActHandler } from './browser-act.js';
import type { BrowserProvider } from '../../../browser/provider.js';
import type {
  AmbiguousTarget,
  BlockedByPolicy,
  BrowserObservation,
  InteractiveElement,
} from '../../../browser/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(aborted = false): AbortSignal {
  if (!aborted) return new AbortController().signal;
  const ac = new AbortController();
  ac.abort(new Error('test abort'));
  return ac.signal;
}

function makeObs(overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    observationId: 'obs_3',
    url: 'https://example.com',
    title: 'Example',
    textSummary: 'text',
    interactive: [],
    status: { httpStatus: 200, loadingState: 'idle', hasDialog: false, consoleErrors: 0 },
    warnings: [],
    screenshotPath: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeElement(overrides: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    id: 'el_abc123',
    role: 'button',
    label: 'Submit',
    kind: null,
    value: null,
    state: { disabled: false },
    bbox: { x: 10, y: 10, w: 80, h: 30 },
    ...overrides,
  };
}

function makeAmbiguous(query: { text: string; role?: string }): AmbiguousTarget {
  return {
    outcome: 'ambiguous_target',
    query,
    candidates: [
      makeElement({ id: 'el_001', label: 'Submit Form' }),
      makeElement({ id: 'el_002', label: 'Submit Order' }),
    ],
  };
}

function makeBlockedByPolicy(reason = 'blocked'): BlockedByPolicy {
  return { outcome: 'blocked_by_policy', url: 'https://example.com', reason };
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn(),
    observe: vi.fn(),
    act: vi.fn().mockResolvedValue(makeObs()),
    screenshot: vi.fn(),
    extract: vi.fn(),
    close: vi.fn(),
    describe: vi.fn().mockReturnValue(null),
    shutdown: vi.fn(),
    ...overrides,
  } as BrowserProvider;
}

// ---------------------------------------------------------------------------
// Input validation — action
// ---------------------------------------------------------------------------

describe('browser_act handler — action validation', () => {
  const signal = makeSignal();

  it('rejects non-object input', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler('bad' as unknown, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must be an object/);
  });

  it('rejects missing action', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ target: { kind: 'semantic', text: 'foo' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"action" is required/);
  });

  it('rejects unknown action', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'double_click', target: { kind: 'semantic', text: 'foo' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"action" must be one of/);
  });
});

// ---------------------------------------------------------------------------
// Input validation — target
// ---------------------------------------------------------------------------

describe('browser_act handler — target validation', () => {
  const signal = makeSignal();

  it('rejects missing target', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click' }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"target" is required/);
  });

  it('rejects target with invalid kind', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click', target: { kind: 'xpath' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"target.kind" must be one of/);
  });

  it('rejects semantic target without text', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click', target: { kind: 'semantic' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=semantic requires "target.text"/);
  });

  it('rejects element_id target without element_id', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click', target: { kind: 'element_id' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=element_id requires "target.element_id"/);
  });

  it('rejects selector target without selector', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click', target: { kind: 'selector' } }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/target.kind=selector requires "target.selector"/);
  });

  it('rejects non-string value', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'fill', target: { kind: 'semantic', text: 'Name' }, value: 123 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"value" must be a string/);
  });

  it('rejects non-positive timeout_ms', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn() });
    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Btn' }, timeout_ms: 0 }, signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"timeout_ms" must be a positive/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('browser_act handler — happy path', () => {
  let provider: BrowserProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns JSON observation for semantic click', async () => {
    const obs = makeObs({ title: 'Post-click Page' });
    vi.mocked(provider.act).mockResolvedValue(obs);

    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Submit' } }, makeSignal());

    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content as string) as BrowserObservation;
    expect(parsed.title).toBe('Post-click Page');
  });

  it('passes element_id target correctly', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ action: 'click', target: { kind: 'element_id', element_id: 'el_abc123' } }, makeSignal());

    expect(provider.act).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'element_id', elementId: 'el_abc123' },
      }),
    );
  });

  it('passes selector target correctly', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ action: 'click', target: { kind: 'selector', selector: '#submit-btn' } }, makeSignal());

    expect(provider.act).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'selector', selector: '#submit-btn' },
      }),
    );
  });

  it('passes fill value through', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ action: 'fill', target: { kind: 'semantic', text: 'Name field' }, value: 'Alice' }, makeSignal());

    expect(provider.act).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'Alice' }),
    );
  });

  it('includes sessionId in the act call', async () => {
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });
    await handler({ action: 'click', target: { kind: 'semantic', text: 'OK' } }, makeSignal());
    expect(provider.act).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Ambiguous target
// ---------------------------------------------------------------------------

describe('browser_act handler — ambiguous_target', () => {
  it('returns isError with disambiguation message', async () => {
    const ambiguous = makeAmbiguous({ text: 'Submit' });
    const provider = makeProvider({ act: vi.fn().mockResolvedValue(ambiguous) });
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Submit' } }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ambiguous target/);
    expect(r.content).toMatch(/el_001/);
    expect(r.content).toMatch(/el_002/);
  });
});

// ---------------------------------------------------------------------------
// Blocked by policy
// ---------------------------------------------------------------------------

describe('browser_act handler — blocked_by_policy', () => {
  it('returns isError with blocked message', async () => {
    const blocked = makeBlockedByPolicy('navigation refused');
    const provider = makeProvider({ act: vi.fn().mockResolvedValue(blocked) });
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Go' } }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
    expect(r.content).toMatch(/navigation refused/);
    expect(r.failureClass).toBe('policy-refusal');
  });
});

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

describe('browser_act handler — provider errors', () => {
  it('returns isError when provider.act throws', async () => {
    const provider = makeProvider({ act: vi.fn().mockRejectedValue(new Error('element not found')) });
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Btn' } }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/element not found/);
    expect(r.failureClass).toBeUndefined();
  });

  it("tags an action timeout as failureClass 'timeout'", async () => {
    const timeoutErr = new Error('locator.click: Timeout 10000ms exceeded.');
    timeoutErr.name = 'TimeoutError';
    const provider = makeProvider({ act: vi.fn().mockRejectedValue(timeoutErr) });
    const handler = createBrowserActHandler({ getBrowserProvider: vi.fn().mockResolvedValue(provider) });

    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Btn' } }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.failureClass).toBe('timeout');
  });

  it('returns playwright install hint when error contains Cannot find package', async () => {
    const getBrowserProvider = vi.fn().mockRejectedValue(new Error('Cannot find package playwright'));
    const handler = createBrowserActHandler({ getBrowserProvider });

    const r = await handler({ action: 'click', target: { kind: 'semantic', text: 'Btn' } }, makeSignal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/pnpm add playwright/);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('browser_act handler — abort signal', () => {
  it('returns immediately when signal is pre-aborted', async () => {
    const getBrowserProvider = vi.fn();
    const handler = createBrowserActHandler({ getBrowserProvider });

    const r = await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Btn' } },
      makeSignal(true),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted/);
    expect(r.failureClass).toBe('abort');
    expect(getBrowserProvider).not.toHaveBeenCalled();
  });
});
