#!/usr/bin/env node
/**
 * Bundle the `afk web` browser frontend into src/web-ui-assets/.
 *
 * Invariant: esbuild is invoked ONLY from this script, never at runtime. It is
 * a devDependency, so a published install has no esbuild — anything importing
 * it from src/ would break `npm i -g agent-afk`. The output of this script is
 * what ships; the bundler itself does not.
 *
 * The output directory is generated (gitignored) and is copied into dist/ by
 * copyWebUiAssets() from BOTH build pipelines.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = join(repoRoot, 'src', 'web-server', 'frontend');
const outDir = join(repoRoot, 'src', 'web-ui-assets');

async function main() {
  const entry = join(frontendDir, 'app.ts');
  if (!existsSync(entry)) {
    console.error(`build-web-ui: missing entry point ${entry}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // `chrome.ts` is a second entry point, not an import of `app.ts`: it is the
  // sidebar toggle that used to be an inline <script> in index.html, which the
  // `script-src 'self'` CSP blocks. It must ship as its own /chrome.js file.
  const chromeEntry = join(frontendDir, 'chrome.ts');
  await build({
    entryPoints: [entry, ...(existsSync(chromeEntry) ? [chromeEntry] : [])],
    outdir: outDir,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });

  // Static shell files sit beside the bundle.
  for (const name of ['index.html', 'styles.css', 'approvals.css']) {
    const from = join(frontendDir, name);
    if (!existsSync(from)) {
      console.error(`build-web-ui: missing ${name}`);
      process.exit(1);
    }
    copyFileSync(from, join(outDir, name));
  }

  const files = readdirSync(outDir);
  const total = files.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
  console.log(
    `build-web-ui: ${files.length} files -> src/web-ui-assets/ (${(total / 1024).toFixed(1)} KB)`,
  );
}

main().catch((err) => {
  console.error('build-web-ui failed:', err);
  process.exit(1);
});
