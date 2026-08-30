/**
 * Action execution and semantic target resolution for Agent Browser.
 *
 * Extracted from `AgentBrowserProvider` to keep the provider file within the
 * 350-LOC ceiling. This module owns:
 *   - `executeAction()` -- maps AFK action verbs to Agent Browser API calls.
 *   - `resolveSemanticTarget()` -- inspects the page and resolves a semantic
 *     target to a single element ID, or returns an ambiguous-target outcome.
 *   - `resolveElementId()` -- resolves element_id and selector targets against
 *     the known-elements cache.
 *
 * @module browser/agent-browser/actions
 */

import type { ActOutcome } from '../provider.js';
import type { ActInput, InteractiveElement, Target } from '../types.js';
import { enforceDomainPolicy } from '../config.js';
import type { BrowserConfig } from '../types.js';
import type { AgentBrowserClient, InspectElement } from './client.js';

// ---------------------------------------------------------------------------
// Element mapping (shared with provider)
// ---------------------------------------------------------------------------

export function mapElement(el: InspectElement): InteractiveElement {
  return {
    id: el.id,
    role: el.role,
    label: el.label,
    kind: el.kind,
    value: el.value,
    state: {
      disabled: el.disabled,
      ...(el.checked !== undefined ? { checked: el.checked } : {}),
      ...(el.selected !== undefined ? { selected: el.selected } : {}),
      ...(el.expanded !== undefined ? { expanded: el.expanded } : {}),
    },
    bbox: el.bbox,
    ...(el.selector ? { selector: el.selector } : {}),
  };
}

// ---------------------------------------------------------------------------
// Element ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a target to an element ID from the known-elements cache.
 * Returns `null` for semantic and selector targets that need a server query.
 * Throws for element_id targets that are not in the cache.
 */
export function resolveElementId(
  knownElements: Map<string, InteractiveElement>,
  target: Target,
): string | null {
  switch (target.kind) {
    case 'element_id':
      if (knownElements.has(target.elementId)) {
        return target.elementId;
      }
      throw new Error(
        `Element ${target.elementId} not found in current observation. ` +
        'Call browser_observe to refresh.',
      );
    case 'selector':
      return null;
    case 'semantic':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

/**
 * Execute a single action against an element in an Agent Browser tab.
 */
export async function executeAction(
  client: AgentBrowserClient,
  tabId: string,
  action: string,
  elementId: string,
  value?: string,
  timeoutMs?: number,
): Promise<void> {
  switch (action) {
    case 'click':
      await client.click(tabId, elementId);
      break;
    case 'fill':
      if (value === undefined) throw new Error('fill requires a value');
      await client.fill(tabId, elementId, value);
      break;
    case 'press':
      if (value === undefined) throw new Error('press requires a value (key combo)');
      await client.press(tabId, value, elementId);
      break;
    case 'select':
      if (value === undefined) throw new Error('select requires a value');
      await client.select(tabId, elementId, value);
      break;
    case 'hover':
      throw new Error(
        'hover is not supported by Agent Browser; use element_id from a prior observation to target clicks instead',
      );
    case 'scroll_to': {
      const safeId = elementId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await client.evalScript(
        tabId,
        `document.querySelector('[data-element-id="${safeId}"]')?.scrollIntoView({behavior:'smooth',block:'center'})`,
      );
      break;
    }
    case 'wait_for':
      await client.waitFor(tabId, 'element', {
        value: elementId,
        timeout: timeoutMs ?? 10_000,
      });
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Semantic target resolution
// ---------------------------------------------------------------------------

export interface SemanticResolveContext {
  client: AgentBrowserClient;
  config: BrowserConfig;
  tabId: string;
}

/**
 * Resolve a semantic target, execute the action, and return the outcome.
 * Returns `AmbiguousTarget` when multiple elements match.
 */
export async function resolveSemanticAndAct(
  ctx: SemanticResolveContext,
  input: ActInput,
): Promise<{ elementId: string } | ActOutcome> {
  if (input.target.kind !== 'semantic') {
    throw new Error('resolveSemanticAndAct called with non-semantic target');
  }

  const { elements } = await ctx.client.inspect(ctx.tabId, {
    mode: 'interactive',
    query: input.target.text,
    limit: 10,
  });

  let matches = elements;
  if (input.target.role) {
    const role = input.target.role.toLowerCase();
    matches = elements.filter((el) => el.role.toLowerCase() === role);
  }

  if (matches.length === 0) {
    throw new Error(
      `No element found matching semantic target: text="${input.target.text}"` +
      (input.target.role ? `, role="${input.target.role}"` : ''),
    );
  }

  if (matches.length > 1) {
    return {
      outcome: 'ambiguous_target',
      query: {
        text: input.target.text,
        ...(input.target.role ? { role: input.target.role } : {}),
      },
      candidates: matches.slice(0, 5).map(mapElement),
    };
  }

  const match = matches[0]!;
  const elementId = match.id;

  await executeAction(
    ctx.client,
    ctx.tabId,
    input.action,
    elementId,
    input.value,
    input.timeoutMs,
  );

  // Check if action triggered a navigation to a blocked domain.
  const readResult = await ctx.client.read(ctx.tabId, { mode: 'main' });
  const policy = enforceDomainPolicy(readResult.url, ctx.config);
  if (!policy.allowed) {
    return {
      outcome: 'blocked_by_policy',
      url: readResult.url,
      reason: `action navigated to blocked domain: ${policy.reason}`,
    };
  }

  return { elementId };
}
