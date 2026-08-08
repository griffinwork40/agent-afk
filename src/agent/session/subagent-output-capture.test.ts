import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Import after AFK_HOME is set so path helpers resolve into the temp dir.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-output-capture-home-'));
process.env['AFK_HOME'] = tmpHome;

const { getSubagentOutputsDir } = await import('../../paths.js');
const {
  MAX_RECORD_BYTES,
  OUTPUT_CAPTURE_BANNER,
  buildRecord,
  createSubagentOutputRecorder,
  sanitizeRecordText,
  shouldCaptureSubagentOutput,
} = await import('./subagent-output-capture.js');

type Recorder = NonNullable<ReturnType<typeof createSubagentOutputRecorder>>;

const SESSION = 'output-session-1';
const FLAG = 'AFK_CAPTURE_SUBAGENT_OUTPUT';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    subagentId: 'forge-qualify-1',
    isSubagentFork: true,
    model: 'claude-sonnet-5',
    ...overrides,
  } as Parameters<typeof shouldCaptureSubagentOutput>[0];
}

/** Give the recorder's internal write chain a turn to drain. */
async function drain(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

function contentEvent(text: string) {
  return { type: 'chunk', chunk: { type: 'content', content: text } } as Parameters<
    Recorder['observe']
  >[0];
}

function toolEvent(toolName: string, toolInput: string) {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName, toolInput },
  } as Parameters<Recorder['observe']>[0];
}

describe('shouldCaptureSubagentOutput', () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('is off by default — the flag must be explicitly opted into', () => {
    expect(shouldCaptureSubagentOutput(baseInput())).toBe(false);
  });

  it('is on when the flag is exactly "1"', () => {
    process.env[FLAG] = '1';
    expect(shouldCaptureSubagentOutput(baseInput())).toBe(true);
  });

  it('does not capture a non-fork (top-level) session', () => {
    process.env[FLAG] = '1';
    expect(shouldCaptureSubagentOutput(baseInput({ isSubagentFork: false }))).toBe(false);
  });

  it('does not capture without both a sessionId and a subagentId', () => {
    process.env[FLAG] = '1';
    expect(shouldCaptureSubagentOutput(baseInput({ sessionId: undefined }))).toBe(false);
    expect(shouldCaptureSubagentOutput(baseInput({ subagentId: undefined }))).toBe(false);
  });
});

describe('sanitizeRecordText', () => {
  it('truncates an oversized record and says so', () => {
    const out = sanitizeRecordText('x'.repeat(MAX_RECORD_BYTES * 2));
    expect(out).toContain('TRUNCATED at');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_RECORD_BYTES + 200);
  });

  it('leaves a small record untouched', () => {
    expect(sanitizeRecordText('ls -la')).toBe('ls -la');
  });
});

describe('buildRecord', () => {
  it('renders tool arguments in a fenced block — the args the trace omits', () => {
    const rec = buildRecord('tool', { toolName: 'bash', toolInput: 'grep -r foo /tmp' });
    expect(rec).toContain('### tool · bash');
    expect(rec).toContain('grep -r foo /tmp');
    expect(rec).toContain('```');
  });

  it('notes when a tool call carried no recorded arguments', () => {
    expect(buildRecord('tool', { toolName: 'bash' })).toContain('(no arguments recorded)');
  });

  it('renders a terminal record with its reason', () => {
    expect(buildRecord('end', { reason: 'aborted_or_incomplete' })).toContain(
      'aborted_or_incomplete',
    );
  });
});

describe('createSubagentOutputRecorder', () => {
  beforeEach(() => {
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('returns null when capture is disabled, so callers pay nothing', () => {
    delete process.env[FLAG];
    expect(createSubagentOutputRecorder(baseInput())).toBeNull();
  });

  it('writes assistant prose and the tool call that followed it, in causal order', async () => {
    const rec = createSubagentOutputRecorder(baseInput({ subagentId: 'order-1' }));
    expect(rec).not.toBeNull();
    rec?.observe(contentEvent('I will list the directory.'));
    rec?.observe(toolEvent('bash', 'ls -la /tmp'));
    await drain();

    const file = path.join(getSubagentOutputsDir(SESSION), 'order-1.md');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain(OUTPUT_CAPTURE_BANNER);
    expect(body).toContain('I will list the directory.');
    expect(body).toContain('ls -la /tmp');
    // Prose must precede the call it justified.
    expect(body.indexOf('I will list')).toBeLessThan(body.indexOf('ls -la'));
  });

  /**
   * The regression this whole module exists to prevent: a child that makes tool
   * calls and is then killed before producing any final message must still
   * leave a usable record. Aggregate/end-of-run capture yields nothing here.
   */
  it('leaves a usable partial transcript when the child never completes', async () => {
    const rec = createSubagentOutputRecorder(baseInput({ subagentId: 'timeout-1' }));
    rec?.observe(contentEvent('Checking the corpus.'));
    rec?.observe(toolEvent('bash', 'find / -name SKILL.md'));
    rec?.observe(toolEvent('bash', 'wc -c huge.json'));
    // No 'done' event ever arrives — the child is aborted.
    rec?.end('aborted_or_incomplete');
    await drain();

    const body = fs.readFileSync(
      path.join(getSubagentOutputsDir(SESSION), 'timeout-1.md'),
      'utf8',
    );
    expect(body).toContain('find / -name SKILL.md');
    expect(body).toContain('wc -c huge.json');
    expect(body).toContain('aborted_or_incomplete');
  });

  it('writes the frontmatter header exactly once across many records', async () => {
    const rec = createSubagentOutputRecorder(baseInput({ subagentId: 'header-1' }));
    rec?.observe(toolEvent('bash', 'echo a'));
    rec?.observe(toolEvent('bash', 'echo b'));
    rec?.observe(toolEvent('bash', 'echo c'));
    await drain();

    const body = fs.readFileSync(path.join(getSubagentOutputsDir(SESSION), 'header-1.md'), 'utf8');
    expect(body.match(/^---$/gm)?.length).toBe(2);
    expect(body.match(/subagentId:/g)?.length).toBe(1);
  });

  it('prefers toolInputRaw when present — exact args beat the display form', async () => {
    const rec = createSubagentOutputRecorder(baseInput({ subagentId: 'raw-1' }));
    rec?.observe({
      type: 'chunk',
      chunk: {
        type: 'tool_use_detail',
        toolUseId: 't9',
        toolName: 'bash',
        toolInput: 'truncated dis…',
        toolInputRaw: '{"command":"exact --value"}',
      },
    } as Parameters<Recorder['observe']>[0]);
    await drain();

    const body = fs.readFileSync(path.join(getSubagentOutputsDir(SESSION), 'raw-1.md'), 'utf8');
    expect(body).toContain('exact --value');
  });

  it('never throws on a malformed event', () => {
    const rec = createSubagentOutputRecorder(baseInput({ subagentId: 'safe-1' }));
    expect(() =>
      rec?.observe({ type: 'chunk', chunk: undefined } as unknown as Parameters<
        Recorder['observe']
      >[0]),
    ).not.toThrow();
  });
});
