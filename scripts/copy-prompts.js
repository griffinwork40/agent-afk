#!/usr/bin/env node
// Copies all *.md files under src/ into dist/ at matching relative paths, then
// copies the bundled-plugins tree. Skills read their prompts via readFileSync
// at module-import time, so the built output must include the markdown siblings
// of each compiled .js file.

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyBundledPlugins } from './lib/copy-bundled-plugins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const srcRoot = join(repoRoot, 'src');
const distRoot = join(repoRoot, 'dist');

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = relative(srcRoot, entryPath);
      const destPath = join(distRoot, rel);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(entryPath, destPath);
    }
  }
}

walk(srcRoot);

// Bundled-plugins (awa-bundled) go through the SAME helper build-dist.mjs uses,
// so the dev build (`pnpm build`) and the publish build (`pnpm build:dist`) can
// never diverge on what ships. walk() above already copied the bundled *.md
// files; this additionally copies non-.md files (e.g. .claude-plugin/plugin.json).
copyBundledPlugins(srcRoot, distRoot);
