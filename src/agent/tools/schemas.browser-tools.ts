/**
 * Tool schemas for browser-control built-ins:
 * browser_open, browser_observe, browser_act, browser_screenshot, browser_close.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * Invariant: these schemas are wire-projected by `toWireToolDef` in
 * `providers/anthropic-direct/types.ts` so the `category: 'browser'` field
 * never crosses the API boundary. Same treatment as the other AFK-internal
 * classification fields.
 *
 * History: the underlying provider (PlaywrightProvider) is lazy-loaded by
 * `src/browser/registry.ts` on first call to a browser tool. Users who
 * never invoke a browser tool never pay the 300MB Playwright + browser
 * disk cost. The optional dep + the lazy import boundary together preserve
 * the "you only pay for what you use" property.
 *
 * @module agent/tools/schemas.browser-tools
 */

import type { AnthropicToolDef } from './types.js';

export const browserOpenTool: AnthropicToolDef = {
  name: 'browser_open',
  category: 'browser',
  concurrencySafe: false,
  description:
    'Open a URL in a managed browser tab and return an observation of the page. ' +
    'Use this as the entry point for any browser-driven workflow — subsequent ' +
    '`browser_observe`, `browser_act`, and `browser_screenshot` calls operate ' +
    'on the same tab. ' +
    'The returned observation lists actionable elements with stable IDs (e.g. ' +
    '`el_a1b2`) that you can pass back via `browser_act.target.element_id` for ' +
    'unambiguous follow-up. ' +
    'Navigation is constrained by AFK_BROWSER_ALLOWED_DOMAINS / BLOCKED_DOMAINS ' +
    'when set — refused navigation returns `isError: true` with a `blocked_by_policy` ' +
    'reason. Always-on screenshot capture on error helps debug failures.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to navigate to.',
      },
      wait_for: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description:
          'When to consider navigation complete. `load` waits for the load event, ' +
          '`domcontentloaded` for parsed DOM, `networkidle` for ≥500ms of no network. ' +
          'Default: `load`. Use `networkidle` for SPAs that hydrate after load.',
      },
      screenshot: {
        type: 'boolean',
        description:
          'Capture a screenshot in the returned observation. Default: false. ' +
          'Screenshots are always captured on error regardless of this flag.',
      },
      timeout_ms: {
        type: 'number',
        description:
          'Navigation timeout in milliseconds. Default 30000, hard cap 120000.',
      },
    },
    required: ['url'],
  },
};

export const browserObserveTool: AnthropicToolDef = {
  name: 'browser_observe',
  category: 'browser',
  concurrencySafe: true,
  description:
    'Refresh the observation of the current page. Use this after waiting for ' +
    'dynamic content to load, after an action that triggered an in-page DOM ' +
    'mutation, or whenever you need to see the post-action state without firing ' +
    'a new action. Returns the same shape as `browser_open`. ' +
    'Element IDs are stable only within ONE observation — always use IDs from ' +
    'the most recent observation when calling `browser_act`.',
  input_schema: {
    type: 'object',
    properties: {
      screenshot: {
        type: 'boolean',
        description: 'Capture a screenshot in the returned observation. Default: false.',
      },
      include_hidden: {
        type: 'boolean',
        description:
          'Include elements with `display: none` or zero-size bounding boxes. ' +
          'Default: false. Use this only when debugging an element you expect to be ' +
          'present but cannot find in the default observation.',
      },
      max_elements: {
        type: 'number',
        description:
          'Cap on the interactive[] array length. Default: 80, max: 300. ' +
          'Pages with 200+ interactive elements emit a warning suggesting you scope ' +
          'further with selectors instead.',
      },
    },
    required: [],
  },
};

