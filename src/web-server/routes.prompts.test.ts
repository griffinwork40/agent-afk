import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleListPrompts, handleSearchPrompts, handleGetPrompt } from './routes.prompts.js';
import type { PromptEntry } from '../prompts/types.js';

// ---- mocks -----------------------------------------------------------------

const mockGetPromptRegistry = vi.fn<() => PromptEntry[]>();
const mockGetPromptById = vi.fn<(id: string) => PromptEntry | undefined>();
const mockSearchPrompts = vi.fn<(q: string) => PromptEntry[]>();

vi.mock('../prompts/registry.js', () => ({
  getPromptRegistry: () => mockGetPromptRegistry(),
  getPromptById: (id: string) => mockGetPromptById(id),
  searchPrompts: (q: string) => mockSearchPrompts(q),
}));

// ---- fixtures --------------------------------------------------------------

function makeEntry(overrides: Partial<PromptEntry> = {}): PromptEntry {
  return {
    id: 'skill-phase:src/skills/mint/prompts/spec.md',
    kind: 'skill-phase',
    name: 'mint/spec',
    skill: 'mint',
    phase: 'spec',
    sourcePath: '/Users/someone/Projects/agent-afk/src/skills/mint/prompts/spec.md',
    relativePath: 'src/skills/mint/prompts/spec.md',
    editable: false,
    pinned: false,
    tokenEstimate: 512,
    injectionContext: 'skill phase (fork)',
    load: () => '# Spec prompt content',
    ...overrides,
  };
}

const ENTRY_A = makeEntry();
const ENTRY_B = makeEntry({
  id: 'framework:system-prompt.md',
  kind: 'framework',
  name: 'system-prompt',
  skill: undefined,
  phase: undefined,
  sourcePath: '/Users/someone/Projects/agent-afk/system-prompt.md',
  relativePath: 'system-prompt.md',
  editable: false,
  pinned: false,
  tokenEstimate: 1024,
  injectionContext: 'session system prompt',
  load: () => '# System prompt',
});

// ---- helpers ---------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(payload: string) {
      chunks.push(payload);
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }),
  };
}

function makeQuery(params: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(params);
}

// ---- tests -----------------------------------------------------------------

