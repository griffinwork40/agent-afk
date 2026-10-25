#!/usr/bin/env tsx
import { CONFIG_KEY_SPECS } from '../src/config/settable-keys.js';
import { renderConfig } from './render-config-keys.mdx.js';
import { isMain, writeReference } from './lib/docs-reference.js';

if (isMain(import.meta.url)) {
  console.log(`${CONFIG_KEY_SPECS.length} configuration keys`);
  process.exitCode = writeReference('config-keys', renderConfig(CONFIG_KEY_SPECS), process.argv.includes('--check'), undefined, 'scan:config') ? 0 : 1;
}
