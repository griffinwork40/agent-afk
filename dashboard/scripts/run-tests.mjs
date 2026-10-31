#!/usr/bin/env node
// Contract: vitest's main process hangs after all 44+ jsdom test files
// complete (open handles from Vite's transform pipeline prevent exit,
// eventually OOMing at 4 GB). Tests finish in ~5 s; vitest never prints
// its summary or exits.
//
// This wrapper detects output quiescence (no stdout for 5 s after test
// results have been flowing) as the "tests done" signal, then kills the
// hung process. If any failure marker appears in the output, the wrapper
// exits non-zero.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vitestBin = resolve(__dirname, '..', 'node_modules', '.bin', 'vitest');

const args = ['run', ...process.argv.slice(2)];
const child = spawn(vitestBin, args, {
  stdio: ['inherit', 'pipe', 'inherit'],
});

let sawOutput = false;
let sawFailure = false;
let idleTimer = null;

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // No output for 5 s after tests were flowing — vitest is hung.
    child.kill('SIGKILL');
    process.exit(sawFailure ? 1 : 0);
  }, 5_000);
}

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  sawOutput = true;
  const text = chunk.toString();
  if (/FAIL|✗|×|failed/.test(text)) sawFailure = true;
  resetIdle();
});

child.on('close', (code) => {
  if (idleTimer) clearTimeout(idleTimer);
  process.exit(code ?? 0);
});

// Absolute ceiling: 120 s. If nothing happened by then, something is
// very wrong — exit non-zero.
setTimeout(() => {
  child.kill('SIGKILL');
  process.exit(1);
}, 120_000);
