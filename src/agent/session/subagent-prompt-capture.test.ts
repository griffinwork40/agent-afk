import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import after AFK_HOME is set so path helpers resolve into the temp dir.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-prompt-capture-home-'));
process.env['AFK_HOME'] = tmpHome;

const { getPromptsDir } = await import('../../paths.js');
const {
  MAX_CAPTURED_PROMPT_BYTES,
  PROMPT_CAPTURE_BANNER,
  buildPromptDocument,
  captureSubagentPrompt,
  shouldCaptureSubagentPrompt,
  truncateToBytes,
} = await import('./subagent-prompt-capture.js');

const SESSION = 'test-session-1';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    subagentId: 'research-agent-1',
    isSubagentFork: true,
    model: 'claude-sonnet-4-6',
    turn: 1,
    prompt: 'investigate the thing',
    ...overrides,
  } as Parameters<typeof shouldCaptureSubagentPrompt>[0];
}

describe('shouldCaptureSubagentPrompt', () => {
  beforeEach(() => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
  });
  afterEach(() => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
  });

  it('is off by default — the flag must be explicitly opted into', () => {
    expect(shouldCaptureSubagentPrompt(baseInput())).toBe(false);
  });

  it('is off for any value other than 1', () => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = 'true';
    expect(shouldCaptureSubagentPrompt(baseInput())).toBe(false);
  });

  it('is on for a fork when the flag is 1', () => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
    expect(shouldCaptureSubagentPrompt(baseInput())).toBe(true);
  });

  it('never captures a top-level (non-fork) session', () => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
    expect(shouldCaptureSubagentPrompt(baseInput({ isSubagentFork: false }))).toBe(false);
  });

  it('declines when identity needed to key the artifact is missing', () => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
    expect(shouldCaptureSubagentPrompt(baseInput({ subagentId: undefined }))).toBe(false);
    expect(shouldCaptureSubagentPrompt(baseInput({ sessionId: undefined }))).toBe(false);
  });

  it('declines an empty prompt', () => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
    expect(shouldCaptureSubagentPrompt(baseInput({ prompt: '' }))).toBe(false);
  });
});

