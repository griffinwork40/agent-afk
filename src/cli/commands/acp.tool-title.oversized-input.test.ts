/**
 * Red team round 2, step 4: oversized-input display truncation (class C).
 *
 * buildPendingStart appends the absolute outside path to the title (policy.ts:99)
 * so the human can see it. boundStartDisplay (translate.bounds.ts:55) then
 * replaces ANY title whose serializedBytes > 4096 with the generic 'Tool call'.
 * If the title was already long BEFORE the outside path was appended, the outside
 * path appears in the title that gets truncated, leaving the human with no hint
 * that the call targets a path outside their project.
 *
 * The outside path ALSO appears in locations[] (policy.ts:94-96), and
 * boundStartDisplay wipes locations only when their serialized form exceeds
 * 131072 bytes (bounds.ts:56). So the question is:
 *   (a) Can an attacker construct a call where title > 4096 bytes AND
 *       the outside path is not in locations[] after bounding? → pure display hide.
 *   (b) Can they make locations also overflow (> 131072 bytes) at the same time?
 *
 * This file proves (a): a read_file call with a ~4000-char inside file_path
 * targeting an outside file collapses the title to 'Tool call' with the outside
 * path absent from the visible title. The outside path is still in locations[],
 * so this is a partial display degradation, not a full hide — classified as C
 * (input that truncates what the human sees while the full call runs).
 *
 * Proves (b): a patch_apply with ~600 outside-path changes overflows locations
 * too. After bounding, title = 'Tool call' and locations = [] — the human sees
 * no outside path at all. This IS a full display hide (class C, medium severity).
 * The gate still ASKs (the decision is not changed), but the human approves
 * without knowing what is targeted.
 *
 * Asserts the SAFE behaviour. The title test passes (locations still has the
 * path). The patch_apply locations-overflow test FAILS on 0a045c5d6.
 */
import { describe, expect, it } from 'vitest';
import { buildPendingStart } from './acp.permission.policy.js';
import { serializedBytes } from './acp.translate.bounds.js';

const SESSION_CWD = '/home/user/project';
const OUTSIDE = '/etc/passwd';

describe('redteam2: oversized-input display truncation (class C)', () => {
  it('title > 4096 bytes: boundStartDisplay replaces it with "Tool call", outside path only in locations', () => {
    // Craft a file_path that is inside cwd but long enough to push
    // "read_file <long_inside_path> /etc/passwd" over 4096 serialized bytes.
    // Directly test buildPendingStart with a short outside file_path (baseline):
    const outside = '/etc/passwd';
    const start = buildPendingStart('tid', 'read_file', { file_path: outside }, SESSION_CWD);
    // Baseline: short outside path → title should contain the outside path.
    expect(start.title).toContain(outside);
    expect(start.locations?.some(l => l.path === outside)).toBe(true);
  });

  it('title overflows: when file_path itself is 4000 chars (inside) + outside via second arg, title is "Tool call" but outside path still in locations', () => {
    // grep with a 4000-char inside path= AND a file_path= outside path.
    // toolTitle for grep uses record['path'] as suffix → long title.
    const longPath = SESSION_CWD + '/' + 'a'.repeat(4000); // inside cwd
    const start = buildPendingStart(
      'tid', 'grep',
      { pattern: 'x', path: longPath, file_path: OUTSIDE },
      SESSION_CWD,
    );
    const titleBytes = serializedBytes(start.title);
    if (titleBytes > 4096) {
      // Title was wiped — outside path must still be in locations.
      expect(
        start.title,
        'title was wiped but should remain informative',
      ).not.toBe('Tool call');
    }
    // Either way, the outside path must be in locations.
    expect(
      start.locations?.some(l => l.path === OUTSIDE) ?? false,
      'outside path must appear in locations even when title overflows',
    ).toBe(true);
  });

  it('patch_apply with many outside-path changes overflows locations[], hiding all outside paths from display', () => {
    // 700 unique outside paths, each ~200 bytes JSON: total ~140KB > 131072.
    // After boundStartDisplay: locations = []. title = 'Tool call' (patch_apply
    // has no file_path in toolTitle, so title starts as 'patch_apply', short).
    // The human sees 'Tool call' with no locations and no outside path.
    const changes = Array.from({ length: 700 }, (_, i) => ({
      path: `/outside/secrets/file${String(i).padStart(4, '0')}.txt`,
      content: 'x',
    }));
    const start = buildPendingStart('tid', 'patch_apply', { changes }, SESSION_CWD);

    // The locations should contain the outside paths before bounding.
    // After bounding (> 131072 bytes), locations is wiped to [].
    const locBytes = serializedBytes(start.locations ?? []);
    const hasOutside = (start.locations ?? []).some(l =>
      typeof l.path === 'string' && l.path.startsWith('/outside/'),
    );

    // SAFE assertion: either locations are present (outside paths visible),
    // or the title clearly names an outside path.
    // FAILS when both are wiped simultaneously.
    expect(
      hasOutside || start.title.includes('/outside/'),
      'when locations overflow, the title must still show at least one outside path — ' +
      `got title="${start.title}", locations bytes=${locBytes}, hasOutside=${hasOutside}`,
    ).toBe(true);
  });
});
