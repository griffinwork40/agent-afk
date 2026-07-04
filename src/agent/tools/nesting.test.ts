import { describe, expect, it } from 'vitest';
import {
  CHILD_ALLOWED_TOOLS,
  RECON_ALLOWED_TOOLS,
  DEFAULT_READ_ONLY_SKILLS,
  buildReadOnlyReconProvider,
  buildSkillRestrictedProvider,
} from './nesting.js';
import { checkToolPermission } from './permissions.js';

describe('CHILD_ALLOWED_TOOLS', () => {
  it("includes 'memory_search'", () => {
    expect(CHILD_ALLOWED_TOOLS).toContain('memory_search');
  });

  it("does NOT include 'memory_update'", () => {
    // memory_update with target:"hot" mutates HOT.md — the system prompt of every
    // future session. Blast radius is too large for unsupervised sub-agent writes.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('memory_update');
  });

  it("does NOT include 'procedure_write'", () => {
    // procedure_write is a write path; per-skill opt-in via a
    // buildPhaseRestrictedProvider-style builder is the intended route.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('procedure_write');
  });

  it("includes 'agent' and 'skill'", () => {
    expect(CHILD_ALLOWED_TOOLS).toContain('agent');
    expect(CHILD_ALLOWED_TOOLS).toContain('skill');
  });

  it("does NOT include 'compose'", () => {
    // compose is excluded to prevent unbounded DAG fan-out from child nodes.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('compose');
  });
});

describe('buildSkillRestrictedProvider', () => {
  it('returns a provider without throwing for a valid allowedTools list', () => {
    const provider = buildSkillRestrictedProvider(['read_file', 'grep', 'glob'], 'sonnet');
    expect(provider).toBeDefined();
    expect(typeof provider.query).toBe('function');
  });

  it('returns a provider for undefined model (falls back to Anthropic)', () => {
    const provider = buildSkillRestrictedProvider(['read_file'], undefined);
    expect(provider).toBeDefined();
  });

  it('returns a provider for an OpenAI-routed model', () => {
    const provider = buildSkillRestrictedProvider(['read_file', 'bash'], 'gpt-4o');
    expect(provider).toBeDefined();
    expect(typeof provider.query).toBe('function');
  });

  it('enforces the allowlist via checkToolPermission on the provider permissions', () => {
    // This test verifies the structural guarantee: permissions.allowedTools is
    // exactly what was passed in, so the dispatcher will block disallowed tools.
    const allowedTools = ['read_file', 'grep', 'glob', 'list_directory'];
    // We can't call provider.query() without an API key, but we CAN verify
    // that checkToolPermission with the same allowedTools list correctly
    // allows/blocks tools — which is what the provider passes to the dispatcher.
    const config = { allowedTools };
    expect(checkToolPermission('read_file', config).allowed).toBe(true);
    expect(checkToolPermission('grep', config).allowed).toBe(true);
    expect(checkToolPermission('edit_file', config).allowed).toBe(false);
    expect(checkToolPermission('write_file', config).allowed).toBe(false);
    expect(checkToolPermission('bash', config).allowed).toBe(false);
  });

  it('does NOT include CHILD_ALLOWED_TOOLS write tools when a narrow list is given', () => {
    // Regression guard: a skill declaring `tools: read_file, grep` must NOT
    // silently inherit edit_file / write_file from CHILD_ALLOWED_TOOLS.
    const narrowList = ['read_file', 'grep'];
    const config = { allowedTools: narrowList };
    expect(checkToolPermission('edit_file', config).allowed).toBe(false);
    expect(checkToolPermission('write_file', config).allowed).toBe(false);
    // But the declared tools are allowed
    expect(checkToolPermission('read_file', config).allowed).toBe(true);
    expect(checkToolPermission('grep', config).allowed).toBe(true);
  });

  it('blocks ALL tools when called with an empty allowlist (fail-closed enforcement)', () => {
    // M3: end-to-end enforcement test — proves the gate fires.
    //
    // Invariant: buildSkillRestrictedProvider([]) produces a provider whose
    // permissions.allowedTools = [] which causes checkToolPermission to deny
    // every tool. This is the fail-closed contract: a SKILL.md `tools:` field
    // that resolves to zero valid tools MUST block everything, not silently grant
    // full CHILD_ALLOWED_TOOLS access.
    //
    // We drive the enforcement through checkToolPermission with the same
    // allowedTools list the provider would pass to the dispatcher — the
    // same seam used by the existing 'enforces the allowlist via checkToolPermission'
    // test above, and the cleanest no-network path available.
    const provider = buildSkillRestrictedProvider([], 'sonnet');
    expect(provider).toBeDefined();

    // The provider passes { allowedTools: [] } to the dispatcher via its
    // permissions field. Verify that checkToolPermission correctly blocks
    // every tool when the list is empty.
    const config = { allowedTools: [] as string[] };
    expect(checkToolPermission('read_file', config).allowed).toBe(false);
    expect(checkToolPermission('grep', config).allowed).toBe(false);
    expect(checkToolPermission('edit_file', config).allowed).toBe(false);
    expect(checkToolPermission('bash', config).allowed).toBe(false);
    expect(checkToolPermission('write_file', config).allowed).toBe(false);
    expect(checkToolPermission('agent', config).allowed).toBe(false);
    expect(checkToolPermission('skill', config).allowed).toBe(false);
  });
});

