/**
 * formatDoneSummary tests — locks in the wall-clock-vs-API-time
 * disambiguation behavior that was added to clarify the
 * "Done (2s)" rendering for subagents whose provider durationMs is
 * substantially shorter than the source's wall-clock window.
 */

import { describe, it, expect } from 'vitest';
import { formatDoneSummary, freshSourceState } from './stream-renderer-source.js';

describe('formatDoneSummary', () => {
  it('renders bare Done when source has no stats and no metadata', () => {
    const source = freshSourceState('review');
    // Set startedAt to now so wallMs is ~0.
    source.startedAt = Date.now();
    const summary = formatDoneSummary(source);
    // Wall-clock fallback fires when stats array is empty AND wallMs > 0.
    // With startedAt = Date.now(), elapsed is usually 0ms → 0s skipped.
    expect(summary === 'Done' || /^Done \(\d/.test(summary)).toBe(true);
  });

  it('omits wall-clock when provider durationMs aligns with wall-clock', () => {
    const source = freshSourceState('review');
    source.startedAt = Date.now() - 2100;
    source.responseMetadata = { durationMs: 2000 } as unknown as typeof source.responseMetadata;
    source.stats.toolUses = 3;
    const summary = formatDoneSummary(source);
    expect(summary).toMatch(/3 tool calls/);
    expect(summary).toMatch(/2s/);
    // Wall ≈ provider, no surfacing.
    expect(summary).not.toMatch(/wall/);
  });

  it('surfaces wall-clock when it materially exceeds provider durationMs', () => {
    const source = freshSourceState('review');
    // Wall = ~6s, provider = 2s → ≥50% delta, ≥1s gap → surface "6s wall"
    source.startedAt = Date.now() - 6000;
    source.responseMetadata = { durationMs: 2000 } as unknown as typeof source.responseMetadata;
    const summary = formatDoneSummary(source);
    expect(summary).toMatch(/2s · \dm? ?\d?s? wall/);
  });

  it('does NOT surface wall-clock for sub-second deltas (noise guard)', () => {
    const source = freshSourceState('review');
    // Wall = ~2.5s, provider = 2s → 25% delta, 500ms gap → both gates fail.
    source.startedAt = Date.now() - 2500;
    source.responseMetadata = { durationMs: 2000 } as unknown as typeof source.responseMetadata;
    const summary = formatDoneSummary(source);
    expect(summary).not.toMatch(/wall/);
  });
});
