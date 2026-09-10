#!/usr/bin/env node
/**
 * Bundle the `afk web` browser frontend into src/web-ui-assets/.
 *
 * Invariant: esbuild is invoked ONLY from this script, never at runtime. It is
 * a devDependency, so a published install has no esbuild - anything importing
 * it from src/ would break `npm i -g agent-afk`. The output of this script is
 * what ships; the bundler itself does not.
 *
 * The output directory is generated (gitignored) and is copied into dist/ by
 * copyWebUiAssets() from BOTH build pipelines.
 *
 * History: When dashboard/ exists with node_modules, this script delegates to
 * Vite for the React SPA build. When dashboard/ is absent (published package,
 * CI without the dashboard), it falls back to the legacy esbuild pipeline for
 * the vanilla TS frontend. During the migration period both paths coexist;
 * once the React SPA reaches feature parity the legacy path is removed.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = join(repoRoot, 'src', 'web-server', 'frontend');
const outDir = join(repoRoot, 'src', 'web-ui-assets');
const dashboardDir = join(repoRoot, 'dashboard');

async function main() {
  mkdirSync(outDir, { recursive: true });

  // Prefer the React dashboard when it exists and has deps installed
  const dashboardReady =
    existsSync(join(dashboardDir, 'package.json')) &&
    existsSync(join(dashboardDir, 'node_modules'));

  if (dashboardReady) {
    await buildDashboard();
  } else {
    await buildLegacy();
  }

  reportSize();
}

/** React SPA build via Vite. Outputs directly to src/web-ui-assets/. */
async function buildDashboard() {
  console.log('build-web-ui: building React dashboard (Vite)...');

  // Use the local node_modules/.bin/vite so we always run the pinned version
  // from dashboard/package.json — never a version silently downloaded by npx.
  // On Windows, Node resolves shell:true against PATH which includes .bin/, so
  // the cross-platform pattern is: relative path with shell:true and cwd set.
  const viteBin =
    platform() === 'win32'
      ? join('node_modules', '.bin', 'vite.cmd')
      : join('node_modules', '.bin', 'vite');

  try {
    execSync(`"${viteBin}" build`, {
      cwd: dashboardDir,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } catch (err) {
    console.error(`build-web-ui: Vite exited status=${err?.status ?? '?'} signal=${err?.signal ?? 'none'}`);
    if (process.env.CI) {
      // In CI the fallback would silently ship stale assets — fail loudly instead.
      console.error('build-web-ui: Vite build failed in CI — exiting non-zero');
      throw new Error('build-web-ui: Vite build failed in CI');
    }
    console.error('build-web-ui: Vite build failed, falling back to legacy esbuild');
    await buildLegacy();
  }
}

/** Legacy esbuild pipeline for the vanilla TypeScript frontend. */
async function buildLegacy() {
  console.log('build-web-ui: building legacy frontend (esbuild)...');
  const { build } = await import('esbuild');

  const entry = join(frontendDir, 'app.ts');
  if (!existsSync(entry)) {
    console.error(`build-web-ui: missing entry point ${entry}`);
    process.exit(1);
  }

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
  for (const name of [
    'index.html',
    'styles.css',
    'approvals.css',
    'schedules.css',
    'at-file.css',
    'diff-viewer.css',
    'bg-jobs.css',
    'model-selector.css',
    'memory.css',
  ]) {
    const from = join(frontendDir, name);
    if (!existsSync(from)) {
      console.error(`build-web-ui: missing ${name}`);
      process.exit(1);
    }
    copyFileSync(from, join(outDir, name));
  }
}

function reportSize() {
  const total = dirSize(outDir);
  const count = countFiles(outDir);
  console.log(
    `build-web-ui: ${count} files -> src/web-ui-assets/ (${(total / 1024).toFixed(1)} KB)`,
  );
}

function dirSize(dir) {
  let size = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    size += s.isDirectory() ? dirSize(p) : s.size;
  }
  return size;
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    count += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return count;
}

main().catch((err) => {
  console.error('build-web-ui failed:', err);
  process.exit(1);
});
