#!/usr/bin/env node
/**
 * Telegram bot entrypoint shim.
 *
 * Invariant: this file must keep existing at this exact path. It is an esbuild
 * entry point (`scripts/build-dist.mjs` → `dist/telegram.mjs`) and the last
 * candidate in `resolveEntrypoint`'s spawn ladder (`telegram/manager.ts`:
 * `telegram.mjs` → `../telegram.js` → `../telegram.ts`). Renaming or deleting
 * it breaks the published bundle and the dev/vitest spawn path.
 *
 * Invariant: everything else lives under `src/telegram/`. This file holds only
 * the `main()` invocation, so importing any part of the bot in a test does not
 * boot a daemon — see `telegram/entry.ts`.
 */

import { main } from './telegram/entry.js';

main().catch(error => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});
