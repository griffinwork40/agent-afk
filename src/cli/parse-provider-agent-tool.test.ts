/**
 * Regression tests for `parseProvider()` Agent-tool and Compose-tool wiring.
 *
 * Originally added for PR #84 (Agent-tool wiring). Extended in PR #185
 * (Compose-tool activation) to mirror the subagentExecutor cases for
 * composeExecutor — ensuring the 'compose' tool appears in allowedTools
 * when and only when a composeExecutor is supplied, and that the executor
 * reference is preserved through to the AnthropicDirectProvider dispatcher.
 *
 * Locks in two CLI-layer fixes the existing 27 unit tests missed because
 * they construct executor/dispatcher/provider directly with hand-built
 * configs already containing `'agent'` in the allowlist:
 *
 *   1. `parseProvider('anthropic-direct', { subagentExecutor })` must
 *      include `'agent'` in `permissions.allowedTools`. Without this the
 *      root session's permission gate rejects every dispatch attempt.
 *   2. The injected name must be lowercase `'agent'` — schema name and
 *      dispatcher routing are both case-sensitive.
 *
 * See PR84-test-findings.md.
 */

import { describe, it, expect } from 'vitest';
import { parseProvider } from './shared-helpers.js';
import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';
import { BUILTIN_TOOL_NAMES } from '../agent/tools/schemas.js';
import { MEMORY_TOOL_NAMES } from '../agent/memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../agent/awareness/index.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../agent/tools/handlers/exit-plan-mode.js';
import type { SubagentExecutor } from '../agent/tools/subagent-executor.js';
import type { ComposeExecutor } from '../agent/tools/compose-executor.js';
import type { SkillExecutor } from '../agent/tools/skill-executor.js';
import type { ToolPermissionConfig } from '../agent/tools/permissions.js';

/**
 * The provider stores permissions and executors as private fields so that
 * per-query dispatchers can be constructed with the correct permission mode
 * (C2 env-race fix). Reading them back via a typed unknown-cast is acceptable
 * in a regression test: we are deliberately asserting on internal state that
 * the CLI wiring constructs, and the alternative (round-tripping a real tool
 * call through the permission gate) would require standing up a full provider
 * session.
 */
function readAllowedTools(provider: AnthropicDirectProvider): readonly string[] | undefined {
  const internals = provider as unknown as {
    permissions?: ToolPermissionConfig;
  };
  return internals.permissions?.allowedTools;
}

/**
 * Read the composeExecutor stored on the provider.
 * After the C2 fix, executors live directly on the provider (used to build
 * per-query dispatchers) rather than inside a shared dispatcher instance.
 */
function readComposeExecutor(provider: AnthropicDirectProvider): ComposeExecutor | undefined {
  const internals = provider as unknown as {
    composeExecutor?: ComposeExecutor;
  };
  return internals.composeExecutor;
}

