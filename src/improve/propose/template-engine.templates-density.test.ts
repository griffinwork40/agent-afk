/**
 * Tests for helpers exported from template-engine.templates-density.ts
 *
 * Coverage:
 *   - rootCauseFromClusterKey maps known patterns correctly
 *   - rootCauseFromClusterKey returns 'unknown' for unrecognised keys
 *   - likelyFilesForTool names the handler file first for a known tool
 *   - likelyFilesForTool always includes dispatcher.ts
 *   - toolFailureDensityTemplate fixSketch mentions errorHead and subagent journal
 *   - toolFailureDensityTemplate fixSketch embeds the tool name in Option A
 *   - toolFailureDensityTemplate fixSketch does NOT claim traces lack args
 */

import { describe, it, expect } from 'vitest';
import {
  rootCauseFromClusterKey,
  likelyFilesForTool,
  toolFailureDensityTemplate,
} from './template-engine.templates-density.js';
import type { FailureCard } from '../schemas.js';
import { redactSecrets } from '../../agent/redact-secrets.js';

function makeToolCard(toolName: string, extra: Record<string, unknown> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: `tool-failure-density-${toolName}-aabbcc`,
    title: `'${toolName}' tool high failure rate`,
    pattern: 'tool-failure-density',
    severity: 'medium',
    status: 'open',
    firstSeen: '2026-05-22T10:00:00.000Z',
    lastSeen: '2026-05-22T10:00:00.000Z',
    occurrenceCount: 3,
    sightingCount: 0,
    evidence: [],
    notes: [],
    detail: {
      detector: 'tool-failure-density@v2',
      toolName,
      totalCalls: 10,
      failureCount: 3,
      failureRate: 0.3,
      truncatedFailureCount: 0,
      sessionIds: ['sess-abc123'],
      ...extra,
    },
  };
}

describe('rootCauseFromClusterKey', () => {
  it('returns hook-overreach for block/permission patterns', () => {
    expect(rootCauseFromClusterKey('command blocked by risk classifier')).toBe('hook-overreach');
    expect(rootCauseFromClusterKey('permission denied reading file')).toBe('hook-overreach');
    expect(rootCauseFromClusterKey('not allowed by allowlist')).toBe('hook-overreach');
  });

  it('returns schema-too-strict for validation/schema patterns', () => {
    expect(rootCauseFromClusterKey('invalid input: missing required field')).toBe('schema-too-strict');
    expect(rootCauseFromClusterKey('validation error at path')).toBe('schema-too-strict');
    expect(rootCauseFromClusterKey('parse error: unexpected token')).toBe('schema-too-strict');
  });

  it('returns tool-output-shape for not-found/ENOENT patterns', () => {
    expect(rootCauseFromClusterKey('enoent no such file')).toBe('tool-output-shape');
    expect(rootCauseFromClusterKey('file not found at path')).toBe('tool-output-shape');
    expect(rootCauseFromClusterKey('cannot find module')).toBe('tool-output-shape');
  });

  it('returns timeout-too-low for timeout patterns', () => {
    expect(rootCauseFromClusterKey('timed out after <nms>')).toBe('timeout-too-low');
    expect(rootCauseFromClusterKey('deadline exceeded')).toBe('timeout-too-low');
  });

  it('returns unknown for unrecognised keys', () => {
    expect(rootCauseFromClusterKey('something completely different')).toBe('unknown');
    expect(rootCauseFromClusterKey('<empty>')).toBe('unknown');
    expect(rootCauseFromClusterKey('')).toBe('unknown');
  });
});

describe('likelyFilesForTool', () => {
  it('puts the named handler file first with medium confidence', () => {
    const files = likelyFilesForTool('bash');
    expect(files[0]!.path).toBe('src/agent/tools/handlers/bash.ts');
    // Fix 3: confidence downgraded to 'medium' — several tools share a handler
    // file (e.g. create_schedule → schedules.ts), so 'high' overstated certainty.
    expect(files[0]!.confidence).toBe('medium');
  });

  it('always includes dispatcher.ts', () => {
    const files = likelyFilesForTool('grep');
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('dispatcher.ts'))).toBe(true);
  });

  it('skips the handler-specific entry for unknown/empty tool names', () => {
    const files = likelyFilesForTool('');
    const paths = files.map((f) => f.path);
    expect(paths.every((p) => !p.endsWith('.ts') || p.includes('dispatcher') || p.includes('tool-failure-density'))).toBe(true);
  });
});

