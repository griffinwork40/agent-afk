/**
 * Unit tests for resolveTarget — uses a mock Page + Locator so no real browser
 * process is launched. Each mock is minimally shaped to satisfy the Locator
 * interface surface that resolveTarget actually calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from 'playwright';
import type { InteractiveElement } from '../types.js';
import { resolveTarget } from './resolve-target.js';

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a lightweight Locator stub.
 *
 * `count` controls how many elements the locator reports.
 * `nthEvaluateFn` is called for each nth(i).evaluate() call so tests can
 * customise per-element extracted info. Defaults to returning a generic
 * button-like element at a deterministic position.
 */
function makeMockLocator(
  matchCount: number,
  nthEvaluateFn?: (index: number) => {
    role: string;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
  },
): Locator {
  const defaultEval = (i: number) => ({
    role: 'button',
    label: `elem-${i}`,
    x: i * 10,
    y: 0,
    w: 100,
    h: 30,
  });
  const evalFn = nthEvaluateFn ?? defaultEval;

  // A nested nth stub — the evaluate is called on the result of nth(i).
  function makeNthLocator(index: number): Locator {
    const nthStub = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn(),
      evaluate: vi.fn().mockImplementation(
        (fn: (el: HTMLElement) => unknown) => {
          // Simulate DOM extraction by returning pre-built data for the given
          // index via a synthetic HTMLElement-like object.
          const data = evalFn(index);
          const fakeEl = {
            getAttribute: (attr: string) => {
              if (attr === 'role') return data.role;
              if (attr === 'aria-label') return data.label;
              return null;
            },
            tagName: data.role.toUpperCase(),
            innerText: data.label,
            getBoundingClientRect: () => ({
              x: data.x,
              y: data.y,
              width: data.w,
              height: data.h,
            }),
          };
          return Promise.resolve(fn(fakeEl as unknown as HTMLElement));
        },
      ),
    } as unknown as Locator;
    return nthStub;
  }

  const stub = {
    count: vi.fn().mockResolvedValue(matchCount),
    nth: vi.fn().mockImplementation((i: number) => makeNthLocator(i)),
    evaluate: vi.fn(),
    // Unused surface methods — present so the type is satisfied without `as any`.
    click: vi.fn(),
    fill: vi.fn(),
  } as unknown as Locator;

  return stub;
}

/**
 * Build a minimal mock Page.
 *
 * Callers can configure what each locator-factory method returns.
 */
interface PageConfig {
  locatorMap?: Record<string, Locator>; // selector → locator
  roleMap?: Record<string, Locator>; // role[:name] → locator
  labelMap?: Record<string, Locator>; // label text → locator
}