describe('parseProvider — Agent tool allowlist wiring (PR #84)', () => {
  it('returns undefined for provider === undefined', () => {
    expect(parseProvider(undefined)).toBeUndefined();
  });

  it("'anthropic' is a silent alias for anthropic-direct", () => {
    const provider = parseProvider('anthropic');
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
  });

  it('throws on an unknown provider, listing the valid set', () => {
    expect(() => parseProvider('bogus')).toThrow(/Invalid --provider value/);
    expect(() => parseProvider('bogus')).toThrow(/anthropic-direct/);
  });

  it("anthropic-direct without a subagentExecutor: allowlist === BUILTIN + MEMORY + AWARENESS + exit_plan_mode (no 'agent')", () => {
    const provider = parseProvider('anthropic-direct');
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
    const allowed = readAllowedTools(provider as AnthropicDirectProvider);
    // Awareness tools (`get_runtime_state`) are always-on — every provider
    // registers their handlers unconditionally, so the allowlist must include
    // them or the dispatcher permission gate rejects the registered handler.
    // `exit_plan_mode` is registered only in plan mode but its name is statically
    // present in the allowlist (the list is snapshotted at construction).
    expect(allowed).toEqual([
      ...BUILTIN_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...AWARENESS_TOOL_NAMES,
      EXIT_PLAN_MODE_TOOL_NAME,
    ]);
    expect(allowed).toContain('get_runtime_state');
    expect(allowed).toContain('exit_plan_mode');
    expect(allowed).not.toContain('agent');
  });

  it("anthropic-direct with a subagentExecutor: allowlist contains all builtins, memory tools, and 'agent'", () => {
    // parseProvider only forwards the executor to the provider constructor,
    // so a structural stub is sufficient — we never invoke it here.
    const subagentExecutor = {} as unknown as SubagentExecutor;
    const provider = parseProvider('anthropic-direct', { subagentExecutor });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const allowed = readAllowedTools(provider as AnthropicDirectProvider);
    expect(allowed).toBeDefined();
    const list = allowed as readonly string[];

    // All builtins survive.
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(list).toContain(name);
    }

    for (const name of MEMORY_TOOL_NAMES) {
      expect(list).toContain(name);
    }

    // 'agent' is added exactly once and the total length matches.
    expect(list.filter((n) => n === 'agent')).toHaveLength(1);
    expect(list).toHaveLength(
      // builtins + memory + awareness + exit_plan_mode + agent
      BUILTIN_TOOL_NAMES.length + MEMORY_TOOL_NAMES.length + AWARENESS_TOOL_NAMES.length + 1 + 1,
    );
  });

  it("uses lowercase 'agent', not 'Agent' (case-sensitive permission gate)", () => {
    const subagentExecutor = {} as unknown as SubagentExecutor;
    const provider = parseProvider('anthropic-direct', { subagentExecutor });
    const allowed = readAllowedTools(provider as AnthropicDirectProvider) as readonly string[];

    expect(allowed.includes('agent')).toBe(true);
    expect(allowed.includes('Agent')).toBe(false);
  });
});

describe("parseProvider — Compose tool allowlist wiring (PR #185)", () => {
  it("without a composeExecutor: 'compose' is absent from allowedTools", () => {
    const provider = parseProvider('anthropic-direct');
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
    const allowed = readAllowedTools(provider as AnthropicDirectProvider);
    expect(allowed).not.toContain('compose');
  });

  it("with a composeExecutor: 'compose' is present in allowedTools", () => {
    // Structural stub is sufficient — parseProvider only forwards the reference.
    const composeExecutor = {} as unknown as ComposeExecutor;
    const provider = parseProvider('anthropic-direct', { composeExecutor });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const allowed = readAllowedTools(provider as AnthropicDirectProvider);
    expect(allowed).toBeDefined();
    expect(allowed).toContain('compose');
  });

  it("executor reference identity is preserved through to the AnthropicDirectProvider dispatcher", () => {
    const composeExecutor = {} as unknown as ComposeExecutor;
    const provider = parseProvider('anthropic-direct', { composeExecutor });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);

    const stored = readComposeExecutor(provider as AnthropicDirectProvider);
    // The exact same object reference must be wired through — not a copy.
    expect(stored).toBe(composeExecutor);
  });
});