describe('toolFailureDensityTemplate — fixSketch', () => {
  it('mentions errorHead', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    expect(sketch).toContain('errorHead');
  });

  it('mentions subagent journal', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    expect(sketch.toLowerCase()).toContain('subagent');
  });

  it('does NOT claim that traces lack args or that args are unrecoverable', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('git-read'));
    expect(sketch).not.toContain('does not capture tool args');
    expect(sketch).not.toContain('unrecoverable');
  });

  it('embeds the tool name in the Option A handler path', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('wait-for'));
    expect(sketch).toContain('handlers/wait-for.ts');
  });

  it('two different tools produce different fixSketches', () => {
    const a = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    const b = toolFailureDensityTemplate.fixSketch(makeToolCard('git-read'));
    expect(a).not.toBe(b);
  });

  // M2 fix: test with an underscored runtime tool name to catch H3-class regressions
  it('underscored tool names produce hyphenated handler paths (read_file → read-file.ts)', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('read_file'));
    expect(sketch).toContain('handlers/read-file.ts');
    expect(sketch).not.toContain('handlers/read_file.ts');
  });

  it('underscored tool name wait_for produces hyphenated handler path', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('wait_for'));
    expect(sketch).toContain('handlers/wait-for.ts');
    expect(sketch).not.toContain('handlers/wait_for.ts');
  });

  // H2 fix: verify the CLI command uses positional arg, not --session/--tool flags
  it('fixSketch CLI command uses positional session id, not --session/--tool flags', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(
      makeToolCard('bash', { sessionIds: ['sess-abc123'] }),
    );
    expect(sketch).toContain('afk trace show sess-abc123 --results');
    expect(sketch).not.toContain('--session');
    expect(sketch).not.toContain('--tool sess-abc123');
  });

  // errorClusters: card WITH clusters surfaces them in fixSketch
  it('fixSketch includes error-clusters section when card has errorClusters', () => {
    const card = makeToolCard('bash', {
      failureCount: 10,
      errorClusters: [
        { normalized: 'command blocked by risk classifier', count: 7, sample: 'command blocked by risk classifier (hook: bash-guard)' },
        { normalized: 'enoent no such file or directory', count: 3, sample: 'ENOENT: no such file or directory, open \'/tmp/foo\'' },
      ],
    });
    const sketch = toolFailureDensityTemplate.fixSketch(card);
    expect(sketch).toContain('Error clusters');
    expect(sketch).toContain('command blocked by risk classifier');
    expect(sketch).toContain('enoent no such file or directory');
    // sample text is embedded
    expect(sketch).toContain('bash-guard');
    // percentage rendered
    expect(sketch).toContain('70%');
  });

  // errorClusters: card WITHOUT clusters omits the section (no regression)
  it('fixSketch has no error-clusters section when errorClusters is absent', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    expect(sketch).not.toContain('Error clusters');
  });

  // errorClusters: card with empty clusters array omits the section
  it('fixSketch has no error-clusters section when errorClusters is an empty array', () => {
    const card = makeToolCard('bash', { errorClusters: [] });
    const sketch = toolFailureDensityTemplate.fixSketch(card);
    expect(sketch).not.toContain('Error clusters');
  });
});

// ---------------------------------------------------------------------------
// toolFailureDensityTemplate — hypothesis with errorClusters
// ---------------------------------------------------------------------------

