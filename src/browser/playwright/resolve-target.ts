/**
 * Resolves a `Target` (from `browser_act`) to a Playwright `Locator` while
 * surfacing structured disambiguation and not-found outcomes rather than
 * throwing. This module is the single choke-point between the semantic
 * targeting API (`Target`) and raw Playwright — every element-finding
 * strategy lives here.
 *
 * @module browser/playwright/resolve-target
 */

import type { Page, Locator } from 'playwright';
import type { Target, InteractiveElement, AmbiguousTarget } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResolveOutcome =
  | { outcome: 'resolved'; locator: Locator }
  | AmbiguousTarget
  | { outcome: 'not_found'; query: Target };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum candidates surfaced in AmbiguousTarget. Kept small so the retry
 *  prompt stays bounded — the agent only needs to pick one. */
const MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Candidate extraction helper
//
// Contract:
//   - Takes a Locator and an index count (already clamped to MAX_CANDIDATES).
//   - For each position 0..count-1 calls locator.nth(i).evaluate() to extract
//     role, label, and bbox from the live DOM element.
//   - If extraction throws for a specific index, that candidate is silently
//     dropped (browser may have mutated between count() and evaluate()).
//   - The returned array may be shorter than `count` if some extractions fail.
//   - The `id` is derived deterministically: el_<hex6> from role:label:index
//     so repeated calls for the same element produce the same id within one
//     resolution pass.
// ---------------------------------------------------------------------------

