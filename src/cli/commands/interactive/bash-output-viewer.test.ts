/**
 * Unit tests for bash-output-viewer.ts key-dispatch behaviour.
 *
 * Covers the SPEC 1 fix (q vs Esc distinction) and the AbortSignal close path.
 *
 * @module cli/commands/interactive/bash-output-viewer.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setConfinementRootForTest } from './bash-output-viewer-model.js';
import { runBashOutputViewer } from './bash-output-viewer.js';
import type { PickerHost } from '../../render/picker.js';
import type { PickerController } from '../../terminal-compositor.types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal PickerHost double for testing viewer key dispatch. */
function makePickerHost(): {
  host: PickerHost;
  getController: () => PickerController | null;
  lastRows: () => readonly string[];
  exitCount: () => number;
  repaintCount: () => number;
} {
  let controller: PickerController | null = null;
  let _exitCount = 0;
  let _repaintCount = 0;
  let _lastRows: readonly string[] = [];

  const host: PickerHost = {
    enterPickerMode(c: PickerController) {
      controller = c;
      _lastRows = c.renderRows();
    },
    exitPickerMode() {
      _exitCount++;
      controller = null;
    },
    repaintPicker() {
      _repaintCount++;
      if (controller) _lastRows = controller.renderRows();
    },
    terminalRows: () => 24,
  };

  return {
    host,
    getController: () => controller,
    lastRows: () => _lastRows,
    exitCount: () => _exitCount,
    repaintCount: () => _repaintCount,
  };
}

function pressKey(
  host: ReturnType<typeof makePickerHost>,
  char: string | undefined,
  key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string },
): void {
  const ctrl = host.getController();
  ctrl?.onKey(char, key);
}

// ---------------------------------------------------------------------------
// Filesystem setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let captureFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-viewer-key-test-'));
  _setConfinementRootForTest(tmpdir());
  captureFile = join(tmpDir, 'capture.txt');
  writeFileSync(captureFile, 'line1\nline2\nline3\n');
});

afterEach(() => {
  _setConfinementRootForTest(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SPEC 1 key-dispatch tests
// ---------------------------------------------------------------------------

describe('q vs Esc key distinction', () => {
  it('q with active search → closes immediately (does NOT clear search first)', async () => {
    const h = makePickerHost();
    const viewerPromise = runBashOutputViewer(h.host, captureFile);

    // Enter search mode and apply a query.
    pressKey(h, '/', { name: 'slash' });
    pressKey(h, 'l', { name: 'l' });
    pressKey(h, undefined, { name: 'return' });

    // Pressing q should close immediately, not clear search.
    const exitsBefore = h.exitCount();
    pressKey(h, 'q', { name: 'q' });
    expect(h.exitCount()).toBe(exitsBefore + 1);

    await viewerPromise;
  });

  it('Escape with active search → clears search, does NOT close', async () => {
    const h = makePickerHost();
    const viewerPromise = runBashOutputViewer(h.host, captureFile);

    // Apply a search query.
    pressKey(h, '/', { name: 'slash' });
    pressKey(h, 'l', { name: 'l' });
    pressKey(h, undefined, { name: 'return' });

    const exitsBefore = h.exitCount();
    const repaintsBefore = h.repaintCount();

    // Esc with active search → clear search, stay open.
    pressKey(h, undefined, { name: 'escape' });
    expect(h.exitCount()).toBe(exitsBefore);        // NOT closed
    expect(h.repaintCount()).toBeGreaterThan(repaintsBefore); // repainted

    // Close so the test can finish.
    pressKey(h, 'q', { name: 'q' });
    await viewerPromise;
  });

  it('q without active search → closes', async () => {
    const h = makePickerHost();
    const viewerPromise = runBashOutputViewer(h.host, captureFile);

    const exitsBefore = h.exitCount();
    pressKey(h, 'q', { name: 'q' });
    expect(h.exitCount()).toBe(exitsBefore + 1);

    await viewerPromise;
  });

  it('Escape without active search → closes', async () => {
    const h = makePickerHost();
    const viewerPromise = runBashOutputViewer(h.host, captureFile);

    const exitsBefore = h.exitCount();
    pressKey(h, undefined, { name: 'escape' });
    expect(h.exitCount()).toBe(exitsBefore + 1);

    await viewerPromise;
  });
});

// ---------------------------------------------------------------------------
// AbortSignal close path
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('abort signal fires while viewer open → viewer closes', async () => {
    const h = makePickerHost();
    const ac = new AbortController();
    const viewerPromise = runBashOutputViewer(h.host, captureFile, ac.signal);

    const exitsBefore = h.exitCount();
    ac.abort();
    await viewerPromise;
    expect(h.exitCount()).toBe(exitsBefore + 1);
  });

  it('already-aborted signal → viewer never opens (resolves immediately)', async () => {
    const h = makePickerHost();
    const signal = AbortSignal.abort();
    await runBashOutputViewer(h.host, captureFile, signal);
    // enterPickerMode should never have been called.
    expect(h.exitCount()).toBe(0);
  });
});