describe('parseProvider — openai-compatible wiring (slice 4)', () => {
  function readOpenAIAllowedTools(provider: OpenAICompatibleProvider): readonly string[] | undefined {
    const internals = provider as unknown as {
      providerOpts?: { permissions?: ToolPermissionConfig };
    };
    return internals.providerOpts?.permissions?.allowedTools;
  }

  it("'openai' constructs an OpenAICompatibleProvider", () => {
    const provider = parseProvider('openai');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("'openai-compatible' is a long-form alias for the same provider", () => {
    const provider = parseProvider('openai-compatible');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('lists openai/openai-compatible in the invalid-value error', () => {
    try {
      parseProvider('bogus');
      expect.fail('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/openai/);
      expect(msg).toMatch(/openai-compatible/);
    }
  });

  it('base allowlist matches anthropic-direct shape (builtins + memory + awareness tools)', () => {
    const provider = parseProvider('openai');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    const allowed = readOpenAIAllowedTools(provider as OpenAICompatibleProvider);
    expect(allowed).toEqual([
      ...BUILTIN_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...AWARENESS_TOOL_NAMES,
      EXIT_PLAN_MODE_TOOL_NAME,
    ]);
    expect(allowed).toContain('get_runtime_state');
    expect(allowed).toContain('exit_plan_mode');
    expect(allowed).not.toContain('agent');
    expect(allowed).not.toContain('skill');
    expect(allowed).not.toContain('compose');
  });

  it("adds 'agent' to allowlist when subagentExecutor is provided", () => {
    const subagentExecutor = {} as unknown as SubagentExecutor;
    const provider = parseProvider('openai', { subagentExecutor });
    const allowed = readOpenAIAllowedTools(provider as OpenAICompatibleProvider);
    expect(allowed).toContain('agent');
  });

  it("adds 'skill' to allowlist when skillExecutor is provided", () => {
    const skillExecutor = {} as unknown as SkillExecutor;
    const provider = parseProvider('openai', { skillExecutor });
    const allowed = readOpenAIAllowedTools(provider as OpenAICompatibleProvider);
    expect(allowed).toContain('skill');
  });

  it("adds 'compose' to allowlist when composeExecutor is provided", () => {
    const composeExecutor = {} as unknown as ComposeExecutor;
    const provider = parseProvider('openai', { composeExecutor });
    const allowed = readOpenAIAllowedTools(provider as OpenAICompatibleProvider);
    expect(allowed).toContain('compose');
  });

  it('all executors together: allowlist contains agent, skill, compose, plus builtins+memory', () => {
    const subagentExecutor = {} as unknown as SubagentExecutor;
    const skillExecutor = {} as unknown as SkillExecutor;
    const composeExecutor = {} as unknown as ComposeExecutor;
    const provider = parseProvider('openai', {
      subagentExecutor,
      skillExecutor,
      composeExecutor,
    });
    const allowed = readOpenAIAllowedTools(provider as OpenAICompatibleProvider);
    expect(allowed).toBeDefined();
    expect(allowed).toHaveLength(
      // builtins + memory + awareness + exit_plan_mode + agent + skill + compose
      BUILTIN_TOOL_NAMES.length + MEMORY_TOOL_NAMES.length + AWARENESS_TOOL_NAMES.length + 1 + 3,
    );
    expect(allowed).toContain('agent');
    expect(allowed).toContain('skill');
    expect(allowed).toContain('compose');
    expect(allowed).toContain('get_runtime_state');
    expect(allowed).toContain('exit_plan_mode');
  });
});

describe('parseProvider — model-based auto-routing (when --provider omitted)', () => {
  it('returns undefined when both provider and model are absent (legacy default)', () => {
    expect(parseProvider(undefined)).toBeUndefined();
    expect(parseProvider(undefined, {})).toBeUndefined();
  });

  it('returns undefined for Anthropic-routed models (lets caller use its hardcoded fallback)', () => {
    // Anthropic is the legacy default — leave the caller's hardcoded
    // AnthropicDirectProvider fallback in place so executor wiring isn't
    // double-constructed.
    expect(parseProvider(undefined, { model: 'sonnet' })).toBeUndefined();
    expect(parseProvider(undefined, { model: 'claude-sonnet-4-6' })).toBeUndefined();
    expect(parseProvider(undefined, { model: 'opus_1m' })).toBeUndefined();
  });

  it('auto-routes HF-style local model ids to openai-compatible without --provider', () => {
    // The fix that lets `AFK_MODEL=mlx-community/… afk` work end-to-end:
    // without this, the CLI fallback constructs AnthropicDirectProvider
    // and the request goes to api.anthropic.com despite AFK_OPENAI_BASE_URL.
    const p1 = parseProvider(undefined, { model: 'mlx-community/Qwen3.5-35B-A3B-4bit' });
    expect(p1).toBeInstanceOf(OpenAICompatibleProvider);
    const p2 = parseProvider(undefined, { model: 'TheBloke/Llama-2-7B-GGUF' });
    expect(p2).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('auto-routes GPT/o-series ids to openai-compatible when --provider omitted', () => {
    expect(parseProvider(undefined, { model: 'gpt-4o-mini' })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(parseProvider(undefined, { model: 'o3-mini' })).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('explicit --provider always wins over the model hint', () => {
    // User passed `--provider anthropic-direct` with an openai-shaped model
    // (e.g. routing through a proxy) — honor the explicit flag.
    const p = parseProvider('anthropic-direct', { model: 'mlx-community/foo' });
    expect(p).toBeInstanceOf(AnthropicDirectProvider);
  });
});