interface RawElementInfo {
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function extractCandidate(
  locator: Locator,
  index: number,
): Promise<InteractiveElement | null> {
  try {
    const info = await locator.nth(index).evaluate((el): RawElementInfo => {
      const htmlEl = el as HTMLElement;
      const role =
        htmlEl.getAttribute('role') ??
        htmlEl.tagName.toLowerCase();
      const label =
        htmlEl.getAttribute('aria-label') ??
        htmlEl.getAttribute('placeholder') ??
        (htmlEl.innerText != null ? htmlEl.innerText.trim().slice(0, 200) : '') ??
        htmlEl.getAttribute('title') ??
        '';
      const rect = htmlEl.getBoundingClientRect();
      return {
        role,
        label,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    });

    // Deterministic 6-char hex id from role:label:index
    const raw = `${info.role}:${info.label}:${index}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    }
    const id = `el_${hash.toString(16).padStart(6, '0').slice(0, 6)}`;

    return {
      id,
      role: info.role,
      label: info.label,
      kind: null,
      value: null,
      state: { disabled: false },
      bbox: { x: info.x, y: info.y, w: info.w, h: info.h },
    };
  } catch {
    return null;
  }
}

async function buildCandidates(
  locator: Locator,
  total: number,
): Promise<InteractiveElement[]> {
  const cap = Math.min(total, MAX_CANDIDATES);
  const results = await Promise.all(
    Array.from({ length: cap }, (_, i) => extractCandidate(locator, i)),
  );
  return results.filter((c): c is InteractiveElement => c !== null);
}

// ---------------------------------------------------------------------------
// Deduplication helper for multi-strategy semantic resolution
//
// Invariant: element handle reference equality is unreliable across Playwright
// locator instances (different Locator objects pointing at the same DOM node
// may produce distinct handle objects). We deduplicate by a string key
// composed of the element's tag name and bounding box so that the same DOM
// node matched by two different strategies only counts once. This is a
// best-effort heuristic — two physically identical elements at the same bbox
// will be treated as one, which is correct for our "count unique targets"
// purpose.
// ---------------------------------------------------------------------------

interface DedupeEntry {
  key: string;
  locator: Locator;
  index: number; // index within its source locator
}

async function collectDeduped(
  sources: Array<{ loc: Locator; count: number }>,
): Promise<DedupeEntry[]> {
  const seen = new Set<string>();
  const entries: DedupeEntry[] = [];

  for (const { loc, count } of sources) {
    for (let i = 0; i < count; i++) {
      let key: string;
      try {
        key = await loc.nth(i).evaluate((el): string => {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          return `${htmlEl.tagName}@${Math.round(rect.x)},${Math.round(rect.y)}`;
        });
      } catch {
        // Element gone between count() and evaluate() — skip it.
        continue;
      }
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ key, locator: loc, index: i });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a Target to a Playwright Locator.
 *
 * Returns either:
 *   - `{ outcome: 'resolved', locator }` — exactly one element matched.
 *   - `AmbiguousTarget` — 2+ matched; agent should retry with element_id.
 *   - `{ outcome: 'not_found' }` — zero matched.
 *
 * // Invariant: returning a structured outcome rather than throwing keeps the
 * // dispatcher's error envelope reserved for unrecoverable failures (browser
 * // crashed, OOM, network down). The three structured outcomes — resolved,
 * // ambiguous_target, not_found — are all expected conditions the agent can
 * // react to. Throwing for any of them would force callers into a generic
 * // catch block and lose the structured retry hint.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  knownElements: ReadonlyMap<string, InteractiveElement>,
): Promise<ResolveOutcome> {
  switch (target.kind) {
    case 'element_id':
      return resolveElementId(page, target, knownElements);
    case 'selector':
      return resolveSelector(page, target);
    case 'semantic':
      return resolveSemantic(page, target);
  }
}

// ---------------------------------------------------------------------------
// element_id resolution
// ---------------------------------------------------------------------------

async function resolveElementId(
  page: Page,
  target: Extract<Target, { kind: 'element_id' }>,
  knownElements: ReadonlyMap<string, InteractiveElement>,
): Promise<ResolveOutcome> {
  const element = knownElements.get(target.elementId);
  if (element === undefined) {
    return { outcome: 'not_found', query: target };
  }

  // Fast path: element has a stable selector baked in.
  // When the selector matches exactly 1, return it immediately.
  // When the selector matches 0 or 2+, fall through to the accessibility path
  // so the agent gets a useful structured outcome rather than ambiguous selector
  // noise or a spurious not_found for an element the page may have re-rendered
  // without its original test-id.
  if (element.selector !== undefined) {
    const locator = page.locator(element.selector);
    const count = await locator.count();
    if (count === 1) {
      return { outcome: 'resolved', locator };
    }
    // count === 0 or count >= 2 → fall through to accessibility resolution.
  }

  // Accessibility path: resolve by role + label.
  const locator = page.getByRole(element.role as Parameters<Page['getByRole']>[0], {
    name: element.label,
    exact: true,
  });
  const count = await locator.count();

  if (count === 0) {
    return { outcome: 'not_found', query: target };
  }
  if (count === 1) {
    return { outcome: 'resolved', locator };
  }

  // 2+ matches — surface as AmbiguousTarget.
  const candidates = await buildCandidates(locator, count);
  const result: AmbiguousTarget = {
    outcome: 'ambiguous_target',
    query: { text: element.label, role: element.role },
    candidates,
  };
  return result;
}

// ---------------------------------------------------------------------------
// selector resolution
// ---------------------------------------------------------------------------

async function resolveSelector(
  page: Page,
  target: Extract<Target, { kind: 'selector' }>,
): Promise<ResolveOutcome> {
  const locator = page.locator(target.selector);
  const count = await locator.count();

  if (count === 0) {
    return { outcome: 'not_found', query: target };
  }
  if (count === 1) {
    return { outcome: 'resolved', locator };
  }

  // 2+ matches — build candidate list from the selector locator itself.
  const candidates = await buildCandidates(locator, count);
  const result: AmbiguousTarget = {
    outcome: 'ambiguous_target',
    query: { text: `[selector: ${target.selector}]` },
    candidates,
  };
  return result;
}

// ---------------------------------------------------------------------------
// semantic resolution
// ---------------------------------------------------------------------------

async function resolveSemantic(
  page: Page,
  target: Extract<Target, { kind: 'semantic' }>,
): Promise<ResolveOutcome> {
  // Contract:
  //   When `role` is provided we use a single, precise getByRole call.
  //   When `role` is absent we race three complementary strategies in parallel
  //   (button, link, label) and deduplicate by bbox+tag to avoid counting the
  //   same DOM node twice. We collect ALL matching handles before deciding —
  //   we never short-circuit on the first match because another strategy might
  //   also match the same element, and we need the accurate total to determine
  //   whether the result is ambiguous.
  if (target.role !== undefined) {
    return resolveSemanticWithRole(page, target.text, target.role);
  }
  return resolveSemanticNoRole(page, target.text, target);
}

async function resolveSemanticWithRole(
  page: Page,
  text: string,
  role: string,
): Promise<ResolveOutcome> {
  const locator = page.getByRole(role as Parameters<Page['getByRole']>[0], { name: text });
  const count = await locator.count();

  if (count === 0) {
    return { outcome: 'not_found', query: { kind: 'semantic', text, role } };
  }
  if (count === 1) {
    return { outcome: 'resolved', locator };
  }

  const candidates = await buildCandidates(locator, count);
  const result: AmbiguousTarget = {
    outcome: 'ambiguous_target',
    query: { text, role },
    candidates,
  };
  return result;
}

async function resolveSemanticNoRole(
  page: Page,
  text: string,
  originalTarget: Extract<Target, { kind: 'semantic' }>,
): Promise<ResolveOutcome> {
  // Race three strategies in parallel — all three are issued simultaneously.
  const buttonLoc = page.getByRole('button', { name: text });
  const linkLoc = page.getByRole('link', { name: text });
  const labelLoc = page.getByLabel(text, { exact: false });

  const [buttonCount, linkCount, labelCount] = await Promise.all([
    buttonLoc.count(),
    linkLoc.count(),
    labelLoc.count(),
  ]);

  const total = buttonCount + linkCount + labelCount;

  if (total === 0) {
    return { outcome: 'not_found', query: originalTarget };
  }

  // Build deduplicated entries across all matching strategies.
  const sources: Array<{ loc: Locator; count: number }> = [];
  if (buttonCount > 0) sources.push({ loc: buttonLoc, count: buttonCount });
  if (linkCount > 0) sources.push({ loc: linkLoc, count: linkCount });
  if (labelCount > 0) sources.push({ loc: labelLoc, count: labelCount });

  const deduped = await collectDeduped(sources);

  if (deduped.length === 0) {
    // All evaluate() calls failed — treat as not found.
    return { outcome: 'not_found', query: originalTarget };
  }

  if (deduped.length === 1) {
    const entry = deduped[0];
    if (entry === undefined) {
      return { outcome: 'not_found', query: originalTarget };
    }
    return { outcome: 'resolved', locator: entry.locator.nth(entry.index) };
  }

  // 2+ unique elements — build candidate list capped at MAX_CANDIDATES.
  const cappedEntries = deduped.slice(0, MAX_CANDIDATES);
  const candidates: InteractiveElement[] = [];

  for (let i = 0; i < cappedEntries.length; i++) {
    const entry = cappedEntries[i];
    if (entry === undefined) continue;
    const candidate = await extractCandidate(entry.locator, entry.index);
    if (candidate !== null) {
      // Override the id to reflect the position in the deduplicated list.
      const raw = `${candidate.role}:${candidate.label}:${i}`;
      let hash = 0;
      for (let j = 0; j < raw.length; j++) {
        hash = (hash * 31 + raw.charCodeAt(j)) >>> 0;
      }
      candidates.push({
        ...candidate,
        id: `el_${hash.toString(16).padStart(6, '0').slice(0, 6)}`,
      });
    }
  }

  const result: AmbiguousTarget = {
    outcome: 'ambiguous_target',
    query: { text },
    candidates,
  };
  return result;
}
