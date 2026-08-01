import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Import after AFK_HOME is set so path helpers resolve into the temp dir.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-prompt-capture-home-'));
process.env['AFK_HOME'] = tmpHome;

const { getPromptsDir } = await import('../../paths.js');
const {
  MAX_CAPTURED_PROMPT_BYTES,
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
    expect(files[0]).toMatch(/^.+-research-agent-1-t1\.md$/);
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
    expect(files.some((f) => f.endsWith('-t1.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('-t2.md'))).toBe(true);
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
});
