/** Real StreamRenderer PTY lifecycle acceptance plus raw non-TTY subprocess coverage. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SKILL_IDENTITY_SCENARIOS, type PtyExpect } from './skill-identity-fixtures.js';
import { loadNodePty, nodePtyAvailable, maxBlankRun, type PtyRunResult } from './harness.js';
import { PTY_DONE_SENTINEL, findResizeMarker } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Node-pty availability gate (mirrors compositor-scrollback.pty.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
const ci = process.env['CI'];
const mustRun =
  (ci != null && ci !== '' && ci !== 'false' && ci !== '0') ||
  process.env['AFK_PTY_REQUIRED'] === '1';
const avail = nodePtyAvailable();

// ─────────────────────────────────────────────────────────────────────────────
// Custom runner — identical to harness.runScenarioInPty but uses the
// skill-identity-specific driver (tests/pty/skill-identity-driver.ts).
// ─────────────────────────────────────────────────────────────────────────────
const _require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_DRIVER_PATH = fileURLToPath(new URL('./skill-identity-driver.ts', import.meta.url));

async function runSkillIdentityScenario(opts: {
  name: string;
  cols: number;
  rows: number;
  contentHug?: boolean;
  timeoutMs?: number;
}): Promise<PtyRunResult> {
  const { name, cols, rows, contentHug = false, timeoutMs = 20_000 } = opts;
  const pty = loadNodePty();
  const xterm = await import(pathToFileURL(_require.resolve('@xterm/headless')).href);
  const Terminal =
    (xterm as { Terminal?: unknown }).Terminal ??
    (xterm as { default?: { Terminal?: unknown } }).default?.Terminal;
  if (typeof Terminal !== 'function') throw new Error('@xterm/headless: Terminal constructor not found');

  const child = pty.spawn(
    process.execPath,
    ['--import', 'tsx', SKILL_DRIVER_PATH, name],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        AFK_PTY_CONTENT_HUG: contentHug ? '1' : '0',
      },
    },
  );

  let buf = '';
  let captured: string | null = null;
  let resizeAt: ReturnType<typeof findResizeMarker> = null;

  child.onData((d: string) => {
    buf += d;
    if (resizeAt === null) {
      const marker = findResizeMarker(buf);
      if (marker) {
        resizeAt = marker;
        try { child.resize(marker.cols, marker.rows); } catch { /* child gone */ }
      }
    }
    if (captured === null) {
      const idx = buf.indexOf(PTY_DONE_SENTINEL);
      if (idx >= 0) captured = buf.slice(0, idx);
    }
  });

  const exitCode = await new Promise<number | 'timeout'>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* gone */ }
      resolve('timeout');
    }, timeoutMs);
    child.onExit(({ exitCode: ec }: { exitCode: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ec);
    });
  });

  const sawSentinel = captured !== null;
  const raw = captured ?? buf;

  const term = new (Terminal as new (o: Record<string, unknown>) => {
    write(d: string, cb: () => void): void;
    resize(c: number, r: number): void;
    buffer: {
      active: {
        baseY: number;
        length: number;
        getLine(i: number): { translateToString(t: boolean): string; isWrapped: boolean } | undefined;
      };
    };
    dispose(): void;
  })({ cols, rows, scrollback: 1000, allowProposedApi: true });

  if (resizeAt) {
    const pre = raw.slice(0, resizeAt.start);
    const post = raw.slice(resizeAt.end);
    await new Promise<void>((r) => term.write(pre, r));
    term.resize(resizeAt.cols, resizeAt.rows);
    await new Promise<void>((r) => term.write(post, r));
  } else {
    await new Promise<void>((r) => term.write(raw, r));
  }

  const b = term.buffer.active;
  const baseY = b.baseY;
  const lines: string[] = [];
  const wrapped: boolean[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    lines.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
    wrapped.push(l ? l.isWrapped : false);
  }
  term.dispose();

  const scrollback = lines.slice(0, baseY);
  const viewport = lines.slice(baseY);

  return {
    raw,
    sawSentinel,
    exitCode,
    lines,
    wrapped,
    baseY,
    scrollback,
    viewport,
    dump(): string {
      return lines
        .map((l, i) => `[${i < baseY ? 'SB' : 'VP'} ${String(i).padStart(3)}]${wrapped[i] ? '↩' : ' '}${JSON.stringify(l)}`)
        .join('\n');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness — verbatim copy of assertExpectations() from
// compositor-scrollback.pty.test.ts (no import to avoid coupling).
// ─────────────────────────────────────────────────────────────────────────────
function countAll(lines: string[], needle: string): number {
  return lines.filter((l) => l.includes(needle)).length;
}
function firstIndex(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}
function seamMergedLines(res: PtyRunResult): string[] {
  const sb = res.scrollback;
  const vp = res.viewport;
  const norm = (l: string | undefined): string => (l ?? '').trimEnd();
  for (let k = Math.min(sb.length, vp.length); k > 0; k--) {
    let match = sb.slice(sb.length - k).some((l) => norm(l) !== '');
    for (let j = 0; match && j < k; j++) match = norm(sb[sb.length - k + j]) === norm(vp[j]);
    if (match) return [...sb.slice(0, sb.length - k), ...vp];
  }
  return [...sb, ...vp];
}

function assertExpectations(res: PtyRunResult, exp: PtyExpect): void {
  const dump = res.dump();
  const all = exp.seamOverlap ? seamMergedLines(res) : res.lines;

  expect(res.exitCode, dump).toBe(0);
  expect(res.sawSentinel, `driver did not emit completion sentinel (exit=${res.exitCode}):\n${dump}`).toBe(true);

  for (const needle of exp.inScrollback ?? []) {
    const hit = res.scrollback.some((l) => l.includes(needle));
    expect(hit, `"${needle}" expected in SCROLLBACK (baseY=${res.baseY}):\n${dump}`).toBe(true);
  }
  for (const needle of exp.inViewport ?? []) {
    const hit = res.viewport.some((l) => l.includes(needle));
    expect(hit, `"${needle}" expected in VIEWPORT:\n${dump}`).toBe(true);
  }
  for (const needle of exp.exactlyOnce ?? []) {
    const n = countAll(all, needle);
    expect(n, `"${needle}" must appear exactly once across the whole buffer (found ${n}):\n${dump}`).toBe(1);
  }
  for (const needle of exp.absent ?? []) {
    const n = countAll(all, needle);
    expect(n, `"${needle}" must NOT appear anywhere (found ${n}):\n${dump}`).toBe(0);
  }
  for (const [a, b] of exp.order ?? []) {
    const ia = firstIndex(all, a);
    const ib = firstIndex(all, b);
    expect(ia, `order anchor "${a}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(ib, `order anchor "${b}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    expect(ia, `"${a}" must appear above "${b}" (idx ${ia} vs ${ib}):\n${dump}`).toBeLessThan(ib);
  }
  if (exp.maxViewportBlankRun !== undefined) {
    const anchors = exp.contentAnchors ?? [...(exp.inViewport ?? []), ...(exp.exactlyOnce ?? [])];
    const firstContent = res.viewport.findIndex((l) => l.trim() !== '');
    let lastAnchor = -1;
    for (let i = res.viewport.length - 1; i >= 0; i--) {
      if (anchors.some((a) => (res.viewport[i] ?? '').includes(a))) { lastAnchor = i; break; }
    }
    if (firstContent >= 0 && lastAnchor > firstContent) {
      const run = maxBlankRun(res.viewport, firstContent, lastAnchor);
      expect(
        run,
        `blank void of ${run} rows between committed content and frame (limit ${exp.maxViewportBlankRun}):\n${dump}`,
      ).toBeLessThanOrEqual(exp.maxViewportBlankRun);
    }
  }
  if (exp.logicalSpan) {
    const { from, to, minNonWrappedRows, maxNonWrappedRows, minSpanRows } = exp.logicalSpan;
    const fromIdx = firstIndex(res.lines, from);
    expect(fromIdx, `logicalSpan.from "${from}" not found:\n${dump}`).toBeGreaterThanOrEqual(0);
    const toIdx = res.lines.findIndex((l, i) => i >= fromIdx && l.includes(to));
    expect(toIdx, `logicalSpan.to "${to}" not found at/after "${from}":\n${dump}`).toBeGreaterThanOrEqual(fromIdx);
    const spanRows = toIdx - fromIdx + 1;
    if (minSpanRows !== undefined) {
      expect(spanRows, `span ["${from}".."${to}"] must be >=${minSpanRows} rows:\n${dump}`).toBeGreaterThanOrEqual(minSpanRows);
    }
    let nonWrapped = 0;
    for (let i = fromIdx; i <= toIdx; i++) if (!(res.wrapped[i] ?? false)) nonWrapped += 1;
    if (minNonWrappedRows !== undefined) {
      expect(nonWrapped, `span must have >=${minNonWrappedRows} non-wrapped rows:\n${dump}`).toBeGreaterThanOrEqual(minNonWrappedRows);
    }
    if (maxNonWrappedRows !== undefined) {
      expect(nonWrapped, `span must have <=${maxNonWrappedRows} non-wrapped rows:\n${dump}`).toBeLessThanOrEqual(maxNonWrappedRows);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────
describe('Skill identity raw pipe acceptance', () => {
  it('uses actual non-TTY detection and emits plain bytes without ANSI', async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', SKILL_DRIVER_PATH, 'skill-identity-piped'],
      { cwd: REPO_ROOT, timeout: 20_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    expect(stderr).toBe('');
    expect(stdout).not.toContain('\x1b');
    expect(stdout.match(/PIPE_PURPOSE_DIAGNOSE/g)).toHaveLength(1);
    expect(stdout).toContain('args: auth module');
    expect(stdout).toContain('PIPE_CONTENT');
    expect(stdout.indexOf('PIPE_PURPOSE_DIAGNOSE')).toBeLessThan(stdout.indexOf('PIPE_CONTENT'));
  }, 30_000);
});

describe('Skill identity real-PTY acceptance (skill-dispatch-preview-ui)', () => {
  if (!avail.ok) {
    if (mustRun) {
      it('node-pty must be installed and functional in CI', () => {
        throw new Error(
          `node-pty is unavailable but required (CI or AFK_PTY_REQUIRED=1): ${(avail as { reason: string }).reason}. ` +
            'Ensure "node-pty" is in pnpm-workspace.yaml allowBuilds and the native build succeeded.',
        );
      });
    } else {
      it.skip(`node-pty unavailable locally — skipping skill-identity pty suite (${(avail as { reason: string }).reason})`, () => {});
    }
    return;
  }

  // Every scenario runs in both placement modes: legacy bottom-pinned and content-hug.
  for (const contentHug of [false, true]) {
    for (const [name, scenario] of Object.entries(SKILL_IDENTITY_SCENARIOS)) {
      it(
        `${contentHug ? '[content-hug] ' : ''}${name}: ${scenario.description}`,
        async () => {
          const res = await runSkillIdentityScenario({
            name,
            cols: scenario.cols,
            rows: scenario.rows,
            contentHug,
          });
          assertExpectations(res, contentHug ? (scenario.hugExpect ?? scenario.expect) : scenario.expect);
        },
        45_000,
      );
    }
  }
});