function makeMockPage(config: PageConfig): Page {
  const page = {
    locator: vi.fn().mockImplementation((selector: string): Locator => {
      return config.locatorMap?.[selector] ?? makeMockLocator(0);
    }),
    getByRole: vi.fn().mockImplementation(
      (role: string, opts?: { name?: string; exact?: boolean }): Locator => {
        const key = opts?.name !== undefined ? `${role}:${opts.name}` : role;
        return (
          config.roleMap?.[key] ??
          config.roleMap?.[role] ??
          makeMockLocator(0)
        );
      },
    ),
    getByLabel: vi.fn().mockImplementation((text: string): Locator => {
      return config.labelMap?.[text] ?? makeMockLocator(0);
    }),
  } as unknown as Page;
  return page;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const KNOWN_ELEMENT_WITH_SELECTOR: InteractiveElement = {
  id: 'el_aabbcc',
  role: 'button',
  label: 'Submit',
  kind: 'submit',
  value: null,
  state: { disabled: false },
  bbox: { x: 0, y: 0, w: 100, h: 30 },
  selector: '[data-testid="submit-btn"]',
};

const KNOWN_ELEMENT_NO_SELECTOR: InteractiveElement = {
  id: 'el_112233',
  role: 'link',
  label: 'Learn more',
  kind: null,
  value: null,
  state: { disabled: false },
  bbox: { x: 10, y: 10, w: 80, h: 20 },
};

// ---------------------------------------------------------------------------
// Tests: element_id
// ---------------------------------------------------------------------------

describe('resolveTarget — element_id', () => {
  let page: Page;

  beforeEach(() => {
    // Default page: the selector returns 1 match.
    page = makeMockPage({
      locatorMap: {
        '[data-testid="submit-btn"]': makeMockLocator(1),
      },
      roleMap: {
        'link:Learn more': makeMockLocator(1),
      },
    });
  });

  it('resolves a known element_id that has a selector', async () => {
    const knownElements = new Map<string, InteractiveElement>([
      ['el_aabbcc', KNOWN_ELEMENT_WITH_SELECTOR],
    ]);
    const result = await resolveTarget(
      page,
      { kind: 'element_id', elementId: 'el_aabbcc' },
      knownElements,
    );
    expect(result.outcome).toBe('resolved');
  });

  it('returns not_found for an unknown element_id', async () => {
    const knownElements = new Map<string, InteractiveElement>();
    const result = await resolveTarget(
      page,
      { kind: 'element_id', elementId: 'el_999999' },
      knownElements,
    );
    expect(result.outcome).toBe('not_found');
  });

  it('falls back to accessibility when selector returns 0 matches', async () => {
    // Selector returns 0; role:label returns 1 → resolved.
    const fallbackPage = makeMockPage({
      locatorMap: {
        '[data-testid="submit-btn"]': makeMockLocator(0),
      },
      roleMap: {
        'button:Submit': makeMockLocator(1),
      },
    });
    const knownElements = new Map<string, InteractiveElement>([
      ['el_aabbcc', KNOWN_ELEMENT_WITH_SELECTOR],
    ]);
    const result = await resolveTarget(
      fallbackPage,
      { kind: 'element_id', elementId: 'el_aabbcc' },
      knownElements,
    );
    expect(result.outcome).toBe('resolved');
  });

  it('resolves a known element_id without selector via accessibility', async () => {
    const knownElements = new Map<string, InteractiveElement>([
      ['el_112233', KNOWN_ELEMENT_NO_SELECTOR],
    ]);
    const result = await resolveTarget(
      page,
      { kind: 'element_id', elementId: 'el_112233' },
      knownElements,
    );
    expect(result.outcome).toBe('resolved');
  });

  it('returns ambiguous_target when element_id role+label matches 2+ elements', async () => {
    const ambiguousPage = makeMockPage({
      roleMap: {
        'link:Learn more': makeMockLocator(2),
      },
    });
    const knownElements = new Map<string, InteractiveElement>([
      ['el_112233', KNOWN_ELEMENT_NO_SELECTOR],
    ]);
    const result = await resolveTarget(
      ambiguousPage,
      { kind: 'element_id', elementId: 'el_112233' },
      knownElements,
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      expect(result.candidates.length).toBeLessThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: selector
// ---------------------------------------------------------------------------

describe('resolveTarget — selector', () => {
  it('resolves a selector with exactly 1 match', async () => {
    const page = makeMockPage({
      locatorMap: { '#my-button': makeMockLocator(1) },
    });
    const result = await resolveTarget(
      page,
      { kind: 'selector', selector: '#my-button' },
      new Map(),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('returns not_found for a selector with 0 matches', async () => {
    const page = makeMockPage({});
    const result = await resolveTarget(
      page,
      { kind: 'selector', selector: '.nonexistent' },
      new Map(),
    );
    expect(result.outcome).toBe('not_found');
  });

  it('returns ambiguous_target for a selector with 3 matches', async () => {
    const page = makeMockPage({
      locatorMap: { 'button.submit': makeMockLocator(3) },
    });
    const result = await resolveTarget(
      page,
      { kind: 'selector', selector: 'button.submit' },
      new Map(),
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      // All 3 candidates should be returned (3 < MAX_CANDIDATES=5).
      expect(result.candidates.length).toBe(3);
      // Query text should reference the selector.
      expect(result.query.text).toContain('button.submit');
    }
  });

  it('caps ambiguous_target candidates at 5 even when 8 elements match', async () => {
    const page = makeMockPage({
      locatorMap: { 'li.item': makeMockLocator(8) },
    });
    const result = await resolveTarget(
      page,
      { kind: 'selector', selector: 'li.item' },
      new Map(),
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      expect(result.candidates.length).toBeLessThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: semantic with role
// ---------------------------------------------------------------------------

describe('resolveTarget — semantic with role', () => {
  it('resolves to 1 match when role + text are given', async () => {
    const page = makeMockPage({
      roleMap: { 'button:Save': makeMockLocator(1) },
    });
    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Save', role: 'button' },
      new Map(),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('returns not_found when role + text match nothing', async () => {
    const page = makeMockPage({});
    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'NoSuchButton', role: 'button' },
      new Map(),
    );
    expect(result.outcome).toBe('not_found');
  });

  it('returns ambiguous_target when role + text match 2 elements', async () => {
    const page = makeMockPage({
      roleMap: { 'button:Delete': makeMockLocator(2) },
    });
    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Delete', role: 'button' },
      new Map(),
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      expect(result.query.text).toBe('Delete');
      expect(result.query.role).toBe('button');
      expect(result.candidates.length).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: semantic without role (multi-strategy)
// ---------------------------------------------------------------------------

describe('resolveTarget — semantic without role', () => {
  it('resolves when exactly one strategy yields 1 match', async () => {
    // Only the button strategy matches.
    const page = makeMockPage({
      roleMap: { 'button:Next': makeMockLocator(1) },
      // link and label return 0 (default).
    });
    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Next' },
      new Map(),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('returns not_found when no strategy matches', async () => {
    const page = makeMockPage({});
    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Invisible' },
      new Map(),
    );
    expect(result.outcome).toBe('not_found');
  });

  it('returns ambiguous_target when two strategies each match a distinct element', async () => {
    // Button strategy: 1 match at (0,0); link strategy: 1 match at (200,0).
    // They are at different positions so dedup keeps both → total 2 → ambiguous.
    const buttonLoc = makeMockLocator(1, () => ({
      role: 'button',
      label: 'Go',
      x: 0,
      y: 0,
      w: 80,
      h: 30,
    }));
    const linkLoc = makeMockLocator(1, () => ({
      role: 'link',
      label: 'Go',
      x: 200,
      y: 0,
      w: 80,
      h: 30,
    }));

    const page = makeMockPage({
      roleMap: {
        'button:Go': buttonLoc,
        'link:Go': linkLoc,
      },
    });

    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Go' },
      new Map(),
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      expect(result.candidates.length).toBe(2);
    }
  });

  it('deduplicates when two strategies hit the same DOM element', async () => {
    // Both button and label point to the SAME element at (10, 20).
    // After dedup, total unique = 1 → resolved.
    const samePositionEval = () => ({
      role: 'button',
      label: 'Submit',
      x: 10,
      y: 20,
      w: 100,
      h: 40,
    });
    const buttonLoc = makeMockLocator(1, samePositionEval);
    const labelLoc = makeMockLocator(1, samePositionEval);

    const page = makeMockPage({
      roleMap: {
        'button:Submit': buttonLoc,
      },
      labelMap: {
        Submit: labelLoc,
      },
    });

    const result = await resolveTarget(
      page,
      { kind: 'semantic', text: 'Submit' },
      new Map(),
    );
    expect(result.outcome).toBe('resolved');
  });

  it('caps candidates at 5 even when 8 unique elements are matched across strategies', async () => {
    // Button strategy returns 8 elements at distinct positions.
    const bigLoc = makeMockLocator(8, (i) => ({
      role: 'button',
      label: `Opt-${i}`,
      x: i * 50,
      y: 0,
      w: 40,
      h: 30,
    }));
    const page = makeMockPage({
      roleMap: { 'button:Opt': bigLoc },
    });

    // Use a different text so getByRole('button', {name: 'Opt'}) isn't what's
    // matched — instead craft a page where any call returns bigLoc.
    const flexPage = makeMockPage({});
    // Override getByRole to always return bigLoc for button.
    vi.spyOn(flexPage, 'getByRole').mockImplementation(
      (role: string): Locator => {
        if (role === 'button') return bigLoc;
        return makeMockLocator(0);
      },
    );
    vi.spyOn(flexPage, 'getByLabel').mockReturnValue(makeMockLocator(0));

    const result = await resolveTarget(
      flexPage,
      { kind: 'semantic', text: 'Opt' },
      new Map(),
    );
    expect(result.outcome).toBe('ambiguous_target');
    if (result.outcome === 'ambiguous_target') {
      expect(result.candidates.length).toBeLessThanOrEqual(5);
    }
  });
});
