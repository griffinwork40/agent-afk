/**
 * Tests for the ignored-entry classification POLICY (`classifyIgnoredEntry`).
 *
 * The probe's own tests cover the IO around this table (git invocation, scoped
 * expansion, failure handling). What lives here is the one thing that table has
 * to get right on its own: which axis each pattern is matched against. The file
 * table is leaf-matched and the directory tables are path-matched, and both
 * halves of that split are load-bearing — so both are pinned in both
 * directions.
 */

import { describe, it, expect } from 'vitest';
import { classifyIgnoredEntry, leafOf, isSensitiveLeaf } from './worktree-ignored-patterns.js';

/**
 * Depth-invariance for the file table.
 *
 * Regression guard for the shipped bug: four entries were `^`-anchored while
 * the log emitters used `(?:^|\/)`, and the whole table was tested against the
 * full path. So a nested `src/.DS_Store` matched nothing, fell through to
 * `protected`, and the sweep preserved that worktree as `stale-dirty` forever —
 * a warn-only verdict with no age escape — while a root `.DS_Store` was reaped.
 * One Finder visit to a subdirectory was enough to make a worktree immortal.
 */
describe('classifyIgnoredEntry — machine-generated files are reapable at any depth', () => {
  const machineOwned = [
    '.afk-worktree-meta.json',
    '.eslintcache',
    '.stylelintcache',
    '.DS_Store',
    'tsconfig.tsbuildinfo',
    'debug.log',
    'npm-debug.log',
    'yarn-error.log',
    'yarn-debug.log',
    'pnpm-debug.log',
    'lerna-debug.log',
  ];

  for (const leaf of machineOwned) {
    it(`classifies ${leaf} as opaque at the root, one level down, and deeply nested`, () => {
      expect(classifyIgnoredEntry(leaf)).toBe('opaque');
      expect(classifyIgnoredEntry(`src/${leaf}`)).toBe('opaque');
      expect(classifyIgnoredEntry(`packages/app/src/${leaf}`)).toBe('opaque');
    });
  }

  // The exact pairs the post-merge review executed against the classifier. Same
  // filename, different depth, and before the fix the verdicts disagreed.
  it('gives the same verdict for a root and a nested copy of one filename', () => {
    for (const leaf of machineOwned) {
      expect(classifyIgnoredEntry(`a/b/${leaf}`)).toBe(classifyIgnoredEntry(leaf));
    }
  });

  it('normalizes a Windows-style separator before taking the leaf', () => {
    expect(classifyIgnoredEntry('packages\\app\\.eslintcache')).toBe('opaque');
  });
});

/**
 * The counterweight. Leaf-matching the file table must not widen anything else:
 * an over-inclusive rebuildable verdict is a data-loss bug, which is the whole
 * reason the table's default is `protected`.
 */
