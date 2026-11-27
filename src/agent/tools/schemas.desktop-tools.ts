/**
 * Tool schemas for desktop computer-use built-ins — Tranche 1.
 *
 * Only `desktop_screenshot` is registered in Tranche 1. The eight input
 * primitives (click, drag, type, etc.) are withheld until a real input backend
 * ships in Tranche 3M or 3W, per spec §6 Tranche 1 deliverables:
 * "The remaining eight primitives are not registered in Tranche 1. Tools that
 * do nothing are not exposed to the model."
 *
 * Invariant: the `category: 'desktop'` field is stripped before the API
 * boundary by `toWireToolDef` in `providers/anthropic-direct/types.ts`,
 * the same treatment as `category: 'browser'`.
 *
 * History: extracted into its own file to satisfy the 350-code-line ratchet
 * on `schemas.ts`. Imported and re-exported from `schemas.ts` so callers
 * import from the primary module.
 *
 * @module agent/tools/schemas.desktop-tools
 */

import type { AnthropicToolDef } from './types.js';

export const desktopScreenshotTool: AnthropicToolDef = {
  name: 'desktop_screenshot',
  category: 'desktop',
  concurrencySafe: true,
  description:
    'Capture a PNG screenshot of the host desktop and return it as a viewable ' +
    'image attached to the tool result. ' +
    'The text portion of the result is `{ path, bytes, width, height, scaleFactor, ' +
    'displayIndex, logicalWidth, logicalHeight }` as JSON; the same PNG is also ' +
    'written as a sidecar under ' +
    '`~/.afk/state/witness/<sessionId>/desktop/screenshots/` and referenced from ' +
    'the witness trace event. ' +
    'An optional `display` index (0-based) selects a specific monitor; defaults ' +
    'to display 0. An optional `region` captures a sub-rectangle of the display ' +
    'in logical pixels at the display\'s native scale. ' +
    'Requires `AFK_DESKTOP_ENABLED=1` to be set by the operator. ' +
    'macOS: the responsible process must hold Screen Recording permission ' +
    '(System Settings → Privacy & Security → Screen Recording). ' +
    'Windows (UNVERIFIED — Step 0W pending): requires a native interactive ' +
    'terminal session; WSL2 is not supported. ' +
    'Linux: not supported in v1.',
  input_schema: {
    type: 'object',
    properties: {
      display: {
        type: 'number',
        description:
          'Zero-based display index to capture. 0 is the primary display. ' +
          'Defaults to 0 when omitted.',
      },
      region: {
        type: 'object',
        description:
          'Optional capture region in logical pixels at scale 1. When omitted, ' +
          'the full display is captured. The result reports the actual pixel ' +
          'dimensions and scale factor so coordinate mapping is unambiguous.',
        properties: {
          x: { type: 'number', description: 'Left edge in logical pixels.' },
          y: { type: 'number', description: 'Top edge in logical pixels.' },
          width: { type: 'number', description: 'Width in logical pixels.' },
          height: { type: 'number', description: 'Height in logical pixels.' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
    },
    required: [],
  },
};
