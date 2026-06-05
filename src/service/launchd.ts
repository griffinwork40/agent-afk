/**
 * Public surface for the launchd module — thin barrel that re-exports
 * every symbol from the per-concern sub-modules under `./launchd/`.
 *
 * Callers import from `service/launchd.js` as before; the implementation
 * now lives in:
 *   - `./launchd/paths.ts`   — constants, ServiceName, path helpers
 *   - `./launchd/plist.ts`   — pure plist generation + argv resolution
 *   - `./launchd/status.ts`  — launchctl status introspection
 *   - `./launchd/install.ts` — installService / uninstallService / readPlistFile
 */
export * from './launchd/paths.js';
export * from './launchd/plist.js';
export * from './launchd/status.js';
export * from './launchd/install.js';
