import { describe, it, expect } from 'vitest';
import { ShellPassthrough, parseShellTrigger } from './shell-passthrough.js';

function harness(): {
  pt: ShellPassthrough;
  lines: string[];
} {
  const lines: string[] = [];
  const pt = new ShellPassthrough({
    writeLine: (text) => lines.push(text),
    getCwd: () => undefined,
  });
  return { pt, lines };
}

/** Strip ANSI escapes for readable assertions on dimmed/colored output. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(s: string): string {
  return s.replace(ANSI, '');
}

describe('parseShellTrigger', () => {
  it('returns null for non-! input', () => {
    expect(parseShellTrigger('hello')).toBeNull();
    expect(parseShellTrigger('/help')).toBeNull();
    expect(parseShellTrigger('')).toBeNull();
  });

  it('parses foreground !cmd', () => {
    expect(parseShellTrigger('!ls')).toEqual({ mode: 'foreground', command: 'ls' });
    expect(parseShellTrigger('! ls -la')).toEqual({ mode: 'foreground', command: 'ls -la' });
  });

  it('parses background !&cmd', () => {
    expect(parseShellTrigger('!&pnpm test')).toEqual({ mode: 'background', command: 'pnpm test' });
    expect(parseShellTrigger('!& sleep 10')).toEqual({ mode: 'background', command: 'sleep 10' });
  });

  it('returns null for empty body', () => {
    expect(parseShellTrigger('!')).toBeNull();
    expect(parseShellTrigger('!&')).toBeNull();
    expect(parseShellTrigger('!   ')).toBeNull();
    expect(parseShellTrigger('!&   ')).toBeNull();
  });

  it('treats !& as background prefix, NOT foreground "&cmd"', () => {
    // Regression: without the !&-first check this would return
    // { foreground, command: '&pnpm test' }, which the shell would
    // then refuse to run.
    const got = parseShellTrigger('!&pnpm test');
    expect(got?.mode).toBe('background');
  });

  it('preserves embedded && in commands', () => {
    // The trigger is the LEADING `!` only — `a && b` is shell syntax that
    // belongs in the command, not a structural marker for our parser.
    expect(parseShellTrigger('!a && b')).toEqual({
      mode: 'foreground',
      command: 'a && b',
    });
  });
});

describe('ShellPassthrough.dispatch', () => {
  it('returns false for non-! input', async () => {
    const { pt } = harness();
    expect(await pt.dispatch('hello')).toBe(false);
    expect(await pt.dispatch('/help')).toBe(false);
  });

  it('runs a foreground command and writes streamed output', async () => {
    const { pt, lines } = harness();
    const handled = await pt.dispatch('!echo hello-from-pt');
    expect(handled).toBe(true);
    const clean_lines = lines.map(clean);
    expect(clean_lines.some((l) => l.includes('$ echo hello-from-pt'))).toBe(true);
    expect(clean_lines.some((l) => l.includes('hello-from-pt'))).toBe(true);
    expect(clean_lines.some((l) => l.includes('exit 0'))).toBe(true);
  });

  it('queues a model-injection block for a successful FG run', async () => {
    const { pt } = harness();
    await pt.dispatch('!echo injected');
    const injection = pt.drainInjections();
    expect(injection).toContain('<bash-passthrough');
    expect(injection).toContain('mode="foreground"');
    expect(injection).toContain('exit="0"');
    expect(injection).toContain('<command>echo injected</command>');
    expect(injection).toContain('injected');
  });

  it('a foreground run injects EXACTLY ONE block (no double-inject via complete event, N1)', async () => {
    // FG completion is handled inline in runForeground; the registry's
    // `complete` listener early-returns for mode!=='background'. A regression
    // wiring FG into both paths would surface two envelopes here.
    const { pt } = harness();
    await pt.dispatch('!echo once');
    const injection = pt.drainInjections();
    const openTags = (injection.match(/<bash-passthrough\b/g) ?? []).length;
    expect(openTags).toBe(1);
  });

  it('escapes XML-closing tags in command output (C-2 regression)', async () => {
    const { pt } = harness();
    // printf outputs the literal string </output></bash-passthrough>.
    // Without escaping this would close our envelope prematurely.
    await pt.dispatch('!printf "</output></bash-passthrough>"');
    const injection = pt.drainInjections();
    // The raw </output> from user output must not appear as a literal tag.
    // Count occurrences of </output>: must be exactly 1 (the envelope's own tag).
    const rawCloses = (injection.match(/<\/output>/g) ?? []).length;
    expect(rawCloses).toBe(1);
    // The user content must be HTML-escaped.
    expect(injection).toContain('&lt;/output&gt;');
    expect(injection).toContain('&lt;/bash-passthrough&gt;');
    // The outer envelope must still be intact.
    expect(injection).toContain('</bash-passthrough>');
  });

  it('emits nonzero-exit footer + reason for failed FG run', async () => {
    const { pt, lines } = harness();
    await pt.dispatch('!exit 9');
    const clean_lines = lines.map(clean);
    expect(clean_lines.some((l) => l.includes('exit 9'))).toBe(true);
    const inj = pt.drainInjections();
    expect(inj).toContain('reason="nonzero-exit"');
    expect(inj).toContain('exit="9"');
  });

  it('drainInjections returns "" when nothing is queued', () => {
    const { pt } = harness();
    expect(pt.drainInjections()).toBe('');
  });

  it('drainInjections returns and clears the buffer', async () => {
    const { pt } = harness();
    await pt.dispatch('!echo a');
    expect(pt.drainInjections()).toContain('echo a');
    // Second drain is empty.
    expect(pt.drainInjections()).toBe('');
  });

  it('starts a background command immediately and returns control', async () => {
    const { pt, lines } = harness();
    const started = Date.now();
    await pt.dispatch('!&sleep 2');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(lines.map(clean).some((l) => l.includes('background:'))).toBe(true);

    // Cleanup — kill the still-running bg job so vitest doesn't wait.
    pt.drainOnExit();
  });

  it('reports an active FG job via hasActiveForeground while running', async () => {
    const { pt } = harness();
    expect(pt.hasActiveForeground()).toBe(false);
    const promise = pt.dispatch('!sleep 0.2');
    // Yield a microtask so the dispatch can spawn and set activeFgJobId.
    await new Promise((r) => setTimeout(r, 30));
    expect(pt.hasActiveForeground()).toBe(true);
    await promise;
    expect(pt.hasActiveForeground()).toBe(false);
  });

  it('abortActiveForeground kills an in-flight FG and returns true', async () => {
    const { pt, lines } = harness();
    const promise = pt.dispatch('!sleep 5');
    await new Promise((r) => setTimeout(r, 30));
    expect(pt.abortActiveForeground()).toBe(true);
    await promise;
    const inj = pt.drainInjections();
    expect(inj).toContain('reason="abort"');
    expect(lines.map(clean).some((l) => l.includes('killed'))).toBe(true);
  });

  it('abortActiveForeground returns false when no FG is running', () => {
    const { pt } = harness();
    expect(pt.abortActiveForeground()).toBe(false);
  });

  it('queues bg completion notifications on registry complete', async () => {
    const { pt } = harness();
    // Listen on the registry directly so we wait for the underlying
    // event rather than racing setTimeout against spawn close.
    const completed = new Promise<void>((resolve) => {
      pt.registry.once('complete', () => resolve());
    });
    await pt.dispatch('!&echo bg-done');
    await completed;
    // One more microtask so the passthrough's internal listener (also
    // attached on the same emit) has run.
    await new Promise((r) => setImmediate(r));
    const notifications = pt.drainNotifications();
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.result.exitCode).toBe(0);
    // Injection also queued.
    const inj = pt.drainInjections();
    expect(inj).toContain('mode="background"');
    expect(inj).toContain('bg-done');
  });

  it('shows a usage hint for bare ! or !&', async () => {
    const { pt, lines } = harness();
    expect(await pt.dispatch('!')).toBe(true);
    expect(await pt.dispatch('!&')).toBe(true);
    const cleanLines = lines.map(clean);
    expect(cleanLines.some((l) => l.includes('usage:'))).toBe(true);
  });
});

describe('ShellPassthrough.drainOnExit', () => {
  it('kills running bg jobs and surfaces a notice', async () => {
    const { pt, lines } = harness();
    await pt.dispatch('!&sleep 5');
    pt.drainOnExit();
    expect(lines.map(clean).some((l) => l.includes('Killing 1 background shell job on exit'))).toBe(true);
  });

  it('is silent when no jobs are running', () => {
    const { pt, lines } = harness();
    pt.drainOnExit();
    expect(lines).toHaveLength(0);
  });
});