describe('classifyIgnoredEntry — leaf-matching does not over-reach', () => {
  const handAuthored = [
    'notes.md',
    'src/notes.md',
    'scratch/data.csv',
    '.vscode/launch.json',
    'fixtures/recorded-response.bin',
    // A filename that merely CONTAINS a rebuildable name is not that name.
    'my-notes/dist-plan.md',
    'src/.DS_Store.bak',
    'src/eslintcache',
  ];
  for (const entry of handAuthored) {
    it(`leaves ${entry} protected`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }

  // Precedence is unchanged: a sensitive leaf still outranks every rebuildable
  // pattern, at the root and under a build-output directory alike.
  const sensitive = ['.env', 'src/.env', 'dist/.env', 'dist/app.env', 'logs/prod.key'];
  for (const entry of sensitive) {
    it(`keeps ${entry} protected ahead of any rebuildable match`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
      expect(isSensitiveLeaf(entry)).toBe(true);
    });
  }

  // Regression: every build artifact echoes the name of the source file it was
  // produced from. A repo holding `src/agent/auth/credential-resolver.ts` emits
  // `dist/agent/auth/credential-resolver.d.ts` and a coverage page of the same
  // name — both matched `/credential/`, protected the tree, and made every
  // worktree that had run a build or a coverage pass permanently unreapable,
  // citing a "secret" that was compiler output. The suppression is scoped to
  // the DIRECTORY, not to an extension list: the mirror follows the toolchain.
  const generatedMirrors = [
    'dist/agent/auth/credential-resolver.d.ts',
    'dist/agent/auth/credential-resolver.js',
    'dist/agent/auth/credential-resolver.d.ts.map',
    'coverage/src/agent/auth/credential-resolver.ts.html',
    'coverage/src/agent/redact-secrets.ts.html',
    'node_modules/@scope/secret-box/index.js',
    'dist/docs/secret-handling.css',
  ];
  for (const entry of generatedMirrors) {
    it(`treats ${entry} as generated output, not a secret`, () => {
      expect(classifyIgnoredEntry(entry)).not.toBe('protected');
    });
  }

  // The suppression reaches ONLY the name hints, and only on an artifact
  // extension. A credential FORMAT protects the tree from anywhere, and a data
  // file under build output keeps the guarantee #759 pinned — no toolchain
  // name-mirrors a source module into `.json`, so excluding it costs nothing.
  const formatAnchored = [
    'coverage/prod.env',
    'dist/app.env',
    'coverage/src/tls.pem',
    'dist/deploy.key',
    'coverage/secret.db',
    'dist/cache/store.sqlite3',
  ];
  for (const entry of formatAnchored) {
    it(`still protects ${entry} despite living under generated output`, () => {
      expect(isSensitiveLeaf(entry)).toBe(true);
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }

  const dataUnderBuildOutput = [
    'dist/nested/app-credentials.json',
    'dist/secrets.yaml',
    'coverage/credentials.txt',
  ];
  for (const entry of dataUnderBuildOutput) {
    it(`keeps ${entry} protected — a data file is not a generated mirror`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }

  // `logs/` is rebuildable-listed but is RUNTIME output, not compiler output:
  // nothing regenerates it, so a file a human kept there survives builds and
  // must survive the sweep. Suppressing name hints inside it traded a permanent
  // false positive for a permanent data-loss risk.
  const runtimeOutput = ['logs/credentials.js', 'logs/secret-audit.html', 'logs/secret.map'];
  for (const entry of runtimeOutput) {
    it(`protects ${entry} — logs/ is runtime output, not a generated mirror`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }

  // Invariant: the accepted blast radius of the name-hint suppression, pinned
  // so it can never widen silently. Each of these was `protected` before the
  // suppression existed and is reapable now. They are compiler output — the
  // next build deletes them regardless, so the sweep is not what destroys
  // them — but the set is asserted rather than incidental, and a credential in
  // a DATA format stays protected everywhere (see dataUnderBuildOutput above).
  const acceptedReapable = [
    'dist/secret-notes.js',
    'out/client_secret.js',
    'dist/.secrets.js',
    'coverage/credentials.css',
    'dist/my-secret.ts',
    'dist/secret.env.html',
  ];
  for (const entry of acceptedReapable) {
    it(`accepts ${entry} as reapable compiler output (pinned blast radius)`, () => {
      expect(classifyIgnoredEntry(entry)).not.toBe('protected');
    });
  }

  // Outside generated output the name hints are untouched — that is where a
  // credential-shaped name is actually evidence of one.
  const authoredHints = ['credentials.json', 'src/secrets.txt', 'credentials.html', '.secrets'];
  for (const entry of authoredHints) {
    it(`keeps ${entry} protected outside generated output`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }
});

/**
 * The other half of the split. Directory patterns stay matched against the
 * whole path — leaf-matching them would classify a plain FILE named `dist` as
 * build output and would collapse the deliberate `logs/` asymmetry.
 */
describe('classifyIgnoredEntry — directory tables stay path-matched', () => {
  it('classifies dependency trees opaque at any depth', () => {
    expect(classifyIgnoredEntry('node_modules/')).toBe('opaque');
    expect(classifyIgnoredEntry('packages/app/node_modules/')).toBe('opaque');
    expect(classifyIgnoredEntry('café/node_modules/')).toBe('opaque');
  });

  it('classifies build output inspectable, so its leaves get expanded', () => {
    expect(classifyIgnoredEntry('dist/')).toBe('inspectable');
    expect(classifyIgnoredEntry('crates/server/target/')).toBe('inspectable');
  });

  it('does not treat a bare file named like a build directory as output', () => {
    for (const entry of ['dist', 'out', 'target', 'build', 'coverage', 'logs']) {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    }
  });

  // Documented residual, unchanged by the leaf fix: a non-sensitive nested log
  // re-matches the `logs/` directory pattern and stays reapable, while the same
  // filename at the root is protected by the emitter allowlist.
  it('preserves the deliberate nested-log asymmetry', () => {
    expect(classifyIgnoredEntry('decisions.log')).toBe('protected');
    expect(classifyIgnoredEntry('logs/decisions.log')).toBe('inspectable');
  });

  it('still prefers a known emitter over the containing directory', () => {
    expect(classifyIgnoredEntry('logs/debug.log')).toBe('opaque');
  });

  it('does not classify directories named like generated files as opaque files', () => {
    for (const entry of ['.DS_Store/', 'src/.eslintcache/', 'deep/.stylelintcache/', 'src/debug.log/']) {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    }
  });

  it('still applies a containing directory policy to directories named like generated files', () => {
    expect(classifyIgnoredEntry('dist/.DS_Store/')).toBe('inspectable');
    expect(classifyIgnoredEntry('node_modules/.eslintcache/')).toBe('opaque');
  });
});

describe('classifyIgnoredEntry — degenerate input fails safe', () => {
  for (const entry of ['', '/', './', '   ']) {
    it(`protects on ${JSON.stringify(entry)} rather than guessing`, () => {
      expect(classifyIgnoredEntry(entry)).toBe('protected');
    });
  }

  it('strips a trailing slash before taking the leaf', () => {
    expect(leafOf('packages/app/dist/')).toBe('dist');
  });
});
