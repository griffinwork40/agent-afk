#!/usr/bin/env node
/**
 * Production build: bundles agent-afk into minified .mjs files with
 * all .md prompt files inlined as string literals.
 *
 * Strategy:
 * 1. Copy src/ to a temp directory, transforming .md-reading code into
 *    inlined string literals
 * 2. Point esbuild at the transformed copy
 * 3. Clean up the temp directory
 *
 * Usage: node scripts/build-dist.mjs
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, mkdirSync, statSync, chmodSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSources } from './esbuild-plugin-inline-prompts.mjs';
import { copyBundledPlugins } from './lib/copy-bundled-plugins.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const distDir = join(repoRoot, 'dist');

// Invariant: the published artifact must not ship test scaffolding or stray
// internal references. This final pass drops *.test.ts / *.spec.ts files
// (test scaffolding that should never have shipped in the published package).
// The name-replacement pass is kept as a safety net for any remaining private
// identifiers that survive source scrubbing; on a clean public build it is a no-op.
const PRIVATE_NAME_REPLACEMENTS = [];
function scrubPublishedArtifact(dir) {
  let scrubbed = 0;
  let removed = 0;
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!ent.isFile()) continue;
      if (/\.(test|spec)\.[mc]?[jt]s$/.test(ent.name)) {
        rmSync(p);
        removed++;
        continue;
      }
      if (!/\.(mjs|js|ts|md|json)$/.test(ent.name)) continue;
      const before = readFileSync(p, 'utf-8');
      let after = before;
      for (const [re, sub] of PRIVATE_NAME_REPLACEMENTS) after = after.replace(re, sub);
      if (after !== before) {
        writeFileSync(p, after);
        scrubbed++;
      }
    }
  };
  walk(dir);
  return { scrubbed, removed };
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
// Externalize both `dependencies` AND `optionalDependencies`. The optional
// path matters for `playwright` (the browser-control backend): we never want
// to bundle 300MB of chromium drivers into dist/. esbuild leaves `import …
// from 'playwright'` as-is in the output; if the user skipped the optional
// install, the lazy import boundary in `registry.ts` short-circuits before
// the playwright module is touched.
const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
];

console.log('Building agent-afk for distribution...');
console.log(`  External deps: ${externalDeps.length}`);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Step 1: pre-transform sources
const { tmpSrc, tmpBase } = prepareSources();

try {
  // Step 2: bundle from transformed sources
  await build({
    entryPoints: {
      cli: join(tmpSrc, 'cli', 'index.ts'),
      telegram: join(tmpSrc, 'telegram.ts'),
      index: join(tmpSrc, 'index.ts'),
    },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: true,
    sourcemap: false,
    external: externalDeps,
    outdir: distDir,
    outExtension: { '.js': '.mjs' },
    tsconfig: join(repoRoot, 'tsconfig.json'),
    logLevel: 'warning',
    define: {
      __AFK_VERSION__: JSON.stringify(pkg.version),
    },
  });

  // Post-process: ensure exactly one shebang at the top of executable entry points
  for (const name of ['cli.mjs', 'telegram.mjs']) {
    const filePath = join(distDir, name);
    let content = readFileSync(filePath, 'utf-8');
    // Strip any existing shebangs (esbuild may preserve them from source)
    content = content.replace(/^#![^\n]*\n/gm, '');
    writeFileSync(filePath, '#!/usr/bin/env node\n' + content);
    chmodSync(filePath, 0o755);
  }

  // Copy postinstall script into dist/ so it ships in the npm tarball
  copyFileSync(join(repoRoot, 'scripts/postinstall.mjs'), join(distDir, 'postinstall.mjs'));

  // Copy the bundled-plugins tree (awa-bundled orchestration skills) into dist/.
  // esbuild only emits the four JS entry points; these data files are read from
  // disk at runtime (src/paths.ts getBundledPluginsDir → <dist>/bundled-plugins/),
  // so without this copy the published npm tarball ships none of the bundled
  // skills. Shared with scripts/copy-prompts.js via the same helper.
  const bundled = copyBundledPlugins(join(repoRoot, 'src'), distDir);
  if (!bundled.copied || bundled.fileCount === 0) {
    throw new Error(
      `build:dist did not copy any bundled-plugins files from ${bundled.src}. ` +
        `The published tarball would omit all bundled skills.`,
    );
  }

  // Final pass: drop test scaffolding (+ scrub any private names) from the
  // published artifact (see scrubPublishedArtifact).
  const scrub = scrubPublishedArtifact(distDir);
  console.log(`  [scrub] ${scrub.scrubbed} files scrubbed, ${scrub.removed} test files dropped`);

  console.log('\nBuild complete:');
  for (const name of ['cli.mjs', 'telegram.mjs', 'index.mjs']) {
    const size = statSync(join(distDir, name)).size;
    const kb = (size / 1024).toFixed(1);
    console.log(`  dist/${name}: ${kb} KB`);
  }
  const postSize = statSync(join(distDir, 'postinstall.mjs')).size;
  console.log(`  dist/postinstall.mjs: ${(postSize / 1024).toFixed(1)} KB (copied)`);
  console.log(`  dist/bundled-plugins/: ${bundled.fileCount} files (copied)`);
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
} finally {
  // Step 3: clean up temp directory
  rmSync(tmpBase, { recursive: true, force: true });
}