export const browserActTool: AnthropicToolDef = {
  name: 'browser_act',
  category: 'browser',
  concurrencySafe: false,
  description:
    'Perform an action against a target on the current page. ' +
    'Prefer semantic targets (`{ kind: "semantic", text: "Sign in", role: "button" }`) ' +
    'over selectors — they are stable across markup changes and capture the agent\'s ' +
    'INTENT (what the element does) not its STRUCTURE (where it is in the DOM). ' +
    'Use `element_id` for unambiguous follow-up on an element you saw in a recent ' +
    'observation. Use `selector` only when the page has no accessible labels. ' +
    'If a semantic target matches multiple elements, the tool returns `isError: true` ' +
    'with a disambiguation list — retry with the matching element_id. Secrets typed ' +
    'into form fields are auto-redacted from the witness layer; the page receives the ' +
    'real value.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'fill', 'press', 'select', 'hover', 'scroll_to', 'wait_for'],
        description:
          'What to do at the target. ' +
          '`click` — left-click the element. ' +
          '`fill` — clear and type `value` into a text input. ' +
          '`press` — fire a key combo (`value` is the combo, e.g. "Enter", "Control+A"). ' +
          '`select` — set a <select> element to `value` (option value, not label). ' +
          '`hover` — move the cursor onto the element. ' +
          '`scroll_to` — scroll until the element is in the viewport. ' +
          '`wait_for` — block until the element becomes visible (up to timeout_ms).',
      },
      target: {
        type: 'object',
        description:
          'How to identify the element. Prefer `semantic`; use `element_id` for ' +
          'unambiguous reuse from a prior observation; use `selector` only when the ' +
          'page lacks accessible labels.',
        properties: {
          kind: {
            type: 'string',
            enum: ['semantic', 'element_id', 'selector'],
          },
          text: {
            type: 'string',
            description:
              'Required when kind=semantic. The visible label, placeholder, accessible ' +
              'name, or button text. Match is case-sensitive and exact unless the ' +
              'resolver falls back to substring (only when role is unprovided).',
          },
          role: {
            type: 'string',
            description:
              'Optional ARIA role to disambiguate when multiple elements share a label ' +
              '(button, link, textbox, combobox, checkbox, tab, …).',
          },
          element_id: {
            type: 'string',
            description:
              'Required when kind=element_id. Must be a value from the most recent ' +
              'observation\'s `interactive[].id`. Format: `el_<6 hex chars>`.',
          },
          selector: {
            type: 'string',
            description:
              'Required when kind=selector. CSS selector by default; xpath= prefix to ' +
              'use XPath. Avoid descendant chains and class-only selectors — both are ' +
              'brittle across markup changes.',
          },
        },
        required: ['kind'],
      },
      value: {
        type: 'string',
        description:
          'Text to type (fill), key combo (press), or option value (select). Ignored ' +
          'for click/hover/scroll_to/wait_for. Password-flavored inputs and values ' +
          'matching known secret formats are auto-redacted in the witness layer.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Per-action timeout in milliseconds. Default 10000.',
      },
      screenshot: {
        type: 'boolean',
        description:
          'Capture a screenshot after the action. Always captured on failure ' +
          'regardless of this flag. Default: false.',
      },
    },
    required: ['action', 'target'],
  },
};

export const browserScreenshotTool: AnthropicToolDef = {
  name: 'browser_screenshot',
  category: 'browser',
  concurrencySafe: true,
  description:
    'Capture a PNG screenshot of the current page (or a specific element) and return ' +
    'it as a viewable image attached to the tool result — you can read it directly. ' +
    'Call this whenever you need to SEE the page (visual layout, rendering, charts, ' +
    'or anything hard to read from DOM text). The text portion of the result is ' +
    '`{ path, bytes, width, height }` as JSON; the same PNG is also written as a sidecar ' +
    'under `~/.afk/state/witness/<sessionId>/browser/screenshots/` and referenced from ' +
    'the witness trace event. Use after a `browser_act` to visually confirm the result, ' +
    'or to inspect an element that\'s hard to describe in text. (Image return works on ' +
    'Anthropic models; OpenAI-compatible providers receive the text metadata only.)',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        description:
          'Optional element to screenshot — same shape as `browser_act.target`. When ' +
          'omitted, captures the viewport. Ambiguous semantic targets throw rather than ' +
          'silently picking one.',
        properties: {
          kind: { type: 'string', enum: ['semantic', 'element_id', 'selector'] },
          text: { type: 'string' },
          role: { type: 'string' },
          element_id: { type: 'string' },
          selector: { type: 'string' },
        },
        required: ['kind'],
      },
      full_page: {
        type: 'boolean',
        description:
          'Capture the entire scrollable page rather than just the viewport. ' +
          'Default: false. Mutually exclusive with `target` — if both supplied, ' +
          '`target` wins.',
      },
    },
    required: [],
  },
};

export const browserCloseTool: AnthropicToolDef = {
  name: 'browser_close',
  category: 'browser',
  concurrencySafe: false,
  description:
    'Close the current browser session for this AFK process. Frees the per-session ' +
    'BrowserContext (cookies, history, page state) but leaves the underlying browser ' +
    'process alive. Subsequent `browser_open` calls lazily create a fresh session. ' +
    'Use this when a workflow finishes to reclaim resources, or after a failure to ' +
    'reset state.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
