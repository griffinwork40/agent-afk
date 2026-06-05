/**
 * Page observation for the Playwright browser backend.
 *
 * Snapshots a live Playwright `Page` into a `BrowserObservation` that the
 * model can reason over. The module is intentionally free of Playwright
 * runtime imports — it uses only `import type` so it can be loaded without
 * Playwright being present (useful in test environments that stub the Page).
 *
 * @module browser/playwright/observe
 */

import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type {
  BoundingBox,
  BrowserObservation,
  InteractiveElement,
  InteractiveElementState,
} from '../types.js';
import { shouldRedactElementValue } from '../sanitize.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ObservePageOptions {
  /** Stable counter for observationId. Caller increments per observation. */
  observationCounter: number;
  /** Cap on interactive[] length. Default 80. */
  maxElements?: number;
  /** Include CSS-hidden elements. Default false. */
  includeHidden?: boolean;
  /** Caller-supplied screenshot path (set by handler when screenshot=true). */
  screenshotPath?: string | null;
  /** Console error count (caller tracks via page.on('console', ...)). */
  consoleErrors?: number;
  /** http status from last navigation, or null for in-page changes. */
  httpStatus?: number | null;
  /** Whether an alert/confirm dialog is currently open. */
  hasDialog?: boolean;
}

// ---------------------------------------------------------------------------
// AX node shape
//
// Invariant: Playwright's accessibility.snapshot() is deprecated in favour of
// aria snapshots (ariaSnapshot / locator.ariaSnapshot) as of v1.46. However
// the old snapshot() method still exists and returns a nested AXNodeLike tree.
// We capture the tree shape here as a local type so no runtime Playwright
// import is needed. The `children` field is recursive.
// ---------------------------------------------------------------------------

interface AXNodeLike {
  role?: string;
  name?: string;
  value?: string | number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  children?: AXNodeLike[];
}

// ---------------------------------------------------------------------------
// DOM enrichment record collected by page.evaluate
// ---------------------------------------------------------------------------

interface DomRecord {
  name: string;
  tagName: string;
  type: string | null;
  id: string | null;
  testId: string | null;
  bbox: { x: number; y: number; w: number; h: number };
}

// ---------------------------------------------------------------------------
// Actionable role set
//
// Invariant: this set determines which AX nodes survive into the observation.
// Only roles that directly map to user interactions are kept. Informational
// roles (heading, paragraph, img, …) are filtered out because they do not
// accept user input and would bloat the model's decision context.
// ---------------------------------------------------------------------------

const ACTIONABLE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'option',
  'searchbox',
  'spinbutton',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten a multi-line label to a single line and cap at 200 chars. */
function flatLabel(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Derive a short stable element id within one observation.
 *
 * Contract: `role`, `name`, and `i` (index after reading-order sort) are the
 * inputs. The index prevents collision when two elements share role + name.
 * The hex slice is 6 chars — collision probability over 80 elements is
 * negligible (~1 in 16M per pair).
 */
function elementId(role: string, name: string, i: number): string {
  const digest = createHash('sha256')
    .update(`${role}:${name}:${i}`)
    .digest('hex')
    .slice(0, 6);
  return `el_${digest}`;
}

/** Collapse runs of whitespace, strip leading/trailing, cap at 4000 chars. */
function buildTextSummary(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const MAX = 4000;
  if (collapsed.length <= MAX) return collapsed;
  return collapsed.slice(0, MAX) + '…[truncated]';
}

/** Build a key for fuzzy DOM↔AX matching from text content / label. */
function matchKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
}

// ---------------------------------------------------------------------------
// AX tree walker
//
// Invariant: we walk depth-first and accumulate only actionable nodes.
// Non-actionable nodes are still traversed so their children are not orphaned.
// The accumulator is mutated in-place for performance; callers own the array
// after this returns.
// ---------------------------------------------------------------------------

function walkAxTree(node: AXNodeLike, acc: AXNodeLike[]): void {
  const role = node.role ?? '';
  const name = node.name ?? '';

  const isActionable =
    ACTIONABLE_ROLES.has(role) &&
    // searchbox and spinbutton require a non-empty name per spec
    (role !== 'searchbox' && role !== 'spinbutton' ? true : name !== '');

  if (isActionable) {
    acc.push(node);
  }

  for (const child of node.children ?? []) {
    walkAxTree(child, acc);
  }
}

