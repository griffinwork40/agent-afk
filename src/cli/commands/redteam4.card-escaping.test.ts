/**
 * Red team 4, item 2: card text escaping gaps.
 *
 * Finding 4b: locations[].path strings are NOT passed through escapeInvisible.
 * Finding 4c: child-origin prefix is appended AFTER boundStartDisplay, so an
 *             RLO in a model-supplied id_prefix bypasses the escape pass.
 *
 * Each test asserts the SAFE behaviour (the escaped form) and therefore FAILS
 * on the current code.
 */
import { describe, it, expect } from 'vitest';
import { boundStartDisplay } from './acp.translate.bounds.js';
import { buildPendingStart } from './acp.permission.policy.js';
import type { ToolCallStart } from './acp.wire.js';

const RLO = '\u202E'; // U+202E RIGHT-TO-LEFT OVERRIDE
const RLO_ESC = '<U+202E>';
const cwd = '/workspace/session';

// ---------------------------------------------------------------------------
// FINDING 4b: locations[].path is not escaped
// ---------------------------------------------------------------------------
describe('redteam4 finding 4b: locations path not escaped', () => {
  it('boundStartDisplay must escape RLO in locations[].path', () => {
    // A file whose name contains U+202E (legal on Linux/macOS).
    // The human sees the path reversed in a bidi GUI.
    const pathWithRlo = `/workspace/session/${RLO}elif/secret.txt`;
    const start: ToolCallStart = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'write_file',
      kind: 'edit',
      status: 'pending',
      content: [],
      locations: [{ path: pathWithRlo }],
    };
    const result = boundStartDisplay(start);
    // SAFE: every path in locations must have its bidi controls escaped
    // FAILS today: boundStartDisplay only escapes start.title, not locations
    expect(
      result.locations?.every((loc) => !loc.path.includes(RLO)),
      `locations[].path must not contain raw U+202E; got: ${JSON.stringify(result.locations)}`,
    ).toBe(true);
  });

  it('buildPendingStart: outside path with RLO pushed to locations must be escaped', () => {
    // Simulate a write_file whose file_path resolves outside the session cwd
    // and whose resolved path contains U+202E.
    // outsideTargets returns the resolved absolute path verbatim, then
    // locations.push({ path: p }) stores it unescaped.
    // We test boundStartDisplay directly since buildPendingStart is the entry point.
    const evilPath = `/other${RLO}dir/secret.txt`;
    const start: ToolCallStart = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc2',
      title: `write_file ${evilPath}`,
      kind: 'edit',
      status: 'pending',
      content: [],
      locations: [{ path: evilPath }],
    };
    const result = boundStartDisplay(start);
    expect(
      result.locations?.every((loc) => !loc.path.includes(RLO)),
      `locations path with RLO must be escaped; got: ${JSON.stringify(result.locations)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FINDING 4c: prefix injected after boundStartDisplay bypasses escaping
// ---------------------------------------------------------------------------
describe('redteam4 finding 4c: prefix appended post-escape bypasses escapeInvisible', () => {
  it('buildPendingStart: RLO in prefix must be escaped in final title', () => {
    // The model supplies id_prefix: "\u202Eevil" on an agent call.
    // acp.permission.ts line 152 passes who.child?.prefix to buildPendingStart.
    // buildPendingStart line 114: if (prefix !== '') start.title = `${prefix} ${start.title}`
    // This runs AFTER boundStartDisplay, so the RLO in prefix is never escaped.
    const evilPrefix = `${RLO}evil-prefix`;
    const result = buildPendingStart('tc3', 'write_file', { file_path: 'a.txt' }, cwd, evilPrefix);
    // SAFE: the final title must not contain a raw RLO
    expect(
      result.title.includes(RLO),
      `Final title must not contain raw U+202E but got: ${JSON.stringify(result.title)}`,
    ).toBe(false);
  });

  it('buildPendingStart: RLO-only prefix must appear as visible escape in title', () => {
    const result = buildPendingStart('tc4', 'bash', { command: 'echo hi' }, cwd, RLO);
    // The escaped form <U+202E> must be present if the prefix is included at all
    if (result.title.includes(RLO_ESC)) {
      // correctly escaped — pass
      expect(result.title).toContain(RLO_ESC);
    } else {
      // raw RLO present — fail
      expect(
        result.title.includes(RLO),
        `Raw RLO must not appear in title; got ${JSON.stringify(result.title)}`,
      ).toBe(false);
    }
  });

  it('boundStartDisplay alone does not escape RLO added after it runs', () => {
    // This documents the mechanism: escaping happens inside boundStartDisplay,
    // but the prefix is added after. We show the escape pass runs only on
    // what's inside, not what's appended afterwards.
    const start: ToolCallStart = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc5',
      title: 'bash echo hi',
      kind: 'execute',
      status: 'pending',
      content: [],
    };
    const escaped = boundStartDisplay(start);
    // Simulate what line 114 does: append prefix after escape
    const withPrefix = { ...escaped, title: `${RLO}prefix ${escaped.title}` };
    // The title now has a raw RLO at the start — this is the current bug
    expect(
      withPrefix.title.startsWith(RLO),
      'Post-escape prefix injection puts raw RLO in title (current bug)',
    ).toBe(true); // this PASSES (documents the bug) — the companion tests above FAIL
  });
});
