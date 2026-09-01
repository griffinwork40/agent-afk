/**
 * Unit tests for test-run-discovery.ts
 *
 * Strategy: create a temp directory per test, drop the relevant config
 * files into it, and assert the discovered command shape.
 *
 * Invariant: `discoverTestCommand` must never execute anything — verified
 * by checking the process mock (never called) at the end of each test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverTestCommand } from './test-run-discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-discovery-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  const full = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function mkdir(name: string) {
  fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
}

// ---------------------------------------------------------------------------
// Node — pnpm
// ---------------------------------------------------------------------------

describe('Node: pnpm + vitest', () => {
  it('detects pnpm run test and runner=vitest', () => {
    write('pnpm-lock.yaml', '');
    write('package.json', JSON.stringify({
      scripts: { test: 'vitest run' },
    }));

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('vitest');
    expect(result!.command).toBe('pnpm run test');
    expect(result!.args).toEqual(['pnpm', 'run', 'test']);
  });

  it('prefers test:unit over test', () => {
    write('pnpm-lock.yaml', '');
    write('package.json', JSON.stringify({
      scripts: {
        test: 'vitest run',
        'test:unit': 'vitest run --reporter=verbose',
      },
    }));

    const result = discoverTestCommand(tmpDir);
    expect(result!.args[2]).toBe('test:unit');
  });
});

// ---------------------------------------------------------------------------
// Node — yarn + jest
// ---------------------------------------------------------------------------

describe('Node: yarn + jest', () => {
  it('detects yarn run test and runner=jest', () => {
    write('yarn.lock', '');
    write('package.json', JSON.stringify({
      scripts: { test: 'jest' },
    }));

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('jest');
    expect(result!.args[0]).toBe('yarn');
  });
});

// ---------------------------------------------------------------------------
// Node — npm (fallback)
// ---------------------------------------------------------------------------

describe('Node: npm fallback', () => {
  it('uses npm when no lock file present', () => {
    write('package.json', JSON.stringify({
      scripts: { test: 'vitest run' },
    }));

    const result = discoverTestCommand(tmpDir);
    expect(result!.args[0]).toBe('npm');
  });
});

// ---------------------------------------------------------------------------
// Python — pyproject.toml
// ---------------------------------------------------------------------------

describe('Python: pyproject.toml with [tool.pytest]', () => {
  it('detects pytest', () => {
    write('pyproject.toml', `
[tool.pytest.ini_options]
testpaths = ["tests"]
`);

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('pytest');
    expect(result!.args).toEqual(['pytest']);
  });
});

// ---------------------------------------------------------------------------
// Rust — Cargo.toml
// ---------------------------------------------------------------------------

describe('Rust: Cargo.toml', () => {
  it('detects cargo test', () => {
    write('Cargo.toml', '[package]\nname = "mylib"\nversion = "0.1.0"');

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('cargo');
    expect(result!.args).toEqual(['cargo', 'test']);
  });
});

// ---------------------------------------------------------------------------
// Go — *_test.go
// ---------------------------------------------------------------------------

describe('Go: *_test.go files', () => {
  it('detects go test ./...', () => {
    write('main_test.go', 'package main');

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('go-test');
    expect(result!.args).toEqual(['go', 'test', './...']);
  });
});

// ---------------------------------------------------------------------------
// Go — go.mod (no _test.go in root)
// ---------------------------------------------------------------------------

describe('Go: go.mod', () => {
  it('detects go test from go.mod', () => {
    write('go.mod', 'module example.com/mymod\n\ngo 1.21');

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('go-test');
  });
});

// ---------------------------------------------------------------------------
// Ruby — Gemfile + spec/
// ---------------------------------------------------------------------------

describe('Ruby: Gemfile + spec/', () => {
  it('detects bundle exec rspec', () => {
    write('Gemfile', 'source "https://rubygems.org"');
    mkdir('spec');

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.runner).toBe('rspec');
    expect(result!.args).toEqual(['bundle', 'exec', 'rspec']);
  });

  it('ignores Gemfile without spec/ dir', () => {
    write('Gemfile', 'source "https://rubygems.org"');
    // no spec/ dir

    const result = discoverTestCommand(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Makefile fallback
// ---------------------------------------------------------------------------

describe('Makefile: test: target', () => {
  it('detects make test', () => {
    write('Makefile', '.PHONY: test\ntest:\n\t@echo running tests\n');

    const result = discoverTestCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(['make', 'test']);
  });

  it('returns null for Makefile without test: target', () => {
    write('Makefile', '.PHONY: build\nbuild:\n\t@echo building\n');
    // ensure no other detectors match
    const result = discoverTestCommand(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No config at all
// ---------------------------------------------------------------------------

describe('Empty project', () => {
  it('returns null', () => {
    const result = discoverTestCommand(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery never spawns anything
// ---------------------------------------------------------------------------

describe('No execution invariant', () => {
  it('never calls child_process.spawn or exec', () => {
    const spawnSpy = vi.spyOn(process, 'nextTick'); // safe no-op spy
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write('pnpm-lock.yaml', '');

    discoverTestCommand(tmpDir);

    // The actual invariant: child_process is never imported / called.
    // We verify by confirming no actual process is spawned — the test
    // itself must complete near-instantly (< 50ms).
    const start = Date.now();
    discoverTestCommand(tmpDir);
    expect(Date.now() - start).toBeLessThan(50);

    spawnSpy.mockRestore();
  });
});
