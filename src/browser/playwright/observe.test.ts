/**
 * Unit tests for src/browser/playwright/observe.ts.
 *
 * All tests use a mock Page object — no real browser is launched. The mock
 * stubs out every Page method used by observePage():
 *   - accessibility.snapshot()
 *   - page.evaluate()  — dispatched by function source content to distinguish
 *       innerText, domRecords, fallbackNodes, and readyState calls
 *   - page.title()
 *   - page.url()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import { observePage } from './observe.js';
import type { ObservePageOptions } from './observe.js';

// ---------------------------------------------------------------------------
// Mock Page builder
//
// Returns a minimal Page stub typed as `Page` via `as unknown as Page`.
//
// observePage() calls page.evaluate() three or four times, always in order:
//   Call 1 (parallel): innerText — fn body contains "innerText"
//   Call 2 (parallel): DOM enrichment records — fn receives a string argument
//                       (the selector) and body contains "querySelectorAll"
//   Call 3 (fallback, only when AX=null): fallback nodes — also receives a
//                       selector argument, fn body also contains "querySelectorAll"
//   Call 4: readyState — fn body contains "readyState"
//
// We discriminate by checking whether a second argument (the selector string)
// is supplied. When the second arg is present it's a DOM query; when absent
// it's either innerText or readyState, dispatched by call order.
// ---------------------------------------------------------------------------

interface MockPageOptions {
  /** Return value of accessibility.snapshot(). null triggers DOM fallback. */
  axSnapshot?: Record<string, unknown> | null;
  /** Return value of DOM enrichment evaluate (collectDomRecords). */
  domRecords?: unknown[];
  /** Return value of fallback DOM evaluate (collectFallbackNodes). */
  domFallback?: unknown[];
  /** Return value of page.evaluate() for innerText. */
  innerText?: string;
  /** Return value of page.evaluate() for readyState. */
  readyState?: string;
  /** Return value of page.title(). */
  title?: string;
  /** Return value of page.url(). */
  url?: string;
}

function makeMockPage(opts: MockPageOptions = {}): Page {
  const axSnapshot = 'axSnapshot' in opts ? opts.axSnapshot : null;
  const domRecords = opts.domRecords ?? [];
  const domFallback = opts.domFallback ?? [];
  const innerText = opts.innerText ?? '';
  const readyState = opts.readyState ?? 'complete';
  const pageTitle = opts.title ?? 'Test Page';
  const pageUrl = opts.url ?? 'https://example.com';

  // Tracks how many no-argument evaluate() calls have happened.
  // Call 0 → innerText, call 1 → readyState.
  let noArgEvalCount = 0;

  // Tracks how many selector-argument evaluate() calls have happened.
  // Call 0 → DOM enrichment (domRecords), call 1 → fallback nodes (domFallback).
  let selectorEvalCount = 0;

  const page = {
    accessibility: {
      snapshot: vi.fn().mockResolvedValue(axSnapshot),
    },
    evaluate: vi.fn().mockImplementation(async (_fn: unknown, arg?: unknown) => {
      if (arg !== undefined) {
        // Selector-based evaluate: collectDomRecords or collectFallbackNodes
        const n = selectorEvalCount++;
        return n === 0 ? domRecords : domFallback;
      } else {
        // No-arg evaluate: innerText (call 0) or readyState (call 1)
        const n = noArgEvalCount++;
        return n === 0 ? innerText : readyState;
      }
    }),
    title: vi.fn().mockResolvedValue(pageTitle),
    url: vi.fn().mockReturnValue(pageUrl),
  } as unknown as Page;

  return page;
}

