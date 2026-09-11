#!/usr/bin/env node
/**
 * Bundle the `afk web` browser frontend into src/web-ui-assets/.
 *
 * Builds the React SPA (dashboard/) via Vite. The output directory is
 * generated (gitignored) and is copied into dist/ by copyWebUiAssets()
 * from the dist build pipeline.
 *
 * History: this script used to fall back to a legacy esbuild pipeline
 * when dashboard/ was absent. The legacy vanilla-TS frontend was removed
 * once the React dashboard reached full feature parity.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'src', 'web-ui-assets');
const dashboardDir = join(repoRoot, 'dashboard');

async function main() {
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(join(dashboardDir, 'package.json'))) {
    console.error('build-web-ui: dashboard/package.json not found');
    process.exit(1);
  }

  if (!existsSync(join(dashboardDir, 'node_modules'))) {
    console.error(
      'build-web-ui: dashboard/node_modules missing — run `pnpm install` in dashboard/',
    );
    process.exit(1);
  }

  await buildDashboard();
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

  execSync(`"${viteBin}" build`, {
    cwd: dashboardDir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NODE_ENV: 'production' },
  });
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