describe('routes.prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // handleListPrompts
  // --------------------------------------------------------------------------

  describe('handleListPrompts', () => {
    it('returns 200 with all prompts as wire shapes', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A, ENTRY_B]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery());
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { prompts: unknown[] }).prompts).toHaveLength(2);
    });

    it('wire shape does NOT include sourcePath', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery());
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      expect(prompts[0]).not.toHaveProperty('sourcePath');
    });

    it('wire shape includes expected fields', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery());
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      const p = prompts[0]!;
      expect(p['id']).toBe(ENTRY_A.id);
      expect(p['kind']).toBe('skill-phase');
      expect(p['name']).toBe('mint/spec');
      expect(p['skill']).toBe('mint');
      expect(p['phase']).toBe('spec');
      expect(p['relativePath']).toBe('src/skills/mint/prompts/spec.md');
      expect(p['editable']).toBe(false);
      expect(p['pinned']).toBe(false);
      expect(p['tokenEstimate']).toBe(512);
      expect(p['injectionContext']).toBe('skill phase (fork)');
    });

    it('wire shape does not include content field', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery());
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      expect(prompts[0]).not.toHaveProperty('content');
    });

    it('filters by kind when kind param is supplied', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A, ENTRY_B]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery({ kind: 'framework' }));
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!['kind']).toBe('framework');
    });

    it('returns empty array when kind filter matches nothing', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_A, ENTRY_B]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery({ kind: 'user-skill' }));
      const { prompts } = json().body as { prompts: unknown[] };
      expect(prompts).toHaveLength(0);
    });

    it('omits optional skill/phase fields when absent', async () => {
      mockGetPromptRegistry.mockReturnValue([ENTRY_B]);
      const { res, json } = makeRes();
      await handleListPrompts(res, makeQuery());
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      expect(prompts[0]).not.toHaveProperty('skill');
      expect(prompts[0]).not.toHaveProperty('phase');
    });
  });

  // --------------------------------------------------------------------------
  // handleSearchPrompts
  // --------------------------------------------------------------------------

  describe('handleSearchPrompts', () => {
    it('returns 400 when q is absent', async () => {
      const { res, json } = makeRes();
      await handleSearchPrompts(res, makeQuery());
      const { status, body } = json();
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('bad_request');
    });

    it('returns 400 when q is blank/whitespace', async () => {
      const { res, json } = makeRes();
      await handleSearchPrompts(res, makeQuery({ q: '   ' }));
      expect(json().status).toBe(400);
    });

    it('returns 200 with matching prompts', async () => {
      mockSearchPrompts.mockReturnValue([ENTRY_A]);
      const { res, json } = makeRes();
      await handleSearchPrompts(res, makeQuery({ q: 'mint' }));
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { prompts: unknown[] }).prompts).toHaveLength(1);
    });

    it('passes q through to searchPrompts', async () => {
      mockSearchPrompts.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchPrompts(res, makeQuery({ q: 'spine' }));
      expect(mockSearchPrompts).toHaveBeenCalledWith('spine');
    });

    it('search results do not include sourcePath', async () => {
      mockSearchPrompts.mockReturnValue([ENTRY_A]);
      const { res, json } = makeRes();
      await handleSearchPrompts(res, makeQuery({ q: 'mint' }));
      const { prompts } = json().body as { prompts: Record<string, unknown>[] };
      expect(prompts[0]).not.toHaveProperty('sourcePath');
    });
  });

  // --------------------------------------------------------------------------
  // handleGetPrompt
  // --------------------------------------------------------------------------

  describe('handleGetPrompt', () => {
    it('returns 404 for an unknown id', async () => {
      mockGetPromptById.mockReturnValue(undefined);
      const { res, json } = makeRes();
      await handleGetPrompt(res, 'skill-phase:nonexistent.md');
      const { status, body } = json();
      expect(status).toBe(404);
      expect((body as { error: string }).error).toBe('not_found');
    });

    it('returns 200 with prompt metadata and content for a known id', async () => {
      mockGetPromptById.mockReturnValue(ENTRY_A);
      const { res, json } = makeRes();
      await handleGetPrompt(res, ENTRY_A.id);
      const { status, body } = json();
      expect(status).toBe(200);
      const prompt = (body as { prompt: Record<string, unknown> }).prompt;
      expect(prompt['id']).toBe(ENTRY_A.id);
      expect(prompt['content']).toBe('# Spec prompt content');
    });

    it('content field comes from entry.load()', async () => {
      const loadMock = vi.fn().mockReturnValue('loaded content here');
      mockGetPromptById.mockReturnValue(makeEntry({ load: loadMock }));
      const { res, json } = makeRes();
      await handleGetPrompt(res, ENTRY_A.id);
      const { prompt } = json().body as { prompt: Record<string, unknown> };
      expect(loadMock).toHaveBeenCalledOnce();
      expect(prompt['content']).toBe('loaded content here');
    });

    it('does not include sourcePath in the response', async () => {
      mockGetPromptById.mockReturnValue(ENTRY_A);
      const { res, json } = makeRes();
      await handleGetPrompt(res, ENTRY_A.id);
      const { prompt } = json().body as { prompt: Record<string, unknown> };
      expect(prompt).not.toHaveProperty('sourcePath');
    });

    it('passes the id through to getPromptById', async () => {
      mockGetPromptById.mockReturnValue(ENTRY_A);
      const { res } = makeRes();
      await handleGetPrompt(res, ENTRY_A.id);
      expect(mockGetPromptById).toHaveBeenCalledWith(ENTRY_A.id);
    });
  });
});
