/**
 * Invariant under test: the two things the browser entry point must get right
 * about CREDENTIALS and ADDRESSING.
 *
 * History: (1) the token was mirrored into a JS-readable `document.cookie`
 * entry, and cookies are scoped by host rather than port — so any page on any
 * other `http://127.0.0.1:<port>` origin could read the full bearer token and
 * drive the agent. It now arrives in a server-templated `<meta>` tag, with the
 * refresh case carried by the server's HttpOnly cookie. (2) `answerApproval`
 * resolved an elicitation's session as `record.sessionId ?? activeId`, so a
 * record carrying no sessionId was POSTed to whatever session happened to be
 * SELECTED; viewing a read-only session made that a permanent 409, the 1s poll
 * re-added the card, and the blocked turn never unblocked.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The document shell app.ts expects, minus the token meta tag. */
const SHELL = `
  <div id="meter"></div><div id="status"></div>
  <div id="sessions"></div><div id="transcript"></div><div id="approvals"></div>
  <div id="composer"><div id="queue"></div>
    <textarea id="prompt"></textarea>
    <button id="stop"></button><button id="send"></button>
  </div>
  <button id="new-session"></button>
`;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

let calls: Recorded[] = [];

/**
 * Boot app.ts against a stubbed API. `pending` is what /api/pending answers,
 * which is how an approval card gets rendered without a live agent.
 */
async function boot(opts: {
  metaToken?: string | undefined;
  pending?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
}): Promise<void> {
  const meta =
    opts.metaToken === undefined
      ? ''
      : `<meta name="afk-token" content="${opts.metaToken}" />`;
  document.head.innerHTML = meta;
  document.body.innerHTML = SHELL;

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: headers['authorization'],
    });
    const json =
      url === '/api/pending'
        ? { pending: opts.pending ?? [] }
        : url === '/api/sessions'
          ? { sessions: opts.sessions ?? [] }
          : { ok: true };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(json),
      text: () => Promise.resolve(''),
    } as unknown as Response);
  });

  // The SSE client opens a long-lived stream; jsdom has no ReadableStream body
  // worth simulating here, and these tests are about fetch targeting.
  vi.resetModules();
  await import('./app.js');
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  calls = [];
  history.replaceState(null, '', '/');
  // Invariant: the token now persists in sessionStorage so a refresh keeps its
  // credential. Each test therefore starts from an empty tab, or a token stored
  // by an earlier case would silently satisfy a later "no credential" assertion.
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('app — the token comes from the meta tag, never from document.cookie', () => {
  it('authorizes API calls with the server-templated meta token', async () => {
    await boot({ metaToken: 'meta-tok' });
    const apiCall = calls.find((c) => c.url.startsWith('/api/'));
    expect(apiCall?.authorization).toBe('Bearer meta-tok');
  });

  it('never writes the token into document.cookie', async () => {
    await boot({ metaToken: 'meta-tok' });
    expect(document.cookie).not.toContain('meta-tok');
    expect(document.cookie).not.toContain('afk_web_token');
    expect(document.cookie).not.toContain('afk_web_doc');
  });

  it('persists the token in sessionStorage, which is scoped by PORT', async () => {
    // Invariant: sessionStorage is keyed by origin (scheme+host+port), so a
    // sibling loopback port cannot read it — the property a cookie lacks.
    await boot({ metaToken: 'meta-tok' });
    expect(sessionStorage.getItem('afk_web_token')).toBe('meta-tok');
  });

  it('recovers the stored token when the document serves an empty placeholder', async () => {
    // The refresh path: a cookie-authenticated document carries no token.
    await boot({ metaToken: 'meta-tok' });
    calls = [];
    await boot({ metaToken: undefined });
    const apiCall = calls.find((c) => c.url.startsWith('/api/'));
    expect(apiCall?.authorization).toBe('Bearer meta-tok');
  });

  it('does not fall back to a JS-readable cookie for its credential', async () => {
    // A cookie planted by any other loopback-port origin must not be adopted.
    document.cookie = 'afk_web_doc=stolen-from-another-port; Path=/';
    await boot({ metaToken: 'meta-tok' });
    const apiCall = calls.find((c) => c.url.startsWith('/api/'));
    expect(apiCall?.authorization).toBe('Bearer meta-tok');
    expect(apiCall?.authorization).not.toContain('stolen-from-another-port');
  });

  it('sends no credential when the placeholder was never substituted', async () => {
    await boot({ metaToken: '__AFK_WEB_TOKEN__' });
    const apiCall = calls.find((c) => c.url.startsWith('/api/'));
    expect(apiCall?.authorization).toBe('Bearer ');
  });

  it('does not throw when the meta tag is missing entirely', async () => {
    await expect(boot({ metaToken: undefined })).resolves.toBeUndefined();
  });

  it('scrubs ?token= from the visible URL', async () => {
    history.replaceState(null, '', '/?token=in-the-url');
    await boot({ metaToken: 'meta-tok' });
    expect(location.search).toBe('');
    expect(location.href).not.toContain('in-the-url');
  });

  it('scrubs the ?k= handoff nonce from the visible URL', async () => {
    history.replaceState(null, '', '/?k=one-shot-nonce');
    await boot({ metaToken: 'meta-tok' });
    expect(location.search).toBe('');
    expect(location.href).not.toContain('one-shot-nonce');
  });
});

describe('app — approvals are addressed by request id, not by session', () => {
  const APPROVAL = {
    id: 'req-42',
    // Deliberately NO sessionId — the shape that used to fall back to activeId.
    request: { message: 'Run this tool?', origin: 'agent' },
  };

  it('POSTs to /api/approve with no session segment', async () => {
    await boot({
      metaToken: 'meta-tok',
      pending: [APPROVAL],
      // A read-only session is auto-selected: the exact case that 409'd forever.
      sessions: [{ id: 'foreign-session', mode: 'readonly' }],
    });

    const approve = document.querySelector('.approval-primary') as HTMLButtonElement | null;
    expect(approve).not.toBeNull();
    approve?.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('approve'));
    expect(posted?.url).toBe('/api/approve');
    expect(posted?.url).not.toContain('/api/sessions/');
    expect(posted?.url).not.toContain('foreign-session');
  });

  it('carries the requestId and the answer in the body', async () => {
    await boot({
      metaToken: 'meta-tok',
      pending: [APPROVAL],
      sessions: [{ id: 'foreign-session', mode: 'readonly' }],
    });

    (document.querySelector('.approval-primary') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('approve'));
    expect(posted?.body).toEqual({
      requestId: 'req-42',
      response: { action: 'accept', content: { value: true } },
    });
  });

  it('routes a Deny the same way', async () => {
    await boot({
      metaToken: 'meta-tok',
      pending: [APPROVAL],
      sessions: [{ id: 'foreign-session', mode: 'readonly' }],
    });

    (document.querySelector('.approval-danger') as HTMLButtonElement).click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('approve'));
    expect(posted?.url).toBe('/api/approve');
    expect(posted?.body).toEqual({ requestId: 'req-42', response: { action: 'decline' } });
  });
});
