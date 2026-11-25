/**
 * Zod schemas for `desktop_event` trace payloads.
 *
 * Mirrors the shape of `events.browser.ts` for the desktop tool group.
 * Re-exported from `./events` — import from there.
 *
 * Invariant: these schemas are wire-projected out of the `desktop` category
 * field before the API boundary (the same `category` stripping that browser
 * tools use in `toWireToolDef`).
 *
 * @module agent/trace/events.desktop
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// desktop_event
// ---------------------------------------------------------------------------

export const DesktopEventToolSchema = z.enum([
  'desktop_screenshot',
]);

export const DesktopEventPayloadSchema = z.object({
  tool: DesktopEventToolSchema,
  toolUseId: z.string(),
  /** Zero-based display index actually captured. */
  displayIndex: z.number().int().nonnegative().optional(),
  /** Pixel width of the captured image. */
  captureWidth: z.number().int().positive().optional(),
  /** Pixel height of the captured image. */
  captureHeight: z.number().int().positive().optional(),
  /** Display scale factor (e.g. 2 on Retina). */
  scaleFactor: z.number().positive().optional(),
  /** Absolute path to the written sidecar PNG. */
  screenshotPath: z.string().optional(),
  status: z.enum(['ok', 'error', 'disabled', 'unsupported_platform']),
  error: z
    .object({
      reason: z.string(),
      recoverable: z.boolean(),
    })
    .optional(),
  durationMs: z.number().nonnegative(),
});

export type DesktopEventPayload = z.infer<typeof DesktopEventPayloadSchema>;
