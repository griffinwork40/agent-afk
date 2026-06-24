/**
 * Tests asserting that browser_event trace records are emitted when browser
 * tool handlers are invoked with a traceWriter in their ToolHandlerContext.
 *
 * Each test injects an InMemoryTraceWriter via the ToolHandlerContext (the
 * same path the dispatcher uses after the feat/browser-event-emission wiring)
 * and verifies the resulting browser_event payload.
 *
 * Pattern: handler is called with `context = { traceWriter, toolUseId }`.
 * The emitBrowserEvent helper is fire-and-forget (void), so we await a small
 * flush tick before inspecting the writer.
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryTraceWriter } from '../../trace/index.js';
import type { ToolHandlerContext } from '../types.js';
import type { BrowserEventPayload } from '../../trace/types.js';
import type { BrowserProvider } from '../../../browser/provider.js';
import type {
  AmbiguousTarget,
  BlockedByPolicy,
  BrowserObservation,
  InteractiveElement,
  ScreenshotResult,
} from '../../../browser/types.js';
import { createBrowserOpenHandler } from './browser-open.js';
import { createBrowserActHandler } from './browser-act.js';
import { createBrowserObserveHandler } from './browser-observe.js';
import { createBrowserScreenshotHandler } from './browser-screenshot.js';
import { createBrowserCloseHandler } from './browser-close.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeContext(traceWriter: InMemoryTraceWriter, toolUseId = 'tu_test'): ToolHandlerContext {
  return { traceWriter, toolUseId };
}

/** Flush the microtask queue so fire-and-forget void promises resolve. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lastBrowserEvent(writer: InMemoryTraceWriter): BrowserEventPayload {
  const ev = [...writer.events].reverse().find((e) => e.kind === 'browser_event');
  if (!ev) throw new Error('No browser_event found in trace');
  return ev.payload as BrowserEventPayload;
}

function makeObs(overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    observationId: 'obs_1',
    url: 'https://example.com',
    title: 'Test Page',
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
    id: 'el_abc',
    role: 'button',
    label: 'Submit',
    kind: null,
    value: null,
    state: { disabled: false },
    bbox: { x: 0, y: 0, w: 80, h: 30 },
    ...overrides,
  };
}

function makeBlockedByPolicy(reason = 'domain refused'): BlockedByPolicy {
  return { outcome: 'blocked_by_policy', url: 'https://example.com', reason };
}

function makeAmbiguous(query: { text: string }): AmbiguousTarget {
  return {
    outcome: 'ambiguous_target',
    query,
    candidates: [makeElement({ id: 'el_1', label: 'First' }), makeElement({ id: 'el_2', label: 'Second' })],
  };
}

function makeScreenshotResult(overrides: Partial<ScreenshotResult> = {}): ScreenshotResult {
  return {
    path: '/tmp/screenshot.png',
    bytes: 12345,
    width: 1280,
    height: 720,
    dataBase64: 'AAAA',
    mediaType: 'image/png',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    name: 'test',
    open: vi.fn().mockResolvedValue(makeObs()),
    observe: vi.fn().mockResolvedValue(makeObs()),
    act: vi.fn().mockResolvedValue(makeObs()),
    screenshot: vi.fn().mockResolvedValue(makeScreenshotResult()),
    extract: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnValue(null),
    shutdown: vi.fn(),
    ...overrides,
  } as BrowserProvider;
}

// ---------------------------------------------------------------------------
// browser_open — happy path
// ---------------------------------------------------------------------------

describe('browser_open — emits browser_event on success', () => {
  it('emits status=ok with urlAfter set to the loaded page URL', async () => {
    const obs = makeObs({ url: 'https://example.com/page' });
    const provider = makeProvider({ open: vi.fn().mockResolvedValue(obs) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });

    await handler({ url: 'https://example.com/page' }, makeSignal(), makeContext(writer));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_open');
    expect(ev.toolUseId).toBe('tu_test');
    expect(ev.status).toBe('ok');
    expect(ev.urlBefore).toBeNull();
    expect(ev.urlAfter).toBe('https://example.com/page');
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries screenshotPath when observation has one', async () => {
    const obs = makeObs({ screenshotPath: '/tmp/ss.png' });
    const provider = makeProvider({ open: vi.fn().mockResolvedValue(obs) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });

    await handler({ url: 'https://example.com' }, makeSignal(), makeContext(writer));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.screenshotPath).toBe('/tmp/ss.png');
  });
});

// ---------------------------------------------------------------------------
// browser_open — blocked_by_policy
// ---------------------------------------------------------------------------

describe('browser_open — emits browser_event on blocked_by_policy', () => {
  it('emits status=blocked_by_policy', async () => {
    const provider = makeProvider({ open: vi.fn().mockResolvedValue(makeBlockedByPolicy()) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });

    const r = await handler({ url: 'https://blocked.example.com' }, makeSignal(), makeContext(writer));
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_open');
    expect(ev.status).toBe('blocked_by_policy');
    expect(ev.urlBefore).toBeNull();
    expect(ev.urlAfter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// browser_open — provider error
// ---------------------------------------------------------------------------

describe('browser_open — emits browser_event on error', () => {
  it('emits status=error when provider.open throws', async () => {
    const provider = makeProvider({ open: vi.fn().mockRejectedValue(new Error('nav failed')) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });

    const r = await handler({ url: 'https://example.com' }, makeSignal(), makeContext(writer));
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('error');
    expect(ev.error?.reason).toMatch(/nav failed/);
    expect(ev.error?.recoverable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// browser_open — no-op without traceWriter
// ---------------------------------------------------------------------------

describe('browser_open — no trace emission without traceWriter', () => {
  it('does not throw and returns normal result when context has no traceWriter', async () => {
    const provider = makeProvider();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });
    // No traceWriter in context — should not throw
    const r = await handler({ url: 'https://example.com' }, makeSignal(), {});
    expect(r.isError).toBeUndefined();
  });

  it('works without any context at all', async () => {
    const provider = makeProvider();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => provider });
    const r = await handler({ url: 'https://example.com' }, makeSignal());
    expect(r.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// browser_act — happy path
// ---------------------------------------------------------------------------

describe('browser_act — emits browser_event on success', () => {
  it('emits status=ok with tool=browser_act and action', async () => {
    const obs = makeObs({ url: 'https://example.com/after' });
    const provider = makeProvider({ act: vi.fn().mockResolvedValue(obs) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Submit' } },
      makeSignal(),
      makeContext(writer, 'tu_act_1'),
    );
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_act');
    expect(ev.action).toBe('click');
    expect(ev.toolUseId).toBe('tu_act_1');
    expect(ev.status).toBe('ok');
    expect(ev.urlBefore).toBe('https://example.com/after');
    expect(ev.urlAfter).toBe('https://example.com/after');
  });

  it('emits sanitized semantic target (text truncated, not raw)', async () => {
    const provider = makeProvider();
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Click me', role: 'button' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.target?.kind).toBe('semantic');
    expect(ev.target?.text).toBe('Click me');
    expect(ev.target?.role).toBe('button');
  });

  it('emits element_id target', async () => {
    const provider = makeProvider();
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    await handler(
      { action: 'click', target: { kind: 'element_id', element_id: 'el_abc123' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.target?.kind).toBe('element_id');
    expect(ev.target?.elementId).toBe('el_abc123');
  });

  it('emits selector target with selectorHash (not raw selector)', async () => {
    const provider = makeProvider();
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    await handler(
      { action: 'click', target: { kind: 'selector', selector: '#submit-btn' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.target?.kind).toBe('selector');
    // selectorHash is an 8-char hex digest — never the raw selector string
    expect(ev.target?.selectorHash).toMatch(/^[0-9a-f]{8}$/);
    expect(ev.target).not.toHaveProperty('selector');
  });
});

// ---------------------------------------------------------------------------
// browser_act — ambiguous_target
// ---------------------------------------------------------------------------

describe('browser_act — emits browser_event on ambiguous_target', () => {
  it('emits status=ambiguous_target', async () => {
    const provider = makeProvider({ act: vi.fn().mockResolvedValue(makeAmbiguous({ text: 'Submit' })) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    const r = await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Submit' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_act');
    expect(ev.status).toBe('ambiguous_target');
  });
});

// ---------------------------------------------------------------------------
// browser_act — blocked_by_policy
// ---------------------------------------------------------------------------

describe('browser_act — emits browser_event on blocked_by_policy', () => {
  it('emits status=blocked_by_policy', async () => {
    const provider = makeProvider({ act: vi.fn().mockResolvedValue(makeBlockedByPolicy()) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    const r = await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Go' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('blocked_by_policy');
  });
});

// ---------------------------------------------------------------------------
// browser_act — provider error
// ---------------------------------------------------------------------------

describe('browser_act — emits browser_event on error', () => {
  it('emits status=error with error.reason', async () => {
    const provider = makeProvider({ act: vi.fn().mockRejectedValue(new Error('element gone')) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => provider });

    await handler(
      { action: 'click', target: { kind: 'semantic', text: 'Btn' } },
      makeSignal(),
      makeContext(writer),
    );
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('error');
    expect(ev.error?.reason).toMatch(/element gone/);
  });
});

// ---------------------------------------------------------------------------
// browser_observe — happy path
// ---------------------------------------------------------------------------

describe('browser_observe — emits browser_event on success', () => {
  it('emits status=ok with current page URL in urlBefore/urlAfter', async () => {
    const obs = makeObs({ url: 'https://example.com/watched' });
    const provider = makeProvider({ observe: vi.fn().mockResolvedValue(obs) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserObserveHandler({ getBrowserProvider: async () => provider });

    await handler({}, makeSignal(), makeContext(writer, 'tu_obs'));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_observe');
    expect(ev.toolUseId).toBe('tu_obs');
    expect(ev.status).toBe('ok');
    expect(ev.urlBefore).toBe('https://example.com/watched');
    expect(ev.urlAfter).toBe('https://example.com/watched');
  });

  it('carries screenshotPath when observation has one', async () => {
    const obs = makeObs({ screenshotPath: '/tmp/obs_ss.png' });
    const provider = makeProvider({ observe: vi.fn().mockResolvedValue(obs) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserObserveHandler({ getBrowserProvider: async () => provider });

    await handler({}, makeSignal(), makeContext(writer));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.screenshotPath).toBe('/tmp/obs_ss.png');
  });
});

// ---------------------------------------------------------------------------
// browser_observe — provider error
// ---------------------------------------------------------------------------

describe('browser_observe — emits browser_event on error', () => {
  it('emits status=error when provider.observe throws', async () => {
    const provider = makeProvider({ observe: vi.fn().mockRejectedValue(new Error('no open page')) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserObserveHandler({ getBrowserProvider: async () => provider });

    const r = await handler({}, makeSignal(), makeContext(writer));
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('error');
    expect(ev.error?.reason).toMatch(/no open page/);
  });
});

// ---------------------------------------------------------------------------
// browser_screenshot — happy path
// ---------------------------------------------------------------------------

describe('browser_screenshot — emits browser_event on success', () => {
  it('emits status=ok with screenshotPath', async () => {
    const sr = makeScreenshotResult({ path: '/tmp/cap.png' });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(sr) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: async () => provider });

    await handler({}, makeSignal(), makeContext(writer, 'tu_ss'));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_screenshot');
    expect(ev.toolUseId).toBe('tu_ss');
    expect(ev.status).toBe('ok');
    expect(ev.screenshotPath).toBe('/tmp/cap.png');
    // screenshot is non-navigating — URLs are null
    expect(ev.urlBefore).toBeNull();
    expect(ev.urlAfter).toBeNull();
  });

  it('still emits when screenshot exceeds MAX_IMAGE_DIMENSION (imageOmitted path)', async () => {
    const sr = makeScreenshotResult({ width: 9000, height: 9000, path: '/tmp/big.png' });
    const provider = makeProvider({ screenshot: vi.fn().mockResolvedValue(sr) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: async () => provider });

    const r = await handler({}, makeSignal(), makeContext(writer));
    await flush();

    // The result is still not an error (imageOmitted path, not isError)
    expect(r.isError).toBeUndefined();
    const content = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(content['imageOmitted']).toBeDefined();
    // browser_event was still emitted
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('ok');
    expect(ev.screenshotPath).toBe('/tmp/big.png');
  });
});

// ---------------------------------------------------------------------------
// browser_screenshot — provider error
// ---------------------------------------------------------------------------

describe('browser_screenshot — emits browser_event on error', () => {
  it('emits status=error when provider.screenshot throws', async () => {
    const provider = makeProvider({ screenshot: vi.fn().mockRejectedValue(new Error('capture failed')) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: async () => provider });

    const r = await handler({}, makeSignal(), makeContext(writer));
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('error');
    expect(ev.error?.reason).toMatch(/capture failed/);
  });
});

// ---------------------------------------------------------------------------
// browser_close — happy path
// ---------------------------------------------------------------------------

describe('browser_close — emits browser_event on success', () => {
  it('emits status=ok', async () => {
    const provider = makeProvider({ close: vi.fn().mockResolvedValue(undefined) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserCloseHandler({ getBrowserProvider: async () => provider });

    await handler({}, makeSignal(), makeContext(writer, 'tu_close'));
    await flush();

    const ev = lastBrowserEvent(writer);
    expect(ev.tool).toBe('browser_close');
    expect(ev.toolUseId).toBe('tu_close');
    expect(ev.status).toBe('ok');
    expect(ev.urlBefore).toBeNull();
    expect(ev.urlAfter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// browser_close — provider error
// ---------------------------------------------------------------------------

describe('browser_close — emits browser_event on error', () => {
  it('emits status=error when provider.close throws', async () => {
    const provider = makeProvider({ close: vi.fn().mockRejectedValue(new Error('already closed')) });
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserCloseHandler({ getBrowserProvider: async () => provider });

    const r = await handler({}, makeSignal(), makeContext(writer));
    await flush();

    expect(r.isError).toBe(true);
    const ev = lastBrowserEvent(writer);
    expect(ev.status).toBe('error');
    expect(ev.error?.reason).toMatch(/already closed/);
  });
});

// ---------------------------------------------------------------------------
// toolUseId correlation — all handlers carry the injected id
// ---------------------------------------------------------------------------

describe('toolUseId correlation', () => {
  it('browser_open carries the injected toolUseId', async () => {
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserOpenHandler({ getBrowserProvider: async () => makeProvider() });
    await handler({ url: 'https://example.com' }, makeSignal(), makeContext(writer, 'corr_001'));
    await flush();
    expect(lastBrowserEvent(writer).toolUseId).toBe('corr_001');
  });

  it('browser_act carries the injected toolUseId', async () => {
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserActHandler({ getBrowserProvider: async () => makeProvider() });
    await handler({ action: 'click', target: { kind: 'semantic', text: 'X' } }, makeSignal(), makeContext(writer, 'corr_002'));
    await flush();
    expect(lastBrowserEvent(writer).toolUseId).toBe('corr_002');
  });

  it('browser_observe carries the injected toolUseId', async () => {
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserObserveHandler({ getBrowserProvider: async () => makeProvider() });
    await handler({}, makeSignal(), makeContext(writer, 'corr_003'));
    await flush();
    expect(lastBrowserEvent(writer).toolUseId).toBe('corr_003');
  });

  it('browser_screenshot carries the injected toolUseId', async () => {
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserScreenshotHandler({ getBrowserProvider: async () => makeProvider() });
    await handler({}, makeSignal(), makeContext(writer, 'corr_004'));
    await flush();
    expect(lastBrowserEvent(writer).toolUseId).toBe('corr_004');
  });

  it('browser_close carries the injected toolUseId', async () => {
    const writer = new InMemoryTraceWriter();
    const handler = createBrowserCloseHandler({ getBrowserProvider: async () => makeProvider() });
    await handler({}, makeSignal(), makeContext(writer, 'corr_005'));
    await flush();
    expect(lastBrowserEvent(writer).toolUseId).toBe('corr_005');
  });
});
