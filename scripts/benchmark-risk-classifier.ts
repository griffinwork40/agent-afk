#!/usr/bin/env tsx
/**
 * Contract: measure write classification with and without the temp carve-out.
 * Run: pnpm exec tsx scripts/benchmark-risk-classifier.ts
 * Warm filesystem caches, 1,000 warmups then five batches of 5,000 calls each.
 * Fixture setup/cleanup is excluded; reported values are microseconds per call.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { classifyRiskDetailed, type RiskContext } from '../src/agent/risk-classifier.js';
import { setSessionTmpdirRootForTests } from '../src/agent/session/session-tmpdir.js';

const workspace = realpathSync(process.cwd());
const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-bench-')));
const localRoot = realpathSync(mkdtempSync(path.join(workspace, '.risk-bench-')));
const iterations = 5_000;
const batches = 5;
const contexts: Record<string, RiskContext> = {
  gated: { cwd: workspace, workspaceRoot: workspace },
  ungated: { cwd: workspace },
};

try {
  // Invariant: an existing 0700 session root exercises the validated cache-hit path.
  setSessionTmpdirRootForTests(tempRoot);
  const paths = {
    'temp-existing': path.join(tempRoot, 'existing.md'),
    'temp-new': path.join(tempRoot, 'new.md'),
    'workspace-existing': path.join(localRoot, 'existing.md'),
    'workspace-new': path.join(localRoot, 'new.md'),
  };
  writeFileSync(paths['temp-existing'], 'fixture');
  writeFileSync(paths['workspace-existing'], 'fixture');
  console.log(JSON.stringify({ node: process.version, platform: process.platform, iterations, batches }));
  for (const [name, filePath] of Object.entries(paths)) {
    const input = { file_path: filePath, content: 'benchmark' };
    for (const [mode, ctx] of Object.entries(contexts)) {
      const classify = () => classifyRiskDetailed('write_file', input, ctx);
      for (let i = 0; i < 1_000; i++) classify();
      const samples: number[] = [];
      for (let batch = 0; batch < batches; batch++) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) classify();
        samples.push((performance.now() - start) * 1_000 / iterations);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ name, mode, verdict: classify().level,
        medianUs: samples[2], minUs: samples[0], maxUs: samples[4] }));
    }
  }
} finally {
  setSessionTmpdirRootForTests(undefined);
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(localRoot, { recursive: true, force: true });
}