// Default opts used across tests
const defaultOpts: ObservePageOptions = {
  observationCounter: 1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AX tree node. */
function axNode(
  role: string,
  name: string,
  extras: Partial<{
    value: string;
    checked: boolean;
    disabled: boolean;
    expanded: boolean;
    selected: boolean;
    children: unknown[];
  }> = {},
): Record<string, unknown> {
  return { role, name, ...extras };
}

/** Build a minimal DomRecord for evaluate enrichment. */
function domRecord(
  name: string,
  bbox: { x: number; y: number; w: number; h: number },
  extras: Partial<{
    type: string | null;
    id: string | null;
    testId: string | null;
    tagName: string;
  }> = {},
): Record<string, unknown> {
  return {
    name,
    tagName: extras.tagName ?? 'input',
    type: extras.type ?? null,
    id: extras.id ?? null,
    testId: extras.testId ?? null,
    bbox,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('observePage', () => {
  // -------------------------------------------------------------------------
  // AX tree mapping
  // -------------------------------------------------------------------------

  describe('AX tree mapping', () => {
    it('keeps only actionable roles and drops non-actionable ones', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Submit'),
          axNode('heading', 'Welcome'), // non-actionable
          axNode('link', 'Home'),
          axNode('paragraph', 'Some text'), // non-actionable
          axNode('textbox', 'Email'),
          axNode('img', 'Logo'), // non-actionable
          axNode('checkbox', 'Remember me'),
          axNode('combobox', 'Country'),
        ],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      const roles = obs.interactive.map((el) => el.role);
      expect(roles).toContain('button');
      expect(roles).toContain('link');
      expect(roles).toContain('textbox');
      expect(roles).toContain('checkbox');
      expect(roles).toContain('combobox');
      // Non-actionable roles must NOT appear
      expect(roles).not.toContain('heading');
      expect(roles).not.toContain('paragraph');
      expect(roles).not.toContain('img');
      expect(obs.interactive).toHaveLength(5);
    });

    it('keeps searchbox role when it has a name', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('searchbox', 'Search the site'),
          axNode('searchbox', ''), // unnamed — should be dropped
        ],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive.filter((el) => el.role === 'searchbox')).toHaveLength(1);
      expect(obs.interactive[0]?.label).toBe('Search the site');
    });

    it('keeps spinbutton role when it has a name', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('spinbutton', 'Quantity'),
          axNode('spinbutton', ''), // unnamed — should be dropped
        ],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive.filter((el) => el.role === 'spinbutton')).toHaveLength(1);
    });

    it('walks nested children depth-first', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          {
            role: 'group',
            name: 'Form',
            children: [
              axNode('textbox', 'Username'),
              axNode('textbox', 'Password'),
            ],
          },
          axNode('button', 'Login'),
        ],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      const roles = obs.interactive.map((el) => el.role);
      expect(roles.filter((r) => r === 'textbox')).toHaveLength(2);
      expect(roles).toContain('button');
    });

    it('maps all actionable role variants', async () => {
      const allRoles = [
        'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
        'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch',
        'option', 'searchbox', 'spinbutton',
      ];

      const children = allRoles.map((role) => axNode(role, `${role} label`));
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(allRoles.length);
      const foundRoles = new Set(obs.interactive.map((el) => el.role));
      for (const r of allRoles) {
        expect(foundRoles.has(r)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Sort order
  // -------------------------------------------------------------------------

  describe('sort order', () => {
    it('sorts elements top-to-bottom (smaller y first)', async () => {
      // Two buttons at different y positions; the one at y=100 should appear
      // first in reading order (smaller y = higher on page).
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Lower button'),  // will get y=200
          axNode('button', 'Upper button'),  // will get y=100
        ],
      };

      const domRecs = [
        domRecord('Lower button', { x: 0, y: 200, w: 100, h: 30 }),
        domRecord('Upper button', { x: 0, y: 100, w: 100, h: 30 }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(2);
      expect(obs.interactive[0]?.label).toBe('Upper button');
      expect(obs.interactive[1]?.label).toBe('Lower button');
    });

    it('breaks y ties by x (smaller x first)', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Right button'),  // x=200
          axNode('button', 'Left button'),   // x=50
        ],
      };

      const domRecs = [
        domRecord('Right button', { x: 200, y: 100, w: 80, h: 30 }),
        domRecord('Left button',  { x: 50,  y: 100, w: 80, h: 30 }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.label).toBe('Left button');
      expect(obs.interactive[1]?.label).toBe('Right button');
    });
  });

  // -------------------------------------------------------------------------
  // maxElements cap
  // -------------------------------------------------------------------------

  describe('maxElements cap', () => {
    it('caps interactive[] at maxElements (default 80)', async () => {
      const children = Array.from({ length: 100 }, (_, i) =>
        axNode('button', `Button ${i}`),
      );
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(80);
    });

    it('caps at custom maxElements', async () => {
      const children = Array.from({ length: 50 }, (_, i) =>
        axNode('button', `Button ${i}`),
      );
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, { ...defaultOpts, maxElements: 10 });

      expect(obs.interactive).toHaveLength(10);
    });

    it('returns all elements when count is below cap', async () => {
      const children = [axNode('button', 'A'), axNode('link', 'B')];
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Hidden filtering
  // -------------------------------------------------------------------------

  describe('hidden filtering', () => {
    it('drops elements with bbox(0,0,0,0) by default', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Visible button'),
          axNode('button', 'Hidden button'),
        ],
      };

      const domRecs = [
        domRecord('Visible button', { x: 10, y: 10, w: 100, h: 30 }),
        domRecord('Hidden button',  { x: 0,  y: 0,  w: 0,   h: 0  }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive.map((el) => el.label)).toContain('Visible button');
      expect(obs.interactive.map((el) => el.label)).not.toContain('Hidden button');
    });

    it('includes zero-bbox elements when includeHidden: true', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Visible button'),
          axNode('button', 'Hidden button'),
        ],
      };

      const domRecs = [
        domRecord('Visible button', { x: 10, y: 10, w: 100, h: 30 }),
        domRecord('Hidden button',  { x: 0,  y: 0,  w: 0,   h: 0  }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, { ...defaultOpts, includeHidden: true });

      const labels = obs.interactive.map((el) => el.label);
      expect(labels).toContain('Visible button');
      expect(labels).toContain('Hidden button');
    });

    it('keeps elements with no DOM record (bbox unknown) even without includeHidden', async () => {
      // An element that has an AX node but no matching DOM record is kept
      // because we can't confirm it's hidden.
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'No DOM match')],
      };

      // domRecords is empty — no match for the button
      const page = makeMockPage({ axSnapshot: axRoot, domRecords: [] });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(1);
      expect(obs.interactive[0]?.label).toBe('No DOM match');
    });
  });

  // -------------------------------------------------------------------------
  // Password redaction
  // -------------------------------------------------------------------------

  describe('password redaction', () => {
    it('redacts the value of a textbox with kind=password', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          { role: 'textbox', name: 'Password', value: 'supersecret' },
        ],
      };

      const domRecs = [
        domRecord('Password', { x: 0, y: 0, w: 100, h: 30 }, { type: 'password' }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive).toHaveLength(1);
      expect(obs.interactive[0]?.value).toBe('[redacted]');
      expect(obs.interactive[0]?.kind).toBe('password');
    });

    it('does NOT redact a textbox with kind=text', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          { role: 'textbox', name: 'Email', value: 'user@example.com' },
        ],
      };

      const domRecs = [
        domRecord('Email', { x: 0, y: 0, w: 100, h: 30 }, { type: 'text' }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.value).toBe('user@example.com');
    });
  });

  // -------------------------------------------------------------------------
  // textSummary truncation
  // -------------------------------------------------------------------------

  describe('textSummary', () => {
    it('returns the full text when under 4000 chars', async () => {
      const text = 'Hello world. '.repeat(50); // ~650 chars
      const page = makeMockPage({ axSnapshot: null, innerText: text });
      const obs = await observePage(page, defaultOpts);

      expect(obs.textSummary.length).toBeLessThanOrEqual(4000);
      expect(obs.textSummary).not.toContain('[truncated]');
    });

    it('truncates at 4000 chars and appends the suffix', async () => {
      // 4100 'a' chars will exceed 4000 after whitespace collapsing
      const text = 'a'.repeat(4100);
      const page = makeMockPage({ axSnapshot: null, innerText: text });
      const obs = await observePage(page, defaultOpts);

      expect(obs.textSummary.endsWith('…[truncated]')).toBe(true);
      // The total length is 4000 content chars + suffix
      expect(obs.textSummary.length).toBe(4000 + '…[truncated]'.length);
    });

    it('collapses whitespace before checking length', async () => {
      // 500 words separated by multiple spaces — collapses heavily
      const text = Array.from({ length: 500 }, () => 'word  word').join('   ');
      const page = makeMockPage({ axSnapshot: null, innerText: text });
      const obs = await observePage(page, defaultOpts);

      // After collapsing, must not contain double-spaces
      expect(obs.textSummary).not.toMatch(/  /);
    });
  });

  // -------------------------------------------------------------------------
  // 200+ element warning
  // -------------------------------------------------------------------------

  describe('200+ element warning', () => {
    it('emits a warning when pre-cap count exceeds 200', async () => {
      const children = Array.from({ length: 201 }, (_, i) =>
        axNode('button', `Button ${i}`),
      );
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).toContain(
        'page has 200+ interactive elements; consider scoping',
      );
    });

    it('does NOT emit the warning when count is exactly 200', async () => {
      const children = Array.from({ length: 200 }, (_, i) =>
        axNode('button', `Button ${i}`),
      );
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).not.toContain(
        'page has 200+ interactive elements; consider scoping',
      );
    });

    it('does NOT emit the warning when count is below 200', async () => {
      const children = Array.from({ length: 50 }, (_, i) =>
        axNode('button', `Button ${i}`),
      );
      const axRoot = { role: 'WebArea', name: 'Page', children };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).not.toContain(
        'page has 200+ interactive elements; consider scoping',
      );
    });
  });

  // -------------------------------------------------------------------------
  // observationId format
  // -------------------------------------------------------------------------

  describe('observationId', () => {
    it('formats observationId as obs_<base36>', async () => {
      const page = makeMockPage({ axSnapshot: null });

      const obs1 = await observePage(page, { observationCounter: 1 });
      expect(obs1.observationId).toBe(`obs_${(1).toString(36)}`);

      const obs10 = await observePage(page, { observationCounter: 10 });
      expect(obs10.observationId).toBe(`obs_${(10).toString(36)}`);

      const obs255 = await observePage(page, { observationCounter: 255 });
      expect(obs255.observationId).toBe(`obs_${(255).toString(36)}`);
    });

    it('observationId starts with obs_', async () => {
      const page = makeMockPage({ axSnapshot: null });
      const obs = await observePage(page, { observationCounter: 42 });

      expect(obs.observationId).toMatch(/^obs_[0-9a-z]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // DOM fallback warning
  // -------------------------------------------------------------------------

  describe('DOM fallback', () => {
    it('emits fallback warning when AX snapshot returns null', async () => {
      const page = makeMockPage({ axSnapshot: null });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).toContain(
        'observation skipped accessibility tree (returned null)',
      );
    });

    it('does NOT emit fallback warning when AX snapshot succeeds', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'OK')],
      };
      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).not.toContain(
        'observation skipped accessibility tree (returned null)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Element ID stability
  // -------------------------------------------------------------------------

  describe('element id', () => {
    it('generates el_<6-char-hex> ids', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'Submit')],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.id).toMatch(/^el_[0-9a-f]{6}$/);
    });

    it('generates unique ids for elements with different names', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [
          axNode('button', 'Save'),
          axNode('button', 'Cancel'),
          axNode('button', 'Delete'),
        ],
      };

      const page = makeMockPage({ axSnapshot: axRoot });
      const obs = await observePage(page, defaultOpts);

      const ids = obs.interactive.map((el) => el.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // -------------------------------------------------------------------------
  // capturedAt
  // -------------------------------------------------------------------------

  describe('capturedAt', () => {
    it('sets capturedAt to a valid ISO timestamp', async () => {
      const page = makeMockPage({ axSnapshot: null });
      const before = Date.now();
      const obs = await observePage(page, defaultOpts);
      const after = Date.now();

      const ts = new Date(obs.capturedAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // Selector enrichment
  // -------------------------------------------------------------------------

  describe('selector enrichment', () => {
    it('sets selector to [data-testid=...] when testId is present', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'Submit')],
      };

      const domRecs = [
        domRecord('Submit', { x: 0, y: 0, w: 80, h: 30 }, {
          testId: 'submit-btn',
          id: null,
        }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.selector).toBe('[data-testid="submit-btn"]');
    });

    it('sets selector to #id when id is present but no testId', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'Login')],
      };

      const domRecs = [
        domRecord('Login', { x: 0, y: 0, w: 80, h: 30 }, {
          id: 'login-btn',
          testId: null,
        }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.selector).toBe('#login-btn');
    });

    it('omits selector when no id or testId', async () => {
      const axRoot = {
        role: 'WebArea',
        name: 'Page',
        children: [axNode('button', 'Click me')],
      };

      const domRecs = [
        domRecord('Click me', { x: 0, y: 0, w: 80, h: 30 }, {
          id: null,
          testId: null,
        }),
      ];

      const page = makeMockPage({ axSnapshot: axRoot, domRecords: domRecs });
      const obs = await observePage(page, defaultOpts);

      expect(obs.interactive[0]?.selector).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Loading state warning
  // -------------------------------------------------------------------------

  describe('loading state warning', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('emits loading warning when page readyState is not complete', async () => {
      const page = makeMockPage({ axSnapshot: null, readyState: 'loading' });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).toContain(
        'page is still loading — observation may be incomplete',
      );
    });

    it('does NOT emit loading warning when page is complete', async () => {
      const page = makeMockPage({ axSnapshot: null, readyState: 'complete' });
      const obs = await observePage(page, defaultOpts);

      expect(obs.warnings).not.toContain(
        'page is still loading — observation may be incomplete',
      );
    });
  });
});
