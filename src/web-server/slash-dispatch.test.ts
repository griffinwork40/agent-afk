/**
 * Tests for `classifySlashInput` — the web surface's slash-command classifier.
 *
 * Uses vi.mock to stub the slash registry and skill bridge, avoiding real
 * disk I/O and registration side effects. Each case verifies classification
 * only — the HTTP response layer is tested in the routes integration tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stubs set per-test.
let mockParse: ReturnType<typeof vi.fn>;
let mockLookup: ReturnType<typeof vi.fn>;
let mockSuggest: ReturnType<typeof vi.fn>;
let mockRegisterAll: ReturnType<typeof vi.fn>;
let mockBuildSkillInvocationMessage: ReturnType<typeof vi.fn>;
let mockGetPreflight: ReturnType<typeof vi.fn>;
let mockRunPreflight: ReturnType<typeof vi.fn>;
let mockGetSkillPreflightDir: ReturnType<typeof vi.fn>;
let mockGetSkill: ReturnType<typeof vi.fn>;

vi.mock('../cli/slash/index.js', () => ({
  registerAll: (...args: unknown[]) => mockRegisterAll(...args),
}));

vi.mock('../cli/slash/registry.js', () => ({
  parse: (...args: unknown[]) => mockParse(...args),
  lookup: (...args: unknown[]) => mockLookup(...args),
  suggest: (...args: unknown[]) => mockSuggest(...args),
}));

vi.mock('../cli/slash/_lib/skill-message-bridge.js', () => ({
  buildSkillInvocationMessage: (...args: unknown[]) => mockBuildSkillInvocationMessage(...args),
}));

vi.mock('../cli/slash/preflight/index.js', () => ({
  getPreflight: (...args: unknown[]) => mockGetPreflight(...args),
  runPreflight: (...args: unknown[]) => mockRunPreflight(...args),
  getSkillPreflightDir: (...args: unknown[]) => mockGetSkillPreflightDir(...args),
}));

vi.mock('../skills/index.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

import { classifySlashInput } from './slash-dispatch.js';

beforeEach(() => {
  mockRegisterAll = vi.fn();
  mockParse = vi.fn().mockReturnValue(null);
  mockLookup = vi.fn().mockReturnValue(undefined);
  mockSuggest = vi.fn().mockReturnValue(undefined);
  mockBuildSkillInvocationMessage = vi.fn().mockResolvedValue([{ type: 'text', text: 'mock' }]);
  mockGetPreflight = vi.fn().mockReturnValue(undefined);
  mockRunPreflight = vi.fn().mockResolvedValue(null);
  mockGetSkillPreflightDir = vi.fn().mockReturnValue('/tmp/preflight');
  mockGetSkill = vi.fn().mockReturnValue({
    name: 'review',
    description: 'review skill',
    handler: async () => undefined,
    context: 'load',
  });
});

describe('classifySlashInput', () => {
  it('returns passthrough for non-slash text', async () => {
    const result = await classifySlashInput('hello world', '/tmp', undefined);
    expect(result.kind).toBe('passthrough');
    // Should not even call registerAll for plain text.
    expect(mockRegisterAll).not.toHaveBeenCalled();
  });

  it('returns passthrough when parse returns null', async () => {
    mockParse.mockReturnValue(null);
    const result = await classifySlashInput('//', '/tmp', undefined);
    expect(result.kind).toBe('passthrough');
  });

  it('returns repl-only for terminal-only commands', async () => {
    mockParse.mockReturnValue({ name: '/clear', args: '' });
    const result = await classifySlashInput('/clear', '/tmp', undefined);
    expect(result).toEqual({ kind: 'repl-only', command: '/clear' });
  });

  it('returns repl-only for /exit', async () => {
    mockParse.mockReturnValue({ name: '/exit', args: '' });
    const result = await classifySlashInput('/exit', '/tmp', undefined);
    expect(result).toEqual({ kind: 'repl-only', command: '/exit' });
  });

  it('returns unknown with suggestion for unrecognised command', async () => {
    mockParse.mockReturnValue({ name: '/reveiw', args: '' });
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue('/review');
    const result = await classifySlashInput('/reveiw', '/tmp', undefined);
    expect(result).toEqual({ kind: 'unknown', command: '/reveiw', suggestion: '/review' });
  });

  it('returns unknown without suggestion when no close match', async () => {
    mockParse.mockReturnValue({ name: '/zzzzz', args: '' });
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue(undefined);
    const result = await classifySlashInput('/zzzzz', '/tmp', undefined);
    expect(result).toEqual({ kind: 'unknown', command: '/zzzzz', suggestion: undefined });
  });

  it('returns passthrough for non-skill native commands (e.g. /help)', async () => {
    mockParse.mockReturnValue({ name: '/help', args: '' });
    mockLookup.mockReturnValue({
      name: '/help',
      summary: 'help',
      handler: vi.fn(),
      // No acceptsAttachments — native command, not a skill.
    });
    const result = await classifySlashInput('/help', '/tmp', undefined);
    expect(result.kind).toBe('passthrough');
  });

  it('returns skill with built message for skill commands', async () => {
    const fakeBlocks = [
      { type: 'text', text: '<command-name>/review</command-name>' },
      { type: 'text', text: 'Use the `skill` tool...' },
    ];
    mockParse.mockReturnValue({ name: '/review', args: '277' });
    mockLookup.mockReturnValue({
      name: '/review',
      summary: 'Code review',
      handler: vi.fn(),
      acceptsAttachments: true,
    });
    mockBuildSkillInvocationMessage.mockResolvedValue(fakeBlocks);

    const result = await classifySlashInput('/review 277', '/tmp', 'session-123');
    expect(result.kind).toBe('skill');
    if (result.kind === 'skill') {
      expect(result.message).toEqual(fakeBlocks);
    }
    expect(mockBuildSkillInvocationMessage).toHaveBeenCalled();
  });

  it('runs preflight when one is registered', async () => {
    const mockPreflightFn = vi.fn();
    mockParse.mockReturnValue({ name: '/review', args: '277' });
    mockLookup.mockReturnValue({
      name: '/review',
      summary: 'Code review',
      handler: vi.fn(),
      acceptsAttachments: true,
    });
    mockGetPreflight.mockReturnValue(mockPreflightFn);
    mockRunPreflight.mockResolvedValue({ manifestBlock: 'PR #277 diff context...' });

    await classifySlashInput('/review 277', '/tmp', 'session-123');

    expect(mockRunPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'review', rawArgs: '277' }),
      expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(mockBuildSkillInvocationMessage).toHaveBeenCalledWith(
      expect.anything(),
      '277',
      'PR #277 diff context...',
      undefined,
      'session-123',
    );
  });

  it('still dispatches skill when preflight throws', async () => {
    mockParse.mockReturnValue({ name: '/review', args: '277' });
    mockLookup.mockReturnValue({
      name: '/review',
      summary: 'Code review',
      handler: vi.fn(),
      acceptsAttachments: true,
    });
    mockGetPreflight.mockReturnValue(vi.fn());
    mockRunPreflight.mockRejectedValue(new Error('gh not found'));

    const result = await classifySlashInput('/review 277', '/tmp', 'session-123');
    expect(result.kind).toBe('skill');
    // manifestBlock should be undefined (preflight failed gracefully).
    expect(mockBuildSkillInvocationMessage).toHaveBeenCalledWith(
      expect.anything(),
      '277',
      undefined,
      undefined,
      'session-123',
    );
  });

  it('synthesises a minimal SkillMetadata when getSkill throws', async () => {
    mockParse.mockReturnValue({ name: '/custom-plugin-skill', args: '' });
    mockLookup.mockReturnValue({
      name: '/custom-plugin-skill',
      summary: 'Plugin skill',
      handler: vi.fn(),
      acceptsAttachments: true,
    });
    mockGetSkill.mockImplementation(() => {
      throw new Error('Skill not found: custom-plugin-skill');
    });

    const result = await classifySlashInput('/custom-plugin-skill', '/tmp', undefined);
    expect(result.kind).toBe('skill');
    expect(mockBuildSkillInvocationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'custom-plugin-skill', context: 'inline' }),
      '',
      undefined,
      undefined,
      undefined,
    );
  });

  it('calls registerAll on first invocation', async () => {
    mockParse.mockReturnValue({ name: '/review', args: '' });
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue(undefined);

    await classifySlashInput('/review', '/tmp', undefined);
    expect(mockRegisterAll).toHaveBeenCalledTimes(1);
  });
});