describe('toolFailureDensityTemplate — cluster rendering safety', () => {
  const secret = 'sk-ant-FAKE_CLUSTER_SENTINEL_NOT_A_REAL_KEY';
  const paths = [
    '/Users/fake-alice/private/project/file.ts',
    '/home/fake-bob/private/project/file.ts',
    String.raw`C:\Users\fake-carol\private\project\file.ts`,
    'C:/Users/fake-dan/private/project/file.ts',
    '"/Users/fake alice/private project/file.ts"',
    String.raw`"C:\Users\fake carol\private project\file.ts"`,
  ];

  it('documents that the upstream secret redactor deliberately preserves home paths', () => {
    for (const path of paths) expect(redactSecrets(path)).toBe(path);
    expect(redactSecrets(secret)).toBe('[REDACTED]');
  });

  for (const field of ['normalized', 'sample'] as const) {
    for (const render of ['hypothesis', 'fixSketch'] as const) {
      it(`${render} sanitizes ${field}: POSIX/Windows home paths and fake credentials`, () => {
        for (const path of paths) {
          const cluster = { normalized: 'ENOENT', count: 3, sample: 'ENOENT' };
          cluster[field] = `ENOENT: open ${path} token ${secret}`;
          const output = toolFailureDensityTemplate[render](makeToolCard('bash', { errorClusters: [cluster] }));
          expect(output).not.toContain(path);
          expect(output).not.toMatch(/fake-(?:alice|bob|carol|dan)|fake (?:alice|carol)|private/);
          expect(output).not.toContain(secret);
          expect(output).toContain('ENOENT');
          expect(output).toContain('file.ts');
          expect(output).toContain('REDACTED');
        }
      });
    }
  }

  for (const field of ['normalized', 'sample'] as const) {
    it(`redacts ${field} credentials before length truncation in both renderers`, () => {
      const cluster = { normalized: 'ENOENT', sample: 'ENOENT', count: 3 };
      cluster[field] = `${'error '.repeat(29)}${secret}`;
      const card = makeToolCard('bash', { errorClusters: [cluster] });
      for (const render of ['hypothesis', 'fixSketch'] as const) {
        const output = toolFailureDensityTemplate[render](card);
        expect(output).not.toContain(secret);
        expect(output).not.toContain('sk-ant-FAKE');
        expect(output).toContain('REDACTED');
      }
    });
  }

  it('removes home-directory-only usernames and collapses multiple paths in both fields', () => {
    const home = String.raw`ENOENT /Users/fake-alice /home/fake-bob/ C:\Users\fake-carol\ /root`;
    const card = makeToolCard('bash', {
      errorClusters: [{ normalized: home, sample: home, count: 3 }],
    });
    for (const render of ['hypothesis', 'fixSketch'] as const) {
      const output = toolFailureDensityTemplate[render](card);
      expect(output).not.toMatch(/fake-|\/root|\/Users|\/home|C:\\/);
      expect(output).toContain('ENOENT');
    }
  });

  // ---- Finding #5103-1: path sanitizer gap fixes ----

  it('does NOT match /rootfs, /root2, or /root_home (boundary fix)', () => {
    // clusterMarkdown encodes chars like _ as HTML entities, so check by basename
    // which contains no markdown-special characters.
    const cases: [string, string][] = [
      ['/rootfs/sentinel-alpha', 'sentinel-alpha'],
      ['/root2/sentinel-beta', 'sentinel-beta'],
      ['/root_home/sentinel-gamma', 'sentinel-gamma'],
    ];
    for (const field of ['normalized', 'sample'] as const) {
      for (const [text, basename] of cases) {
        const cluster = { normalized: 'err', count: 1, sample: 'err' };
        cluster[field] = `open ${text} failed`;  // text = e.g. /rootfs/sentinel-alpha
        const output = toolFailureDensityTemplate.fixSketch(
          makeToolCard('bash', { errorClusters: [cluster] }),
        );
        // basename survives (path was not sanitised away)
        expect(output).toContain(basename);
        // must NOT have been rewritten to <home>…
        expect(output).not.toContain('<home>');
      }
    }
  });

  it('still matches bare /root and /root/ (boundary fix does not over-prune)', () => {
    for (const text of ['/root', '/root/']) {
      const cluster = { normalized: `ENOENT ${text} perm`, count: 1, sample: `open ${text}` };
      const card = makeToolCard('bash', { errorClusters: [cluster] });
      for (const render of ['hypothesis', 'fixSketch'] as const) {
        const output = toolFailureDensityTemplate[render](card);
        expect(output).not.toMatch(/\/root/);
      }
    }
  });

  it('sanitizes unquoted POSIX path with space in directory name (space-in-dir fix)', () => {
    // /Users/alice/My Project/a.ts — username has no space, but directory does
    const text = '/Users/fake-alice/My Project/a.ts';
    for (const field of ['normalized', 'sample'] as const) {
      const cluster = { normalized: 'ENOENT', count: 1, sample: 'ENOENT' };
      cluster[field] = `open ${text} failed`;
      const output = toolFailureDensityTemplate.fixSketch(
        makeToolCard('bash', { errorClusters: [cluster] }),
      );
      expect(output).not.toContain('fake-alice');
      expect(output).not.toContain('My Project');
      expect(output).toContain('a.ts');
    }
  });

  it('sanitizes unquoted Windows path with space in directory name (space-in-dir fix)', () => {
    const text = String.raw`C:\Users\fake-carol\My Project\a.ts`;
    for (const field of ['normalized', 'sample'] as const) {
      const cluster = { normalized: 'ENOENT', count: 1, sample: 'ENOENT' };
      cluster[field] = `open ${text} failed`;
      const output = toolFailureDensityTemplate.fixSketch(
        makeToolCard('bash', { errorClusters: [cluster] }),
      );
      expect(output).not.toContain('fake-carol');
      expect(output).not.toContain('My Project');
      expect(output).toContain('a.ts');
    }
  });

  it('sanitizes UNC home paths (UNC coverage fix)', () => {
    const text = String.raw`\\fileserver\share\Users\fake-alice\project\secret.ts`;
    for (const field of ['normalized', 'sample'] as const) {
      const cluster = { normalized: 'ENOENT', count: 1, sample: 'ENOENT' };
      cluster[field] = `open ${text} failed`;
      const output = toolFailureDensityTemplate.fixSketch(
        makeToolCard('bash', { errorClusters: [cluster] }),
      );
      expect(output).not.toContain('fake-alice');
      expect(output).not.toContain('fileserver');
      expect(output).toContain('secret.ts');
    }
  });

  it('sanitizes quoted UNC path with space (UNC + space fix)', () => {
    const text = String.raw`"\\fileserver\share\Users\fake alice\My Project\secret.ts"`;
    for (const field of ['normalized', 'sample'] as const) {
      const cluster = { normalized: 'ENOENT', count: 1, sample: 'ENOENT' };
      cluster[field] = `open ${text} failed`;
      const output = toolFailureDensityTemplate.fixSketch(
        makeToolCard('bash', { errorClusters: [cluster] }),
      );
      expect(output).not.toContain('fake alice');
      expect(output).not.toContain('fileserver');
      expect(output).toContain('secret.ts');
    }
  });

  it('keeps untrusted labels and samples on one line with safe markdown and hypothesis quotes', () => {
    const hostile = 'ENOENT "quoted" `tick`\r\n## injected **bold** [link](https://invalid.test) <img>';
    const card = makeToolCard('bash', {
      errorClusters: [{ normalized: hostile, sample: hostile, count: 3 }],
    });
    const hypothesis = toolFailureDensityTemplate.hypothesis(card);
    const sketch = toolFailureDensityTemplate.fixSketch(card);
    expect(hypothesis).not.toMatch(/[\r\n`]/);
    expect(hypothesis.match(/"/g)).toHaveLength(4); // only the two enclosing quote pairs
    expect(sketch).not.toContain('\n## injected');
    const row = sketch.split('\n').find((line) => line.startsWith('- **'))!;
    expect(row.match(/`/g)).toHaveLength(2); // only the sample's inline-code delimiters
    const label = row.split(' · sample: ')[0]!;
    expect(label).not.toContain('**bold**');
    expect(label).not.toContain('<img>**');
    expect(row).toContain('sample: `ENOENT ’quoted’ ’tick’ ## injected **bold** [link](https://invalid.test) <img>`');
    expect(hypothesis).not.toContain('[link](');
  });

  it('bounds both cluster fields and the number of rendered clusters without mutating the card', () => {
    const long = `ENOENT ${'ordinary error text '.repeat(100)}`;
    const clusters = Array.from({ length: 100 }, (_, i) => ({
      normalized: `${long} label ${i}`, sample: `${long} sample ${i}`, count: 1,
    }));
    const card = makeToolCard('bash', { errorClusters: clusters });
    const sketch = toolFailureDensityTemplate.fixSketch(card);
    const hypothesis = toolFailureDensityTemplate.hypothesis(card);
    const rows = sketch.split('\n').filter((line) => line.startsWith('- **'));
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.length < 500)).toBe(true);
    expect(hypothesis.length).toBeLessThan(900);
    expect(sketch).not.toContain(long);
    expect(hypothesis).not.toContain(long);
    expect(clusters[0]!.normalized).toContain(long);
  });
});

