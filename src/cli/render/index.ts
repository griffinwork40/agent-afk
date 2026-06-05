/**
 * CLI render helpers — reusable box-drawing and formatting primitives.
 *
 * Keeps all terminal art in one place so other modules stay clean.
 * Uses chalk, string-width, wrap-ansi (via wrap.ts), and terminal width helpers.
 *
 * Re-exports every public symbol from the per-component modules so callers
 * can continue to use `import { ... } from '../render.js'` unchanged.
 */

export * from './status-panel.js';
export * from './welcome-banner.js';
export * from './help-table.js';
export * from './error-box.js';
export * from './usage-limit-box.js';
export * from './card.js';
export * from './divider.js';
export * from './progress-bar.js';
export * from './box.js';