describe('truncateToBytes', () => {
  it('passes short text through untouched', () => {
    const r = truncateToBytes('hello', 100);
    expect(r).toEqual({ text: 'hello', originalBytes: 5, truncated: false });
  });

  it('truncates oversized text and reports the original size', () => {
    const r = truncateToBytes('a'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(10);
    expect(r.originalBytes).toBe(50);
  });

  it('does not emit a broken multi-byte character at the cut', () => {
    // '€' is 3 bytes; cutting at 4 bytes splits the second one.
    const r = truncateToBytes('€€', 4);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('€');
    expect(r.text).not.toContain('\uFFFD');
  });
});

describe('buildPromptDocument', () => {
  it('emits frontmatter with attribution and a verbatim body', () => {
    const input = baseInput({ prompt: 'do the work' });
    const doc = buildPromptDocument(input, {
      text: 'do the work',
      originalBytes: 11,
      truncated: false,
    });
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('subagentId: "research-agent-1"');
    expect(doc).toContain('sessionLabel: "test-session-1"');
    expect(doc).toContain('turn: 1');
    expect(doc).toContain('model: "claude-sonnet-4-6"');
    expect(doc).toContain('truncated: false');
    expect(doc).toContain('redaction: best-effort');
    expect(doc.trimEnd().endsWith('do the work')).toBe(true);
  });

  it('leaves a body containing --- and code fences unescaped', () => {
    const body = 'before\n---\n```ts\nconst x = 1;\n```\nafter';
    const doc = buildPromptDocument(baseInput({ prompt: body }), {
      text: body,
      originalBytes: Buffer.byteLength(body),
      truncated: false,
    });
    // Only the first two --- delimiters bound the frontmatter.
    const parts = doc.split('\n---\n');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(doc).toContain('```ts');
    expect(doc).toContain('const x = 1;');
  });

  it('marks truncation explicitly rather than silently', () => {
    const doc = buildPromptDocument(baseInput(), {
      text: 'kept',
      originalBytes: 99999,
      truncated: true,
    });
    expect(doc).toContain('truncated: true');
    expect(doc).toContain(`TRUNCATED at ${MAX_CAPTURED_PROMPT_BYTES} bytes of 99999`);
    // promptBytes describes the inbound prompt, bodyBytes the retained text.
    expect(doc).toContain('promptBytes: 99999');
    expect(doc).toContain(`bodyBytes: ${Buffer.byteLength('kept', 'utf8')}`);
  });

  it('omits the model line when the model is unknown', () => {
    const doc = buildPromptDocument(baseInput({ model: undefined }), {
      text: 'x',
      originalBytes: 1,
      truncated: false,
    });
    expect(doc).not.toContain('model:');
  });
});

describe('captureSubagentPrompt', () => {
  beforeEach(() => {
    process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'] = '1';
  });
  afterEach(() => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
    fs.rmSync(getPromptsDir(SESSION), { recursive: true, force: true });
  });

  it('writes one markdown file into the session prompts dir', async () => {
    await captureSubagentPrompt(baseInput({ prompt: 'map the module' }));
    const dir = getPromptsDir(SESSION);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    // `-<6 hex>` is the collision nonce appended after the turn marker.
    expect(files[0]).toMatch(/^.+-research-agent-1-t1-[0-9a-f]{6}\.md$/);
    const body = fs.readFileSync(path.join(dir, files[0] as string), 'utf8');
    expect(body).toContain('map the module');
  });

  it('writes with owner-only permissions', async () => {
    await captureSubagentPrompt(baseInput());
    const dir = getPromptsDir(SESSION);
    const file = path.join(dir, fs.readdirSync(dir)[0] as string);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('redacts an inline secret before it reaches disk', async () => {
    const secret = `sk-ant-${'a'.repeat(40)}`;
    await captureSubagentPrompt(baseInput({ prompt: `use ${secret} to auth` }));
    const dir = getPromptsDir(SESSION);
    const body = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0] as string), 'utf8');
    expect(body).not.toContain(secret);
    expect(body).toContain('REDACTED');
  });

  it('keeps multi-turn dispatches as separate files', async () => {
    await captureSubagentPrompt(baseInput({ turn: 1, prompt: 'first' }));
    await captureSubagentPrompt(baseInput({ turn: 2, prompt: 'second' }));
    const files = fs.readdirSync(getPromptsDir(SESSION));
    expect(files).toHaveLength(2);
    expect(files.some((f) => /-t1-[0-9a-f]{6}\.md$/.test(f))).toBe(true);
    expect(files.some((f) => /-t2-[0-9a-f]{6}\.md$/.test(f))).toBe(true);
  });

  it('writes nothing when disabled', async () => {
    delete process.env['AFK_CAPTURE_SUBAGENT_PROMPTS'];
    await captureSubagentPrompt(baseInput());
    expect(fs.existsSync(getPromptsDir(SESSION))).toBe(false);
  });

  it('never rejects on a bad session id — forensics must not fail a turn', async () => {
    await expect(
      captureSubagentPrompt(baseInput({ sessionId: '../escape' })),
    ).resolves.toBeUndefined();
  });

  it('creates the prompts dir owner-only — filenames leak subagent ids', async () => {
    await captureSubagentPrompt(baseInput());
    expect(fs.statSync(getPromptsDir(SESSION)).mode & 0o777).toBe(0o700);
  });

  it('keeps same-millisecond captures of the same id and turn as distinct files', async () => {
    // Freeze the clock so both writes derive an IDENTICAL timestamp stamp: only
    // the nonce can separate them. Without it the second write is lost.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      await captureSubagentPrompt(baseInput({ turn: 3, prompt: 'sibling fork A' }));
      await captureSubagentPrompt(baseInput({ turn: 3, prompt: 'sibling fork B' }));
    } finally {
      vi.useRealTimers();
    }
    const dir = getPromptsDir(SESSION);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    const bodies = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(bodies.some((b) => b.includes('sibling fork A'))).toBe(true);
    expect(bodies.some((b) => b.includes('sibling fork B'))).toBe(true);
  });

  it('leaves no partial key material when a secret straddles the byte cut', async () => {
    // Position `SOME_TOKEN=` so exactly 8 chars of its value survive the cut —
    // below the redactor's `([^\s]{16,})` minimum, so redaction alone misses it.
    const value = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
    const survivingValueChars = 8;
    const assign = 'SOME_TOKEN=';
    const padding = `${'a'.repeat(
      MAX_CAPTURED_PROMPT_BYTES - assign.length - survivingValueChars - 1,
    )} `;
    const prompt = `${padding}${assign}${value} trailing text`;
    expect(Buffer.byteLength(`${padding}${assign}${value.slice(0, survivingValueChars)}`)).toBe(
      MAX_CAPTURED_PROMPT_BYTES,
    );

    await captureSubagentPrompt(baseInput({ prompt }));
    const dir = getPromptsDir(SESSION);
    const body = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0] as string), 'utf8');
    expect(body).toContain('truncated: true');
    // No prefix of the value — however short — may reach disk.
    expect(body).not.toContain(value.slice(0, 4));
    expect(body).not.toContain(assign);
  });

  it('reports promptBytes (inbound) and bodyBytes (written) separately', async () => {
    const prompt = 'z'.repeat(MAX_CAPTURED_PROMPT_BYTES * 2);
    await captureSubagentPrompt(baseInput({ prompt }));
    const dir = getPromptsDir(SESSION);
    const body = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0] as string), 'utf8');
    const promptBytes = Number(/^promptBytes: (\d+)$/m.exec(body)?.[1]);
    const bodyBytes = Number(/^bodyBytes: (\d+)$/m.exec(body)?.[1]);
    expect(promptBytes).toBe(MAX_CAPTURED_PROMPT_BYTES * 2);
    expect(bodyBytes).toBeLessThan(promptBytes);
    // bodyBytes must describe the text actually on disk, not the budget.
    const written = body.slice(body.indexOf(PROMPT_CAPTURE_BANNER) + PROMPT_CAPTURE_BANNER.length);
    expect(written).toContain('z'.repeat(bodyBytes));
  });
});
