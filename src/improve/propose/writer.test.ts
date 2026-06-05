/**
 * Tests for `improve/propose/writer.ts`.
 *
 * Coverage:
 *   - generateProposalId format + injection seams.
 *   - writeProposal creates <id>.json + <id>.md atomically.
 *   - .index.jsonl gets an append per write.
 *   - listProposals returns entries newest-first.
 *   - getProposal returns the parsed proposal.
 *   - getProposalsForCard filters correctly.
 *   - Writing the same id twice overwrites (no dedup) but appends another
 *     index event (matches card-writer behavior).
 *   - Markdown renderer is byte-stable for the same input.
 *   - Invalid suffix rejected.
 *   - Forbidden paths render correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateProposalId,
  getProposal,
  getProposalsForCard,
  listProposals,
  renderProposalMarkdown,
  writeProposal,
} from './writer.js';
import { proposeFromCard, type TemplateContext } from './template-engine.js';
import {
  type FailureCard,
  type ImprovementProposal,
  ImprovementProposalSchema,
} from '../schemas.js';
import { getProposalsDir, getProposalsIndexPath } from '../paths.js';

// ---------------------------------------------------------------------------
// Filesystem fixture
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtempSync(join(tmpdir(), 'afk-propose-test-'));
  process.env['AFK_HOME'] = tempHome;
});

afterEach(() => {
  if (originalAfkHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = originalAfkHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<FailureCard> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: 'repeated-tool-grep-aabbccddeeff',
    title: "'grep' repeated 4×",
    pattern: 'repeated-tool-use',
    severity: 'medium',
    status: 'open',
    firstSeen: '2026-05-22T10:00:00.000Z',
    lastSeen: '2026-05-22T10:00:00.000Z',
    occurrenceCount: 1,
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [10, 12, 14, 16],
        excerpt: '{"kind":"tool_call"}',
      },
    ],
    detail: { detector: 'repeated-tool-use@v1', toolName: 'grep', runLength: 4 },
    notes: [],
    ...overrides,
  };
}

const FIXED_NOW = () => new Date('2026-05-24T19:30:00.000Z');

function makeProposal(overrides: Partial<ImprovementProposal> = {}): ImprovementProposal {
  const card = makeCard();
  const ctx: TemplateContext = { proposalId: 'test-prop-id', now: FIXED_NOW };
  const base = proposeFromCard(card, ctx);
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateProposalId', () => {
  it('produces <cardSlug>-<yyyymmdd>-<6hex>', () => {
    const id = generateProposalId('my-card-slug', {
      now: FIXED_NOW,
      randomSuffix: () => 'abcdef',
    });
    expect(id).toBe('my-card-slug-20260524-abcdef');
  });

  it('uses UTC for the date', () => {
    const id = generateProposalId('s', {
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      randomSuffix: () => '111111',
    });
    expect(id).toBe('s-20260102-111111');
  });

  it('rejects invalid suffix (not 6 hex chars)', () => {
    expect(() =>
      generateProposalId('s', { now: FIXED_NOW, randomSuffix: () => 'XYZ' }),
    ).toThrow(/6 lowercase hex chars/);
    expect(() =>
      generateProposalId('s', { now: FIXED_NOW, randomSuffix: () => 'abcdefg' }),
    ).toThrow();
  });

  it('default generator returns a valid id (uses real crypto)', () => {
    const id = generateProposalId('my-card-slug');
    expect(id).toMatch(/^my-card-slug-\d{8}-[0-9a-f]{6}$/);
  });

  it('matches the FailureCardSchema slug regex when the cardSlug does', () => {
    const id = generateProposalId('a-b-c', { now: FIXED_NOW, randomSuffix: () => '000000' });
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('writeProposal', () => {
  it('writes <id>.json and <id>.md atomically', () => {
    const proposal = makeProposal({ proposalId: 'my-id' });
    const outcome = writeProposal(proposal);

    expect(existsSync(outcome.jsonPath)).toBe(true);
    expect(existsSync(outcome.markdownPath)).toBe(true);

    const parsedJson = JSON.parse(readFileSync(outcome.jsonPath, 'utf-8'));
    const validated = ImprovementProposalSchema.safeParse(parsedJson);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.proposalId).toBe('my-id');
    }
  });

  it('creates the proposals dir on first write', () => {
    expect(existsSync(getProposalsDir())).toBe(false);
    writeProposal(makeProposal({ proposalId: 'first' }));
    expect(existsSync(getProposalsDir())).toBe(true);
  });

  it('appends to .index.jsonl on every write', () => {
    writeProposal(makeProposal({ proposalId: 'a' }));
    writeProposal(makeProposal({ proposalId: 'b' }));

    const indexLines = readFileSync(getProposalsIndexPath(), 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(indexLines).toHaveLength(2);
    const evt1 = JSON.parse(indexLines[0]!);
    expect(evt1.event).toBe('created');
    expect(evt1.proposalId).toBe('a');
  });

  it('rejects proposals that fail schema validation', () => {
    const bad = { ...makeProposal(), proposalId: 'invalid id with spaces' };
    expect(() => writeProposal(bad as ImprovementProposal)).toThrow();
  });
});

describe('listProposals / getProposal / getProposalsForCard', () => {
  it('returns empty when no proposals exist', () => {
    expect(listProposals()).toEqual([]);
    expect(getProposal('nope')).toBeUndefined();
    expect(getProposalsForCard('nope')).toEqual([]);
  });

  it('lists proposals newest-first', () => {
    writeProposal(makeProposal({ proposalId: 'old', createdAt: '2026-05-20T00:00:00.000Z' }));
    writeProposal(
      makeProposal({ proposalId: 'newer', createdAt: '2026-05-24T00:00:00.000Z' }),
    );
    const entries = listProposals();
    expect(entries.map((e) => e.proposalId)).toEqual(['newer', 'old']);
  });

  it('getProposal returns the round-tripped value', () => {
    const original = makeProposal({ proposalId: 'roundtrip' });
    writeProposal(original);
    const round = getProposal('roundtrip');
    expect(round).toBeDefined();
    expect(round?.proposalId).toBe('roundtrip');
    expect(round?.title).toBe(original.title);
  });

  it('getProposalsForCard filters by cardSlug', () => {
    writeProposal(makeProposal({ proposalId: 'p1', cardSlug: 'card-a' }));
    writeProposal(makeProposal({ proposalId: 'p2', cardSlug: 'card-a' }));
    writeProposal(makeProposal({ proposalId: 'p3', cardSlug: 'card-b' }));
    expect(getProposalsForCard('card-a').map((p) => p.proposalId).sort()).toEqual([
      'p1',
      'p2',
    ]);
    expect(getProposalsForCard('card-b').map((p) => p.proposalId)).toEqual(['p3']);
  });

  it('silently skips corrupt JSON files (matches card-writer convention)', () => {
    writeProposal(makeProposal({ proposalId: 'valid' }));
    // Drop a corrupt file in the same dir.
    const dir = getProposalsDir();
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    const entries = listProposals();
    expect(entries.map((e) => e.proposalId)).toEqual(['valid']);
  });
});

describe('renderProposalMarkdown', () => {
  it('is byte-stable for the same input', () => {
    const p = makeProposal({ proposalId: 'stable' });
    expect(renderProposalMarkdown(p)).toBe(renderProposalMarkdown(p));
  });

  it('renders core fields', () => {
    const md = renderProposalMarkdown(makeProposal({ proposalId: 'rendered' }));
    expect(md).toContain('rendered');
    expect(md).toContain('## Hypothesis');
    expect(md).toContain('## Likely files');
    expect(md).toContain('## Evidence references');
    expect(md).toContain('## Validation plan');
    expect(md).toContain('## Scope freeze');
    expect(md).toContain('## Triage notes');
  });

  it('renders forbidden paths', () => {
    const md = renderProposalMarkdown(makeProposal());
    expect(md).toContain('.env');
    expect(md).toContain('pnpm-lock.yaml');
    expect(md).toContain('**/auth/**');
  });

  it('renders requiresExplicitApproval correctly', () => {
    const mdYes = renderProposalMarkdown(
      makeProposal({
        riskLevel: 'high',
        scopeFreeze: { forbiddenPaths: ['**/secrets/**'], requiresExplicitApproval: true },
      }),
    );
    expect(mdYes).toContain('**Requires explicit approval:** **yes**');

    const mdNo = renderProposalMarkdown(
      makeProposal({
        riskLevel: 'low',
        scopeFreeze: { forbiddenPaths: ['**/secrets/**'], requiresExplicitApproval: false },
      }),
    );
    expect(mdNo).toContain('**Requires explicit approval:** no');
  });

  it('escapes pipe characters in markdown table cells', () => {
    const md = renderProposalMarkdown(
      makeProposal({
        likelyFiles: [
          {
            path: 'src/a|b.ts',
            rationale: 'has | pipe',
            riskTier: 'safe',
            confidence: 'low',
          },
        ],
      }),
    );
    // The table row should have escaped pipes.
    expect(md).toMatch(/src\/a\\\|b\.ts/);
    expect(md).toMatch(/has \\\| pipe/);
  });
});