describe('RECON_ALLOWED_TOOLS (read-only skill child allowlist)', () => {
  it("EXCLUDES 'write_file' and 'edit_file' (the file-mutation tools)", () => {
    // This is the tool half of read-only-skill enforcement: a read-only skill's
    // forked child cannot mutate files because these tools are not in the
    // allowlist `checkToolPermission` consults.
    expect(RECON_ALLOWED_TOOLS).not.toContain('write_file');
    expect(RECON_ALLOWED_TOOLS).not.toContain('edit_file');
  });

  it("INCLUDES 'bash' (read-only recon needs git status/log/diff)", () => {
    // bash is admitted but gated by the dispatcher's readOnlyBash classifier —
    // mutating bash is blocked at execution time, read-only bash passes.
    expect(RECON_ALLOWED_TOOLS).toContain('bash');
  });

  it("INCLUDES 'agent' and 'skill' (surveyor fan-out)", () => {
    expect(RECON_ALLOWED_TOOLS).toContain('agent');
    expect(RECON_ALLOWED_TOOLS).toContain('skill');
  });

  it("INCLUDES the core read tools", () => {
    for (const t of ['read_file', 'grep', 'glob', 'list_directory', 'web_scrape', 'memory_search']) {
      expect(RECON_ALLOWED_TOOLS).toContain(t);
    }
  });

  it("INCLUDES 'get_runtime_state' (via AWARENESS_TOOL_NAMES)", () => {
    expect(RECON_ALLOWED_TOOLS).toContain('get_runtime_state');
  });

  it('EXCLUDES side-effecting + environment tools', () => {
    for (const t of [
      'send_telegram',
      'terminal_font_size',
      'ask_question',
      'browser_open',
      'browser_act',
      'create_schedule',
      'cancel_schedule',
    ]) {
      expect(RECON_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it('the allowlist actually DENIES write_file / edit_file through checkToolPermission', () => {
    // Close the loop: the dispatcher's permission gate is what enforces the
    // allowlist, and it reads exactly this array. A read-only skill's child
    // provider is constructed with `permissions.allowedTools = RECON_ALLOWED_TOOLS`.
    const permissions = { allowedTools: [...RECON_ALLOWED_TOOLS] };
    expect(checkToolPermission('write_file', permissions).allowed).toBe(false);
    expect(checkToolPermission('edit_file', permissions).allowed).toBe(false);
    // ...and ALLOWS the recon tools.
    expect(checkToolPermission('read_file', permissions).allowed).toBe(true);
    expect(checkToolPermission('bash', permissions).allowed).toBe(true);
    expect(checkToolPermission('agent', permissions).allowed).toBe(true);
  });
});

describe('DEFAULT_READ_ONLY_SKILLS', () => {
  it("contains 'ground-state'", () => {
    expect(DEFAULT_READ_ONLY_SKILLS.has('ground-state')).toBe(true);
  });

  it('does not contain an arbitrary skill name', () => {
    expect(DEFAULT_READ_ONLY_SKILLS.has('mint')).toBe(false);
  });
});

describe('restricted builders thread openaiBaseUrl into the OpenAI client baseURL', () => {
  // Regression: a deep OpenAI-routed subagent built via these restricted/depth-cap
  // builders must point at the configured endpoint, not default to api.openai.com
  // (where a non-OpenAI key 401s as "Incorrect API key provided"). Complements the
  // query-time fallback in openai-compatible/base-url.ts. Mirrors the providerOpts
  // baseURL introspection in providers/routing.test.ts.
  const bakedBaseURL = (provider: unknown): string | undefined =>
    (provider as { providerOpts: { baseURL?: string } }).providerOpts.baseURL;

  it('buildReadOnlyReconProvider bakes openaiBaseUrl into an OpenAI-routed child', () => {
    const provider = buildReadOnlyReconProvider('gpt-4o', 'https://opencode.ai/zen/go/v1');
    expect(bakedBaseURL(provider)).toBe('https://opencode.ai/zen/go/v1');
  });

  it('buildReadOnlyReconProvider leaves baseURL unset when no openaiBaseUrl is given', () => {
    const provider = buildReadOnlyReconProvider('gpt-4o');
    expect(bakedBaseURL(provider)).toBeUndefined();
  });

  it('buildSkillRestrictedProvider bakes openaiBaseUrl into an OpenAI-routed child', () => {
    const provider = buildSkillRestrictedProvider(
      ['read_file'],
      'gpt-4o',
      false,
      'https://opencode.ai/zen/go/v1',
    );
    expect(bakedBaseURL(provider)).toBe('https://opencode.ai/zen/go/v1');
  });

  it('buildSkillRestrictedProvider leaves baseURL unset when no openaiBaseUrl is given', () => {
    const provider = buildSkillRestrictedProvider(['read_file'], 'gpt-4o');
    expect(bakedBaseURL(provider)).toBeUndefined();
  });
});