// ---------------------------------------------------------------------------
// DOM enrichment via page.evaluate
//
// We use page.evaluate (not page.$$eval) so the return type is explicit and
// not threaded through $$eval's complex overloads. The selector string is
// passed as an argument so the function is a stable expression rather than
// a closure capturing outer state.
//
// Invariant: the page-context function receives only serialisable arguments
// and returns only serialisable data. All intermediate DOM handles stay in
// the browser process.
// ---------------------------------------------------------------------------

/** DOM selector that targets all potentially interactive elements. */
const DOM_SELECTOR =
  'a[href], button, input, select, textarea, [role], [tabindex], label';

/**
 * Collect bounding boxes and stable selectors for every interactive-like
 * element in the DOM. Called via page.evaluate so the function body executes
 * in the browser context.
 */
async function collectDomRecords(page: Page): Promise<DomRecord[]> {
  return page.evaluate((selector: string): DomRecord[] => {
    const elements = Array.from(document.querySelectorAll(selector));
    const results: DomRecord[] = [];

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const htmlEl = el as HTMLElement;

      // Skip elements that are explicitly hidden and have no layout
      if (rect.width === 0 && rect.height === 0) {
        const style = window.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden') {
          continue;
        }
      }

      const tagName = el.tagName.toLowerCase();

      // Derive accessible name heuristic: aria-label > placeholder > textContent
      const label: string =
        el.getAttribute('aria-label') ??
        el.getAttribute('placeholder') ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

      const inputType: string | null =
        tagName === 'input'
          ? ((el as HTMLInputElement).type || null)
          : el.getAttribute('type');

      results.push({
        name: label,
        tagName,
        type: inputType,
        id: (el as HTMLElement).id || null,
        testId: el.getAttribute('data-testid'),
        bbox: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      });
    }
    return results;
  }, DOM_SELECTOR).catch((): DomRecord[] => []);
}

// ---------------------------------------------------------------------------
// Fallback DOM walker (when AX tree is null)
//
// Invariant: Chrome with certain flags (e.g. --disable-accessibility) returns
// null from accessibility.snapshot(). We fall back to a pure DOM walk that
// infers roles from tag names and ARIA attributes. This path is lossy — roles
// are less accurate — but better than returning zero interactive elements.
// ---------------------------------------------------------------------------

/**
 * Build a synthetic AX node list from the DOM when the accessibility tree is
 * unavailable. Roles are inferred from tag names and ARIA attributes.
 */
async function collectFallbackNodes(page: Page): Promise<AXNodeLike[]> {
  return page.evaluate((selector: string): AXNodeLike[] => {
    const tagToRole: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: 'textbox',
      textarea: 'textbox',
      select: 'combobox',
    };

    const elements = Array.from(document.querySelectorAll(selector));
    const results: AXNodeLike[] = [];

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const ariaRole = el.getAttribute('role') ?? '';
      const name: string =
        el.getAttribute('aria-label') ??
        el.getAttribute('placeholder') ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

      let role: string = ariaRole || (tagToRole[tag] ?? '');

      if (tag === 'input') {
        const t = (el as HTMLInputElement).type;
        if (t === 'checkbox') role = 'checkbox';
        else if (t === 'radio') role = 'radio';
        else if (t === 'button' || t === 'submit' || t === 'reset') role = 'button';
        else if (t === 'search') role = 'searchbox';
        else role = 'textbox';
      }

      if (!role) continue;

      const rawValue: unknown = 'value' in el
        ? (el as HTMLInputElement).value
        : undefined;
      const value: string | undefined =
        rawValue !== undefined ? String(rawValue) : undefined;
      const disabled: boolean = (el as HTMLInputElement).disabled ?? false;
      const checked: boolean | undefined =
        tag === 'input' ? (el as HTMLInputElement).checked : undefined;

      const node: AXNodeLike = { role, name, disabled };
      if (value !== undefined) node.value = value;
      if (checked !== undefined) node.checked = checked;
      results.push(node);
    }
    return results;
  }, DOM_SELECTOR).catch((): AXNodeLike[] => []);
}

