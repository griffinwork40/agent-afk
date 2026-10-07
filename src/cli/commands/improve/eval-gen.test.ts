/**
 * Tests for `src/cli/commands/improve/eval-gen.ts`.
 *
 * Strategy: this module is a Commander command-group wiring file whose action
 * handlers call process.exit(). Rather than driving Commander end-to-end
 * (which couples to process.exit and argv parsing), we:
 *
 *   1. Test the pure exported functions directly (findEvalCaseForEvidenceRow).
 *   2. Test registerEvalGenSubcommand / registerEvalCasesSubcommand by
 *      constructing a parent Command, invoking parseAsync, and mocking every
 *      side-effecting import so no real filesystem, trace, or exit is needed.
 *      process.exit is intercepted to prevent the test process from dying.
 *
 * All I/O dependencies (getCard, getProposal, buildEvalCase, writeEvalCase,
 * listEvalCases, getEvalCase, getEvalCasesForCard, renderEvalCaseMarkdown,
 * generateEvalCaseId, EvalGenError, handleCommandError) are mocked via
 * vi.mock so tests are hermetic.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any SUT import.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Untyped mock stubs — types flow from mockReturnValue / mockImplementation
  // call sites in beforeEach, not from construction-time inference. This
  // avoids the `never[]` inference trap that `vi.fn(() => [])` causes when
  // the factory receives no explicit return type and TypeScript infers `[]`
  // as `never[]`.
  const getCard = vi.fn();
  const getProposal = vi.fn();
  const buildEvalCase = vi.fn();
  const generateEvalCaseId = vi.fn();
  const getEvalCase = vi.fn();
  const getEvalCasesForCard = vi.fn();
  const listEvalCases = vi.fn();
  const renderEvalCaseMarkdown = vi.fn();
  const writeEvalCase = vi.fn();
  const handleCommandError = vi.fn();
  class EvalGenError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    getCard, getProposal, buildEvalCase, generateEvalCaseId, getEvalCase,
    getEvalCasesForCard, listEvalCases, renderEvalCaseMarkdown, writeEvalCase,
    handleCommandError, EvalGenError,
  };
});

vi.mock('../../../improve/scan/card-writer.js', () => ({
  getCard: mocks.getCard,
}));
vi.mock('../../../improve/propose/writer.js', () => ({
  getProposal: mocks.getProposal,
}));
vi.mock('../../../improve/eval-gen/replay-fixture.js', () => ({
  EvalGenError: mocks.EvalGenError,
}));
vi.mock('../../../improve/eval-gen/writer.js', () => ({
  buildEvalCase: mocks.buildEvalCase,
  generateEvalCaseId: mocks.generateEvalCaseId,
  getEvalCase: mocks.getEvalCase,
  getEvalCasesForCard: mocks.getEvalCasesForCard,
  listEvalCases: mocks.listEvalCases,
  renderEvalCaseMarkdown: mocks.renderEvalCaseMarkdown,
  writeEvalCase: mocks.writeEvalCase,
}));
vi.mock('../../errors/index.js', () => ({
  handleCommandError: mocks.handleCommandError,
}));

// SUT imported after mocks are in place.
import {
  findEvalCaseForEvidenceRow,
  registerEvalGenSubcommand,
  registerEvalCasesSubcommand,
} from './eval-gen.js';
import type { EvalCase, EvalCaseStatus, FailurePattern } from '../../../improve/schemas.js';

// ---------------------------------------------------------------------------
// Test fixture factories
// ---------------------------------------------------------------------------

/** Minimal EvalCaseListEntry fixture (all required fields present). */
function makeListEntry(overrides: Partial<{
  evalCaseId: string;
  cardSlug: string;
  patternId: FailurePattern;
  status: EvalCaseStatus;
  createdAt: string;
  proposalId: string | null;
  title: string;
  kind: 'replay';
  sliceSha256: string;
}> = {}) {
  return {
    evalCaseId: 'default-eval-id',
    cardSlug: 'default-card',
    proposalId: null,
    title: 'Default Title',
    kind: 'replay' as const,
    status: 'draft' as EvalCaseStatus,
    patternId: 'repeated-tool-use' as FailurePattern,
    createdAt: '2026-01-01T00:00:00.000Z',
    sliceSha256: 'aabbccddeeff0011',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// process.exit interception
// ---------------------------------------------------------------------------

const processExitMock = vi.fn();
let savedExit: typeof process.exit;

beforeEach(() => {
  savedExit = process.exit;
  process.exit = processExitMock as unknown as typeof process.exit;

  // Reset all mocks to their defaults.
  processExitMock.mockReset();
  mocks.getCard.mockReset();
  mocks.getProposal.mockReset();
  mocks.buildEvalCase.mockReset();
  mocks.generateEvalCaseId.mockReturnValue('test-card-eval-20260101-aabbcc');
  mocks.getEvalCase.mockReset();
  mocks.getEvalCasesForCard.mockReturnValue([]);
  mocks.listEvalCases.mockReturnValue([]);
  mocks.renderEvalCaseMarkdown.mockReturnValue('## Eval Case\n\nsome markdown');
  mocks.writeEvalCase.mockReset();
  mocks.handleCommandError.mockReset();

  // Silence console output during tests.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.exit = savedExit;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure function: findEvalCaseForEvidenceRow
// ---------------------------------------------------------------------------

function makeEvalCase(evalCaseId: string, evidenceRowIndex: number): EvalCase {
  return { evalCaseId, replay: { evidenceRowIndex } } as EvalCase;
}

describe('findEvalCaseForEvidenceRow', () => {
  it('returns undefined when existing array is empty', () => {
    expect(findEvalCaseForEvidenceRow([], 0)).toBeUndefined();
  });

  it('finds a matching eval-case by evidenceRowIndex', () => {
    const cases = [makeEvalCase('ec-0', 0), makeEvalCase('ec-2', 2)];
    expect(findEvalCaseForEvidenceRow(cases, 0)?.evalCaseId).toBe('ec-0');
    expect(findEvalCaseForEvidenceRow(cases, 2)?.evalCaseId).toBe('ec-2');
  });

  it('returns undefined when no case matches the given row', () => {
    const cases = [makeEvalCase('ec-0', 0), makeEvalCase('ec-2', 2)];
    expect(findEvalCaseForEvidenceRow(cases, 1)).toBeUndefined();
  });

  it('returns the first match when multiple cases share the same evidenceRowIndex', () => {
    const cases = [makeEvalCase('first', 0), makeEvalCase('second', 0)];
    expect(findEvalCaseForEvidenceRow(cases, 0)?.evalCaseId).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// Helpers: commander program factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh Commander program with the eval-gen / eval-cases subcommands
 * registered under an `improve` parent — mirrors the actual CLI structure.
 * exitOverride() prevents Commander from calling process.exit on parse errors.
 */
function buildProgram(): Command {
  const program = new Command().exitOverride();
  const improve = program.command('improve').exitOverride();
  registerEvalGenSubcommand(improve);
  registerEvalCasesSubcommand(improve);
  return program;
}

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — card not found
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — card not found', () => {
  it('exits 1 and prints an error when card slug is unknown', async () => {
    mocks.getCard.mockReturnValue(undefined);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-gen', 'unknown-slug']);
    expect(processExitMock).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — proposal validation
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — proposal validation', () => {
  function makeCard(slug: string, evidenceCount = 1) {
    return {
      slug,
      evidence: Array.from({ length: evidenceCount }, (_, i) => ({
        sessionId: `sess-${i}`,
        tracePath: `/traces/${i}.jsonl`,
        eventIndices: [i],
        excerpt: `excerpt ${i}`,
        detectedAt: '2026-01-01T00:00:00.000Z',
      })),
    };
  }

  it('exits 1 when --proposal id does not exist', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    mocks.getProposal.mockReturnValue(undefined);
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--proposal', 'nonexistent',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it('exits 2 when --proposal targets a different card', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    mocks.getProposal.mockReturnValue({ proposalId: 'p1', cardSlug: 'other-card' });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--proposal', 'p1',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — evidence-row validation
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — evidence-row validation', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('exits 2 when --evidence-row is not a non-negative integer', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--evidence-row', 'notanumber',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });

  it('exits 2 when --evidence-row is negative', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--evidence-row', '-1',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });

  it('uses the provided --evidence-row index (valid positive integer)', async () => {
    // Card with 2 evidence rows; pick row 1.
    const card = {
      slug: 'my-card',
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex0', detectedAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 's1', tracePath: '/t/1.jsonl', eventIndices: [1], excerpt: 'ex1', detectedAt: '2026-01-02T00:00:00.000Z' },
      ],
    };
    mocks.getCard.mockReturnValue(card);
    const fakeEvalCase = {
      ...makeEvalCase('my-card-eval-row1', 1),
      proposalId: null,
      assertion: { patternId: 'repeated-tool-use' },
      replay: {
        evidenceRowIndex: 1,
        sliceLineRange: { startLine: 1, endLine: 5 },
        sliceLineCount: 5,
        sliceSha256: 'aa112233445566',
      },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('row-1-fixture'),
    });
    mocks.writeEvalCase.mockReturnValue({
      evalCaseId: 'my-card-eval-row1',
      jsonPath: '/p/eval.json',
      fixturePath: '/p/eval.fixture.jsonl',
      markdownPath: '/p/eval.md',
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--evidence-row', '1',
    ]);
    expect(processExitMock).not.toHaveBeenCalled();
    // buildEvalCase must have been called with the evidenceRowIndex = 1.
    expect(mocks.buildEvalCase).toHaveBeenCalledWith(
      card,
      expect.objectContaining({ evidenceRowIndex: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — duplicate detection
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — duplicate detection', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('exits 1 when a case for this evidence row already exists (no --force)', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    mocks.getEvalCasesForCard.mockReturnValue([
      makeEvalCase('my-card-eval-20260101-aabbcc', 0),
    ]);
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already has an eval-case'));
  });

  it('proceeds past duplicate check when --force is given', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    mocks.getEvalCasesForCard.mockReturnValue([
      makeEvalCase('existing-eval', 0),
    ]);
    mocks.buildEvalCase.mockReturnValue({
      evalCase: makeEvalCase('new-eval', 0),
      sliceBytes: Buffer.from('fixture'),
    });
    mocks.writeEvalCase.mockReturnValue({
      evalCaseId: 'new-eval',
      jsonPath: '/path/new-eval.json',
      fixturePath: '/path/new-eval.fixture.jsonl',
      markdownPath: '/path/new-eval.md',
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--force',
    ]);
    expect(processExitMock).not.toHaveBeenCalled();
    expect(mocks.writeEvalCase).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — preview mode (--no-write)
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — preview mode', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('renders eval-case to stdout without writing to disk', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    const fakeEvalCase = {
      ...makeEvalCase('ec-preview', 0),
      proposalId: null,
      replay: { evidenceRowIndex: 0, sliceLineCount: 42, sliceSha256: 'aabbcc' },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('a'.repeat(100)),
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--no-write',
    ]);
    expect(mocks.writeEvalCase).not.toHaveBeenCalled();
    expect(processExitMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('preview'));
  });

  it('emits JSON to stdout in preview mode with --json flag', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    const fakeEvalCase = {
      ...makeEvalCase('ec-preview-json', 0),
      proposalId: null,
      replay: { evidenceRowIndex: 0, sliceLineCount: 5, sliceSha256: 'deadbeef' },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('fixture bytes'),
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--no-write', '--json',
    ]);
    expect(mocks.writeEvalCase).not.toHaveBeenCalled();
    expect(processExitMock).not.toHaveBeenCalled();
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('{'));
    expect(jsonOutput).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — persist path
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — persist', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('writes the eval-case and prints the artifact paths', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    const fakeEvalCase = {
      ...makeEvalCase('my-card-eval-20260101-aabbcc', 0),
      proposalId: null,
      assertion: { patternId: 'repeated-tool-use' },
      replay: {
        evidenceRowIndex: 0,
        sliceLineRange: { startLine: 1, endLine: 50 },
        sliceLineCount: 50,
        sliceSha256: 'deadbeef012345',
      },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('fixture'),
    });
    mocks.writeEvalCase.mockReturnValue({
      evalCaseId: 'my-card-eval-20260101-aabbcc',
      jsonPath: '/path/eval.json',
      fixturePath: '/path/eval.fixture.jsonl',
      markdownPath: '/path/eval.md',
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card',
    ]);
    expect(mocks.writeEvalCase).toHaveBeenCalled();
    expect(processExitMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Wrote eval-case'));
  });

  it('emits JSON output with --json flag', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    const fakeEvalCase = {
      ...makeEvalCase('my-card-eval-20260101-json', 0),
      proposalId: null,
      assertion: { patternId: 'repeated-tool-use' },
      replay: {
        evidenceRowIndex: 0,
        sliceLineRange: { startLine: 1, endLine: 10 },
        sliceLineCount: 10,
        sliceSha256: 'cafecafe',
      },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('json-fixture'),
    });
    const writeResult = {
      evalCaseId: 'my-card-eval-20260101-json',
      jsonPath: '/p/eval.json',
      fixturePath: '/p/eval.fixture.jsonl',
      markdownPath: '/p/eval.md',
    };
    mocks.writeEvalCase.mockReturnValue(writeResult);
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--json',
    ]);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    if (jsonOutput) {
      const parsed = JSON.parse(jsonOutput) as { evalCaseId?: string; _paths?: object };
      expect(parsed.evalCaseId).toBe('my-card-eval-20260101-json');
      expect(parsed._paths).toBeDefined();
    }
  });

  it('prints proposalId back-reference note when proposalId is set', async () => {
    const card = makeCard('my-card');
    mocks.getCard.mockReturnValue(card);
    mocks.getProposal.mockReturnValue({ proposalId: 'p-abc', cardSlug: 'my-card' });
    const fakeEvalCase = {
      ...makeEvalCase('my-card-eval-20260101-prop', 0),
      proposalId: 'p-abc',
      assertion: { patternId: 'repeated-tool-use' },
      replay: {
        evidenceRowIndex: 0,
        sliceLineRange: { startLine: 1, endLine: 20 },
        sliceLineCount: 20,
        sliceSha256: 'beefdead012345',
      },
    };
    mocks.buildEvalCase.mockReturnValue({
      evalCase: fakeEvalCase,
      sliceBytes: Buffer.from('proposal-fixture'),
    });
    mocks.writeEvalCase.mockReturnValue({
      evalCaseId: 'my-card-eval-20260101-prop',
      jsonPath: '/p/eval.json',
      fixturePath: '/p/eval.fixture.jsonl',
      markdownPath: '/p/eval.md',
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card', '--proposal', 'p-abc',
    ]);
    expect(processExitMock).not.toHaveBeenCalled();
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const proposalNote = logCalls.find((c) => typeof c === 'string' && c.includes('proposal:') && c.includes('p-abc'));
    expect(proposalNote).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — EvalGenError handling
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — EvalGenError', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('exits 2 on evidence-row-out-of-range error', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    const EvalGenError = mocks.EvalGenError;
    mocks.buildEvalCase.mockImplementation(() => {
      throw new EvalGenError('row out of range', 'evidence-row-out-of-range');
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });

  it('exits 1 on fixture-mismatch error', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    const EvalGenError = mocks.EvalGenError;
    mocks.buildEvalCase.mockImplementation(() => {
      throw new EvalGenError('fixture mismatch', 'fixture-mismatch');
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card',
    ]);
    expect(processExitMock).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// registerEvalGenSubcommand — plain Error fallback to handleCommandError
// ---------------------------------------------------------------------------

describe('registerEvalGenSubcommand — plain Error fallback', () => {
  function makeCard(slug: string) {
    return {
      slug,
      evidence: [
        { sessionId: 's0', tracePath: '/t/0.jsonl', eventIndices: [0], excerpt: 'ex', detectedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
  }

  it('calls handleCommandError when buildEvalCase throws a plain Error', async () => {
    mocks.getCard.mockReturnValue(makeCard('my-card'));
    mocks.buildEvalCase.mockImplementation(() => {
      throw new Error('unexpected disk failure');
    });
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-gen', 'my-card',
    ]);
    expect(mocks.handleCommandError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'unexpected disk failure' }),
    );
  });
});

// ---------------------------------------------------------------------------
// registerEvalCasesSubcommand — list
// ---------------------------------------------------------------------------

describe('registerEvalCasesSubcommand list', () => {
  it('prints "No eval-cases found." when the list is empty', async () => {
    mocks.listEvalCases.mockReturnValue([]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list']);
    expect(console.log).toHaveBeenCalledWith('No eval-cases found.');
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('emits a table header when entries are present', async () => {
    mocks.listEvalCases.mockReturnValue([
      makeListEntry({ evalCaseId: 'my-card-eval-20260101-aabbcc', cardSlug: 'my-card' }),
    ]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list']);
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const output = logCalls.join('\n');
    expect(output).toContain('EVAL CASE ID');
    expect(output).toContain('my-card-eval-20260101-aabbcc');
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('emits JSON with --json flag', async () => {
    mocks.listEvalCases.mockReturnValue([makeListEntry({ evalCaseId: 'test-eval', cardSlug: 'test-card' })]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--json']);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('['));
    expect(jsonOutput).toBeDefined();
    if (jsonOutput) {
      const parsed = JSON.parse(jsonOutput) as unknown[];
      expect(parsed).toHaveLength(1);
    }
  });

  it('filters by --card when provided', async () => {
    mocks.listEvalCases.mockReturnValue([
      makeListEntry({ evalCaseId: 'ec-a', cardSlug: 'card-a', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeListEntry({ evalCaseId: 'ec-b', cardSlug: 'card-b', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--card', 'card-a', '--json']);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('['));
    expect(jsonOutput).toBeDefined();
    if (jsonOutput) {
      const parsed = JSON.parse(jsonOutput) as Array<{ cardSlug: string }>;
      expect(parsed.every((e) => e.cardSlug === 'card-a')).toBe(true);
    }
  });

  it('exits 2 for an invalid --pattern value', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--pattern', 'invalid-pattern']);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });

  it('exits 2 for an invalid --status value', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--status', 'invalid-status']);
    expect(processExitMock).toHaveBeenCalledWith(2);
  });

  it('filters by --status when triage is not set', async () => {
    mocks.listEvalCases.mockReturnValue([
      makeListEntry({ evalCaseId: 'ec-draft', cardSlug: 'c1', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeListEntry({ evalCaseId: 'ec-approved', cardSlug: 'c2', status: 'approved', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-cases', 'list', '--status', 'approved', '--json',
    ]);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('['));
    expect(jsonOutput).toBeDefined();
    if (jsonOutput) {
      const parsed = JSON.parse(jsonOutput) as Array<{ status: string }>;
      expect(parsed.every((e) => e.status === 'approved')).toBe(true);
      expect(parsed).toHaveLength(1);
    }
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('shows triage mode with --triage flag (oldest-first sort, draft filter)', async () => {
    mocks.listEvalCases.mockReturnValue([
      makeListEntry({ evalCaseId: 'ec-draft-new', cardSlug: 'c1', status: 'draft', createdAt: '2026-06-01T00:00:00.000Z' }),
      makeListEntry({ evalCaseId: 'ec-draft-old', cardSlug: 'c2', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeListEntry({ evalCaseId: 'ec-approved', cardSlug: 'c3', status: 'approved', createdAt: '2026-01-05T00:00:00.000Z' }),
    ]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--triage']);
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const output = logCalls.join('\n');
    // Triage shows AGE column.
    expect(output).toContain('AGE');
    // Approved entry must not appear in triage output.
    expect(output).not.toContain('ec-approved');
    // Both draft entries should appear.
    expect(output).toContain('ec-draft-old');
    expect(output).toContain('ec-draft-new');
    // Oldest-first: ec-draft-old (Jan) should appear before ec-draft-new (Jun).
    expect(output.indexOf('ec-draft-old')).toBeLessThan(output.indexOf('ec-draft-new'));
  });

  it('shows empty triage message when no draft eval-cases exist', async () => {
    mocks.listEvalCases.mockReturnValue([
      makeListEntry({ evalCaseId: 'ec-approved', cardSlug: 'c3', status: 'approved', createdAt: '2026-01-05T00:00:00.000Z' }),
    ]);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list', '--triage']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No draft eval-cases'));
  });

  it('warns when both --triage and --status are provided', async () => {
    mocks.listEvalCases.mockReturnValue([]);
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'improve', 'eval-cases', 'list', '--triage', '--status', 'approved',
    ]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('--status is ignored'));
  });
});

// ---------------------------------------------------------------------------
// registerEvalCasesSubcommand — list error path
// ---------------------------------------------------------------------------

describe('registerEvalCasesSubcommand list — error path', () => {
  it('calls handleCommandError when listEvalCases throws', async () => {
    mocks.listEvalCases.mockImplementation(() => {
      throw new Error('storage failure');
    });
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'list']);
    expect(mocks.handleCommandError).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// registerEvalCasesSubcommand — show
// ---------------------------------------------------------------------------

describe('registerEvalCasesSubcommand show', () => {
  it('exits 1 when eval-case id is not found', async () => {
    mocks.getEvalCase.mockReturnValue(undefined);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'show', 'unknown-id']);
    expect(processExitMock).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('renders markdown when eval-case is found', async () => {
    const ec = makeEvalCase('ec-123', 0);
    mocks.getEvalCase.mockReturnValue(ec);
    mocks.renderEvalCaseMarkdown.mockReturnValue('## My Eval\n\nDetails here.');
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'show', 'ec-123']);
    expect(console.log).toHaveBeenCalledWith('## My Eval\n\nDetails here.');
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('emits JSON with --json flag', async () => {
    const ec = { ...makeEvalCase('ec-json', 0), proposalId: null };
    mocks.getEvalCase.mockReturnValue(ec);
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'show', 'ec-json', '--json']);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat() as string[];
    const jsonOutput = calls.find((c) => c.startsWith('{'));
    expect(jsonOutput).toBeDefined();
    if (jsonOutput) {
      const parsed = JSON.parse(jsonOutput) as { evalCaseId: string };
      expect(parsed.evalCaseId).toBe('ec-json');
    }
    expect(processExitMock).not.toHaveBeenCalled();
  });

  it('calls handleCommandError when getEvalCase throws', async () => {
    mocks.getEvalCase.mockImplementation(() => {
      throw new Error('read failure');
    });
    const program = buildProgram();
    await program.parseAsync(['node', 'afk', 'improve', 'eval-cases', 'show', 'ec-123']);
    expect(mocks.handleCommandError).toHaveBeenCalledWith(expect.any(Error));
  });
});