describe('toolFailureDensityTemplate — hypothesis with errorClusters', () => {
  it('names the dominant cluster when errorClusters is present', () => {
    const card = makeToolCard('wait_for', {
      failureCount: 20,
      errorClusters: [
        { normalized: 'timed out after <dur>', count: 15, sample: 'timed out after 30s' },
        { normalized: 'enoent no such file', count: 5, sample: 'ENOENT: no such file' },
      ],
    });
    const hypothesis = toolFailureDensityTemplate.hypothesis(card);
    // dominant cluster named with percentage
    expect(hypothesis).toContain('timed out after &#60;dur&#62;');
    expect(hypothesis).toContain('75%');
    // sample included
    expect(hypothesis).toContain('timed out after 30s');
    // should NOT fall back to options A-D when clusters present
    expect(hypothesis).not.toContain('Likely causes: (a)');
  });

  it('falls back to options A-D when errorClusters is absent', () => {
    const hypothesis = toolFailureDensityTemplate.hypothesis(makeToolCard('bash'));
    expect(hypothesis).toContain('Likely causes: (a)');
  });

  it('falls back to options A-D when errorClusters is an empty array', () => {
    const card = makeToolCard('bash', { errorClusters: [] });
    const hypothesis = toolFailureDensityTemplate.hypothesis(card);
    expect(hypothesis).toContain('Likely causes: (a)');
  });
});