// ---------------------------------------------------------------------------
// AX snapshot accessor
//
// Playwright v1.46+ deprecated page.accessibility in favour of
// page.locator(...).ariaSnapshot(). The old API still works in v1.60 but is
// not declared on the Page type in all type bundles. We access it via a
// well-typed local helper that reads through the index signature.
// ---------------------------------------------------------------------------

interface AccessibilityAPI {
  snapshot(options: { interestingOnly: boolean }): Promise<AXNodeLike | null>;
}

function getAccessibilityAPI(page: Page): AccessibilityAPI | null {
  const rec = page as unknown as Record<string, unknown>;
  const api = rec['accessibility'];
  if (api !== null && typeof api === 'object') {
    return api as AccessibilityAPI;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Snapshot the page into a model-friendly observation.
 *
 * Strategy: query the accessibility tree via `page.accessibility.snapshot()`,
 * filter to actionable roles, map to InteractiveElement, then enrich with
 * bounding boxes from a parallel DOM query. Falls back to a DOM-only walk
 * if the accessibility tree is null (some Chrome flags suppress it).
 */
export async function observePage(
  page: Page,
  opts: ObservePageOptions,
): Promise<BrowserObservation> {
  const maxElements = opts.maxElements ?? 80;
  const includeHidden = opts.includeHidden ?? false;
  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Phase 1 — parallel data collection
  //
  // We fire all three page queries concurrently to minimise latency:
  //   A. Accessibility tree snapshot
  //   B. DOM enrichment records (bboxes + selectors)
  //   C. visible text summary
  //
  // The AX snapshot and DOM eval are decoupled: we do not need one to start
  // the other. The text summary is cheap and independent.
  // -------------------------------------------------------------------------

  // Contract: page.accessibility exists on Playwright Page (deprecated but
  // still present in v1.60). We access it via getAccessibilityAPI() to avoid
  // strict TS type errors if the field is not declared in a given type version.
  const axAPI = getAccessibilityAPI(page);
  const axSnapshotPromise: Promise<AXNodeLike | null> = axAPI
    ? axAPI.snapshot({ interestingOnly: false }).catch((): null => null)
    : Promise.resolve(null);

  const domRecordsPromise: Promise<DomRecord[]> = collectDomRecords(page);

  const textRawPromise: Promise<string> = page
    .evaluate((): string => document.body?.innerText ?? '')
    .catch((): string => '');

  const urlPromise: Promise<string> = Promise.resolve(page.url());
  const titlePromise: Promise<string> = page.title().catch((): string => '');

  const [axRoot, domRecords, textRaw, url, title] = await Promise.all([
    axSnapshotPromise,
    domRecordsPromise,
    textRawPromise,
    urlPromise,
    titlePromise,
  ]);

  // -------------------------------------------------------------------------
  // Phase 2 — build candidate AX nodes
  // -------------------------------------------------------------------------

  let axNodes: AXNodeLike[];
  let usedFallback = false;

  if (axRoot !== null) {
    axNodes = [];
    walkAxTree(axRoot, axNodes);
  } else {
    // AX tree unavailable — fall back to DOM walk
    warnings.push('observation skipped accessibility tree (returned null)');
    usedFallback = true;
    const fallbackNodes = await collectFallbackNodes(page);
    axNodes = fallbackNodes.filter((n) => ACTIONABLE_ROLES.has(n.role ?? ''));
  }

  // -------------------------------------------------------------------------
  // Phase 3 — build a lookup table from DOM records for bbox enrichment
  //
  // Key: matchKey(name). When multiple DOM elements share a name we keep the
  // first non-zero bbox encountered (reading order within evaluate, which is
  // document order).
  // -------------------------------------------------------------------------

  const domByName = new Map<string, DomRecord>();
  for (const rec of domRecords) {
    const key = matchKey(rec.name);
    const existing = domByName.get(key);
    if (!existing || (existing.bbox.w === 0 && rec.bbox.w > 0)) {
      domByName.set(key, rec);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 4 — enrich AX nodes with DOM data, apply hidden filter, sort
  // -------------------------------------------------------------------------

  interface Enriched {
    ax: AXNodeLike;
    dom: DomRecord | undefined;
  }

  const enriched: Enriched[] = axNodes.map((ax) => ({
    ax,
    dom: domByName.get(matchKey(ax.name ?? '')),
  }));

  // Apply hidden filter: drop zero-bbox elements unless includeHidden
  const visible: Enriched[] = includeHidden
    ? enriched
    : enriched.filter((e) => {
        if (!e.dom) return true; // no bbox info → keep (AX tree says it exists)
        return e.dom.bbox.w > 0 || e.dom.bbox.h > 0;
      });

  // Sort by reading order: y ascending, then x ascending
  visible.sort((a, b) => {
    const ay = a.dom?.bbox.y ?? 0;
    const by_ = b.dom?.bbox.y ?? 0;
    if (ay !== by_) return ay - by_;
    const ax_ = a.dom?.bbox.x ?? 0;
    const bx = b.dom?.bbox.x ?? 0;
    return ax_ - bx;
  });

  // -------------------------------------------------------------------------
  // Phase 5 — warnings before cap
  // -------------------------------------------------------------------------

  if (visible.length > 200) {
    warnings.push('page has 200+ interactive elements; consider scoping');
  }

  // -------------------------------------------------------------------------
  // Phase 6 — cap and map to InteractiveElement
  // -------------------------------------------------------------------------

  const capped = visible.slice(0, maxElements);

  const interactive: InteractiveElement[] = capped.map((e, i) => {
    const role = e.ax.role ?? 'generic';
    const name = e.ax.name ?? '';
    const id = elementId(role, name, i);

    const bbox: BoundingBox = e.dom?.bbox ?? { x: 0, y: 0, w: 0, h: 0 };

    // Derive kind from DOM type attribute
    const kind: string | null = e.dom?.type ?? null;

    // Build value: prefer AX value, then fall through to checked state
    let value: string | null = null;
    if (e.ax.value !== undefined && e.ax.value !== null) {
      value = String(e.ax.value);
    }
    if (e.ax.checked !== undefined) {
      value = String(e.ax.checked);
    }

    // Password redaction
    if (shouldRedactElementValue({ role, kind })) {
      value = '[redacted]';
    }

    // State flags
    const state: InteractiveElementState = {
      disabled: e.ax.disabled ?? false,
    };
    if (e.ax.checked !== undefined) {
      state.checked = e.ax.checked === true || e.ax.checked === 'mixed';
    }
    if (e.ax.selected !== undefined) {
      state.selected = e.ax.selected;
    }
    if (e.ax.expanded !== undefined) {
      state.expanded = e.ax.expanded;
    }

    // Selector enrichment: prefer data-testid, then id
    let selector: string | undefined;
    if (e.dom?.testId) {
      selector = `[data-testid="${e.dom.testId}"]`;
    } else if (e.dom?.id) {
      selector = `#${e.dom.id}`;
    }

    const el: InteractiveElement = {
      id,
      role,
      label: flatLabel(name),
      kind,
      value,
      state,
      bbox,
    };
    if (selector !== undefined) {
      el.selector = selector;
    }
    return el;
  });

  // -------------------------------------------------------------------------
  // Phase 7 — assemble status and remaining warnings
  // -------------------------------------------------------------------------

  // Determine loading state from page readyState
  let loadingState: 'idle' | 'loading' | 'navigating' = 'idle';
  try {
    const readyState = await page.evaluate((): string => document.readyState);
    if (readyState === 'loading') loadingState = 'loading';
    else if (readyState === 'interactive') loadingState = 'navigating';
    else loadingState = 'idle';
  } catch {
    // If evaluate fails the page may be mid-navigation
    loadingState = 'navigating';
  }

  if (loadingState !== 'idle') {
    warnings.push('page is still loading — observation may be incomplete');
  }

  // Guard: usedFallback warning is pushed in Phase 2; avoid duplicate.
  if (usedFallback && !warnings.includes('observation skipped accessibility tree (returned null)')) {
    warnings.push('observation skipped accessibility tree (returned null)');
  }

  const textSummary = buildTextSummary(textRaw);
  const observationId = `obs_${opts.observationCounter.toString(36)}`;
  const capturedAt = new Date().toISOString();

  return {
    observationId,
    url,
    title,
    textSummary,
    interactive,
    status: {
      httpStatus: opts.httpStatus ?? null,
      loadingState,
      hasDialog: opts.hasDialog ?? false,
      consoleErrors: opts.consoleErrors ?? 0,
    },
    warnings,
    screenshotPath: opts.screenshotPath ?? null,
    capturedAt,
  };
}
