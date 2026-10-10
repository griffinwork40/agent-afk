/**
 * Zod schemas for `browser_event` trace payloads, extracted from
 * {@link ./events} to keep that module under the 350-code-line ceiling.
 * Re-exported from `./events` — import from there.
 *
 * @module agent/trace/events.browser
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// browser_event
// ---------------------------------------------------------------------------

export const BrowserEventToolSchema = z.enum([
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_screenshot',
  'browser_extract',
  'browser_close',
]);

export const BrowserActActionSchema = z.enum([
  'click',
  'fill',
  'press',
  'select',
  'hover',
  'scroll_to',
  'wait_for',
]);

export const BrowserEventTargetSchema = z.object({
  kind: z.enum(['semantic', 'element_id', 'selector']),
  text: z.string().max(80).optional(),
  role: z.string().optional(),
  elementId: z.string().optional(),
  // 8 hex chars per BrowserEventTarget.selectorHash contract.
  selectorHash: z.string().regex(/^[0-9a-f]{8}$/).optional(),
});

export const BrowserEventPayloadSchema = z.object({
  tool: BrowserEventToolSchema,
  action: BrowserActActionSchema.optional(),
  toolUseId: z.string(),
  // Keep 'agent-browser' in the read-side schema so old traces on disk
  // that contain backend:'agent-browser' parse without error.
  backend: z.enum(['playwright', 'agent-browser']).optional(),
  backendReason: z.string().optional(),
  target: BrowserEventTargetSchema.optional(),
  urlBefore: z.string().nullable(),
  urlAfter: z.string().nullable(),
  status: z.enum(['ok', 'error', 'ambiguous_target', 'blocked_by_policy']),
  screenshotPath: z.string().optional(),
  observationSummary: z.string().max(500).optional(),
  error: z
    .object({
      reason: z.string(),
      recoverable: z.boolean(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
});
