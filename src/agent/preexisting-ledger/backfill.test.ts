/**
 * Pure unit tests for the backfill clustering and ranking logic.
 * No filesystem access — exercises the detector + cluster logic in isolation.
 *
 * @module agent/preexisting-ledger/backfill.test
 */

import { describe, expect, it } from 'vitest';
import { detectInText } from './detector.js';
import { clusterHits, type ClusterHit as Hit } from './cluster.js';

function hitsFromText(text: string, file: string, date: string): Hit[] {
  const entries = detectInText(text);
  const hits: Hit[] = [];
  for (const entry of entries) {
    for (const locus of entry.loci) {
      hits.push({ locus, signal: entry.signal, category: entry.category, transcriptFile: file, sessionDate: date });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfill clustering', () => {
  it('clusters the same locus from multiple transcripts', () => {
    const hits: Hit[] = [
      ...hitsFromText('audit:filesize:check fails — pre-existing, not mine', 'a.md', '2026-01-01'),
      ...hitsFromText('pre-existing: audit:filesize:check is broken', 'b.md', '2026-02-01'),
      ...hitsFromText('scan:env:check fails — pre-existing defect', 'c.md', '2026-03-01'),
    ];
    const clusters = clusterHits(hits);
    const fileSizeCluster = clusters.find((c) => c.locus === 'audit:filesize:check');
    expect(fileSizeCluster).toBeDefined();
    expect(fileSizeCluster?.sessionCount).toBe(2);
    expect(fileSizeCluster?.transcriptFiles).toContain('a.md');
    expect(fileSizeCluster?.transcriptFiles).toContain('b.md');
  });

  it('ranks by descending session count', () => {
    const hits: Hit[] = [
      ...hitsFromText('audit:filesize:check fails — pre-existing', 'a.md', '2026-01-01'),
      ...hitsFromText('audit:filesize:check fails — pre-existing', 'b.md', '2026-01-02'),
      ...hitsFromText('audit:filesize:check fails — pre-existing', 'c.md', '2026-01-03'),
      ...hitsFromText('scan:env:check fails — pre-existing', 'x.md', '2026-01-01'),
    ];
    const clusters = clusterHits(hits);
    expect(clusters[0]?.locus).toBe('audit:filesize:check');
    expect(clusters[0]?.sessionCount).toBe(3);
  });

  it('uses lastSeen as tiebreaker when sessionCount is equal', () => {
    const hits: Hit[] = [
      ...hitsFromText('audit:filesize:check fails — pre-existing', 'a.md', '2026-01-01'),
      ...hitsFromText('scan:env:check fails — pre-existing', 'b.md', '2026-06-01'),
    ];
    const clusters = clusterHits(hits);
    // Both have sessionCount=1; the later date should rank first.
    expect(clusters[0]?.lastSeen).toBe('2026-06-01');
  });

  it('deduplicates the same file for the same locus', () => {
    const hits: Hit[] = [
      { locus: 'audit:filesize:check', signal: 'preexisting-sentence', category: 'gate', transcriptFile: 'same.md', sessionDate: '2026-01-01' },
      { locus: 'audit:filesize:check', signal: 'preexisting-sentence', category: 'gate', transcriptFile: 'same.md', sessionDate: '2026-01-01' },
    ];
    const clusters = clusterHits(hits);
    const c = clusters.find((cl) => cl.locus === 'audit:filesize:check');
    expect(c?.sessionCount).toBe(1); // same file counted once
  });

  it('handles empty hits gracefully', () => {
    expect(clusterHits([])).toEqual([]);
  });
});

describe('backfill detection from transcript-like text', () => {
  it('detects the spec example about compact test failure', () => {
    const text = 'the `anthropic-direct` compact test fails ... pre-existing (unrelated to my change)';
    const hits = hitsFromText(text, 'test.md', '2026-01-01');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('detects the LOC filesize failure', () => {
    const text = 'filesize check failure on `src/web-ui-assets/assets/index-CaLqZXsz.js` (374 LOC) is a pre-existing unrelated issue';
    const hits = hitsFromText(text, 'test.md', '2026-01-01');
    expect(hits.some((h) => h.locus.includes('src/'))).toBe(true);
  });

  it('detects scan:env:check fails (pre-existing phrasing)', () => {
    // Note: the detector requires the sentence itself to contain a pre-existing phrase.
    // A sentence like "main is already red: scan:env:check fails" alone (no pre-existing
    // phrase) will not trigger the preexisting-sentence signal. The real transcript
    // context contains a follow-up sentence noting it is pre-existing.
    const text = '`scan:env:check` fails — pre-existing (not introduced by my change)';
    const hits = hitsFromText(text, 'test.md', '2026-01-01');
    expect(hits.some((h) => h.locus === 'scan:env:check')).toBe(true);
  });
});
