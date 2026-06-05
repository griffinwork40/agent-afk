/**
 * Re-export shim — all render helpers are now split into per-component
 * modules under `src/cli/render/`. This file preserves backward compat
 * for every existing `import { ... } from './render.js'` callsite.
 */
export * from './render/index.js';
