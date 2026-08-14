/**
 * Tests for the named-agent registry: scopes, precedence, duplicates,
 * builtins, and config-tier injection.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentRegistry } from './registry.js';
import { builtinAgents } from './builtins.js';
import { resolveAgentToolAccess } from './resolve.js';
import { CHILD_ALLOWED_TOOLS, RECON_ALLOWED_TOOLS } from '../tools/nesting.js';

const fsMocks = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMocks.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: fsMocks.readFileSync };
});

let tmp: string;
let prevAfkHome: string | undefined;

function writeAgent(dir: string, file: string, name: string, extra = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nname: ${name}\ndescription: from ${dir}\n${extra}---\nprompt for ${name}\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'afk-agents-test-'));
  prevAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = join(tmp, 'afk-home');
});

afterEach(() => {
  if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevAfkHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadAgentRegistry', () => {
  it('always contains the builtin agents', () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('research-agent')?.source).toBe('builtin');
    expect(registry.get('git-investigator')?.source).toBe('builtin');
    expect(registry.get('git-investigator')?.bashReadOnly).toBe(true);
    expect(registry.get('general-purpose')?.source).toBe('builtin');
    expect(registry.get('Explore')?.source).toBe('builtin');
    // research-agent keeps its vendored read-only contract PLUS two
    // registry-entry grants: `memory_search` (read-only archive access — see
    // the #883 test below) and the scoped git-investigator dispatch grant
    // (matches the vendored prompt frontmatter; resolve.ts turns
    // Agent(git-investigator) into nestedAgentTypes and the executor restricts
    // research-agent to dispatching only git-investigator).
    expect(registry.get('research-agent')?.definition.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'memory_search',
      'Agent(git-investigator)',
    ]);
    // Anti-runaway bound: the read-only research/review builtins carry an
    // explicit tool-use-round cap so the uncapped agent-tool dispatch path
    // cannot let them loop forever and die opaquely when cut off mid-run.
    expect(registry.get('research-agent')?.definition.maxToolUseIterations).toBe(50);
    expect(registry.get('Explore')?.definition.maxToolUseIterations).toBe(50);
    // git-investigator is a read-only git-archaeology leaf (dispatched by
    // research-agent) and must carry the same cap.
    expect(registry.get('git-investigator')?.definition.maxToolUseIterations).toBe(50);
    // general-purpose now carries a GENEROUS ceiling (not the read-only 50): a
    // full-tool multi-step worker needs headroom, but leaving it "uncapped" let
    // a busy, non-converging worker run to the 45-min wall-clock. 150 bounds a
    // runaway to the graceful capped-partial wind-down while clearing legit
    // multi-step work; opt out per-dispatch via explicit max_tool_use_iterations.
    expect(registry.get('general-purpose')?.definition.maxToolUseIterations).toBe(150);
  });

  // Drift-catcher: iterate the BUILTIN registry (not the vendored consts) so a
  // newly-added builtin that forgets its anti-runaway cap fails here.
  // Structural predicate (no hardcoded per-agent list): EVERY builtin must be
  // bounded — a builtin with an explicit `tools` allowlist is a
  // restricted/read-only leaf capped at 50; a builtin that OMITS `tools`
  // (inherit-all, the full tool surface — only general-purpose today) is the
  // multi-step worker, capped at the generous worker ceiling (150), never
  // uncapped.
  it('every builtin is bounded: read-only leaves cap at 50, the inherit-all worker at the generous ceiling', () => {
    const builtins = builtinAgents();
    // Guard the guard: ensure we actually iterated real builtins and covered
    // BOTH arms (at least one capped read-only leaf and the inherit-all worker),
    // so a future refactor that empties the map can't make this vacuously pass.
    let sawRestricted = false;
    let sawInheritAll = false;
    for (const [name, entry] of builtins) {
      const hasExplicitTools = entry.definition.tools !== undefined;
      if (hasExplicitTools) {
        sawRestricted = true;
        expect(
          entry.definition.maxToolUseIterations,
          `read-only builtin ${name} (explicit tools) is missing the anti-runaway cap`,
        ).toBe(50);
      } else {
        sawInheritAll = true;
        expect(
          entry.definition.maxToolUseIterations,
          `inherit-all builtin ${name} must carry the generous worker ceiling (never uncapped)`,
        ).toBe(150);
      }
    }
    expect(sawRestricted, 'expected ≥1 restricted read-only builtin').toBe(true);
    expect(sawInheritAll, 'expected the inherit-all worker (general-purpose)').toBe(true);
  });

  // Regression guard for #883. Asserting the registry's static `tools` array
  // is not enough: what the dispatcher enforces is the RESOLVED access set,
  // and resolution intersects the declared tokens with the child's runtime
  // pool — so a tool can be declared and still be unreachable if the pool
  // omits it. This pins the effective set on BOTH child surfaces a surveyor
  // can actually land on. `/ground-state` is enforced read-only by name
  // (RECON_ALLOWED_TOOLS); a research-agent dispatched from an ordinary parent
  // gets CHILD_ALLOWED_TOOLS. memory_search must survive both, or the memory
  // third of the recon wave silently degrades to reading files off disk.
  it('research-agent can reach memory_search on every child surface it is dispatched from (#883)', () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    const entry = registry.get('research-agent');
    expect(entry).toBeDefined();

    for (const [surface, pool] of [
      ['read-only skill child (ground-state)', RECON_ALLOWED_TOOLS],
      ['ordinary child', CHILD_ALLOWED_TOOLS],
    ] as const) {
      const resolved = resolveAgentToolAccess(entry!, [...pool]);
      expect(resolved.allowedTools, `memory_search unreachable on ${surface}`).toContain(
        'memory_search',
      );
      // The grant must not have widened the read-only contract on the way in.
      for (const forbidden of ['write_file', 'edit_file', 'bash', 'memory_update']) {
        expect(resolved.allowedTools, `${forbidden} leaked on ${surface}`).not.toContain(forbidden);
      }
    }
  });

  // The other half of #883. The test above proves the grant is mechanically
  // REACHABLE; this proves the agent is TOLD it has it. The vendored body is
  // byte-pinned upstream and asserts a closed allowlist ("Your tool surface is
  // a hard allowlist enforced by Claude Code: Read, Grep, Glob, WebFetch,
  // WebSearch"), so a grant made only in `tools:` is inert — the surveyor reads
  // its prompt, believes it has five tools, and never calls the sixth. That is
  // exactly what shipped: #883 was verified at the tool-access layer only, and
  // the observable behaviour did not change.
  it('tells research-agent about every registry grant beyond its vendored allowlist (#883)', async () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    const entry = registry.get('research-agent');
    expect(entry).toBeDefined();

    const { researchAgent } = await import('../../skills/_agents/index.js');
    const prompt = entry!.definition.prompt;

    // Anything granted at the registry entry but absent from the vendored
    // allowlist is a tool the prompt does not otherwise account for.
    const extras = (entry!.definition.tools ?? []).filter(
      (t) => !researchAgent.allowedTools.includes(t as never),
    );
    expect(extras.length).toBeGreaterThan(0);
    for (const tool of extras) {
      expect(prompt, `prompt never mentions granted tool ${tool}`).toContain(tool);
    }

    // The reconciliation must explicitly override the body's closed-allowlist
    // claim, not merely append a name the earlier sentence still contradicts.
    expect(prompt).toMatch(/superseded by this section/);
    // And it must not have relaxed the read-only contract on the way through.
    expect(prompt).toMatch(/no Edit, no Write, no Bash, no mutation/);
  });

  it('strips vendored frontmatter from builtin prompts (body-only system prompt)', () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    for (const name of ['research-agent', 'git-investigator']) {
      const prompt = registry.get(name)?.definition.prompt ?? '';
      expect(prompt.startsWith('---')).toBe(false);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it('scans user scope (~/.afk/agents) recursively', () => {
    const userDir = join(tmp, 'afk-home', 'agents', 'review');
    writeAgent(userDir, 'security.md', 'security-reviewer');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('security-reviewer')?.source).toBe('user');
    expect(registry.get('security-reviewer')?.filePath).toBe(join(userDir, 'security.md'));
  });

  it('project scope shadows user scope; .afk/agents shadows .claude/agents', () => {
    const proj = join(tmp, 'proj');
    writeAgent(join(tmp, 'afk-home', 'agents'), 'a.md', 'shadowed');
    writeAgent(join(proj, '.claude', 'agents'), 'a.md', 'shadowed');
    writeAgent(join(proj, '.claude', 'agents'), 'cc-only.md', 'cc-only');
    writeAgent(join(proj, '.afk', 'agents'), 'a.md', 'shadowed');

    const registry = loadAgentRegistry({ cwd: proj, warn: () => {} });
    const winner = registry.get('shadowed');
    expect(winner?.source).toBe('project');
    expect(winner?.filePath).toBe(join(proj, '.afk', 'agents', 'a.md'));
    // Claude Code compat dir is read when not shadowed
    expect(registry.get('cc-only')?.filePath).toBe(join(proj, '.claude', 'agents', 'cc-only.md'));
  });

  it('user/project files shadow builtins by name', () => {
    writeAgent(join(tmp, 'afk-home', 'agents'), 'r.md', 'research-agent');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('research-agent')?.source).toBe('user');
  });

  describe('built-in shadow warning', () => {
    it('warns when a user file displaces a tool-restricted builtin, and still lets it win', () => {
      const warn = vi.fn();
      const userDir = join(tmp, 'afk-home', 'agents');
      writeAgent(userDir, 'r.md', 'research-agent', 'tools: Bash, Write\n');

      const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      // Precedence is deliberately unchanged — the warning is advisory only.
      expect(registry.get('research-agent')?.source).toBe('user');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('overrides built-in agent "research-agent"'),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(userDir, 'r.md')));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('restricts which tools it may use'));
    });

    it('names the read-only bash gate when the displaced builtin carries bashReadOnly', () => {
      const warn = vi.fn();
      writeAgent(join(tmp, 'proj', '.afk', 'agents'), 'g.md', 'git-investigator', 'tools: Bash\n');

      loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('gates bash to read-only commands'),
      );
    });

    it('emits no restriction suffix when the displaced builtin carries neither tools nor bashReadOnly', () => {
      // general-purpose is the only builtin with no `tools` allowlist and no
      // bashReadOnly gate, so it is the sole builtin that exercises the empty
      // `restriction` branch (registry.ts:144-149) — every other builtin hits
      // one of the two non-empty arms already covered above.
      const warn = vi.fn();
      const userDir = join(tmp, 'afk-home', 'agents');
      writeAgent(userDir, 'gp.md', 'general-purpose');

      loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      const filePath = join(userDir, 'gp.md');
      expect(warn).toHaveBeenCalledWith(
        `[afk] agents: ${filePath} overrides built-in agent "general-purpose"`,
      );
      const shadowMessage = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('overrides built-in agent "general-purpose"'));
      expect(shadowMessage).toContain('overrides built-in agent "general-purpose"');
      expect(shadowMessage).not.toContain('restricts');
      expect(shadowMessage).not.toContain('replaces');
    });

    it('warns when the config tier displaces a builtin', () => {
      const warn = vi.fn();
      loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn,
        configAgents: { 'research-agent': { description: 'mine', prompt: 'p' } },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AgentSessionConfig.agents overrides built-in agent'),
      );
    });

    it('names every shadowing file, not just the first — the tier that wins warns too', () => {
      const warn = vi.fn();
      const userDir = join(tmp, 'afk-home', 'agents');
      const projectDir = join(tmp, 'proj', '.afk', 'agents');
      writeAgent(userDir, 'r.md', 'research-agent', 'tools: Read\n');
      writeAgent(projectDir, 'r.md', 'research-agent', 'tools: Bash, Write\n');

      const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      // The project file wins, so ITS broader `tools:` are the ones in effect.
      // A warning naming only the lower-precedence user file would send the
      // operator to edit a file that no longer decides anything.
      expect(registry.get('research-agent')?.filePath).toBe(join(projectDir, 'r.md'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(userDir, 'r.md')));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(projectDir, 'r.md')));
      const shadowWarnings = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('overrides built-in agent'));
      expect(shadowWarnings).toHaveLength(2);
    });

    it('stays silent for names that collide with no builtin', () => {
      const warn = vi.fn();
      writeAgent(join(tmp, 'afk-home', 'agents'), 'x.md', 'my-own-agent');
      loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('overrides built-in agent'));
    });
  });

  it('warns on same-scope duplicate names and keeps the first (sorted) file', () => {
    const warn = vi.fn();
    const dir = join(tmp, 'proj', '.afk', 'agents');
    writeAgent(dir, 'a-first.md', 'dupe');
    writeAgent(dir, 'z-second.md', 'dupe');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });
    expect(registry.get('dupe')?.filePath).toBe(join(dir, 'a-first.md'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate agent name'));
  });

  it('warns when a name is defined in both project dirs (.claude + .afk); .afk still wins', () => {
    const warn = vi.fn();
    const proj = join(tmp, 'proj');
    writeAgent(join(proj, '.claude', 'agents'), 'dup.md', 'both-dirs');
    writeAgent(join(proj, '.afk', 'agents'), 'dup.md', 'both-dirs');
    const registry = loadAgentRegistry({ cwd: proj, warn });
    // Precedence unchanged: .afk wins the project tier.
    expect(registry.get('both-dirs')?.filePath).toBe(join(proj, '.afk', 'agents', 'dup.md'));
    // ...but the cross-directory override is no longer silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overrides'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate agent name'));
  });

  it('does not warn on override when a project name lives in only one project dir', () => {
    const warn = vi.fn();
    const proj = join(tmp, 'proj');
    writeAgent(join(proj, '.claude', 'agents'), 'cc.md', 'cc-only-agent');
    writeAgent(join(proj, '.afk', 'agents'), 'afk.md', 'afk-only-agent');
    loadAgentRegistry({ cwd: proj, warn });
    // Narrowed to the cross-directory-distinct wording: the bare substring
    // 'overrides' also matches the builtin-shadow message ("… overrides
    // built-in agent …"), which carries no `scope — ` clause, so it no longer
    // isolates the cross-dir path. The cross-dir duplicate message uniquely
    // matches `scope — .* overrides ` (registry.ts:202-203); the same-dir
    // duplicate message instead reads `scope — keeping` (no ` overrides `).
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/scope — .* overrides /));
  });

  it('skips malformed files without failing the scan', () => {
    const warn = vi.fn();
    const dir = join(tmp, 'proj', '.afk', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here');
    writeAgent(dir, 'ok.md', 'works');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });
    expect(registry.get('works')).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  it('configAgents take highest precedence', () => {
    writeAgent(join(tmp, 'proj', '.afk', 'agents'), 'a.md', 'contested');
    const registry = loadAgentRegistry({
      cwd: join(tmp, 'proj'),
      warn: () => {},
      configAgents: {
        contested: { description: 'programmatic', prompt: 'config prompt' },
      },
    });
    expect(registry.get('contested')?.source).toBe('config');
    expect(registry.get('contested')?.definition.prompt).toBe('config prompt');
  });

  it('missing scope directories are silently fine', () => {
    const warn = vi.fn();
    const registry = loadAgentRegistry({ cwd: join(tmp, 'nonexistent-proj'), warn });
    expect(registry.size).toBeGreaterThanOrEqual(4); // builtins only
    // no read-failure warnings for absent dirs
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cannot read'));
  });

  describe('terminal-injection defense (#747)', () => {
    // A hostile repo could place a file under .claude/agents/ or .afk/agents/
    // whose *path* contains ANSI escape sequences (e.g. via a symlink or a
    // filename with embedded ESC bytes on filesystems that allow them).  The
    // registry warns about such files (malformed frontmatter, duplicates, etc.),
    // and those warnings must not pass raw ESC/C0 bytes to the terminal.
    //
    // We exercise every warn call-site that receives a filePath:
    //   • cannot-read (line 180)
    //   • parse-error forwarded through parseAgentMarkdown callback (line 183)
    //   • same-scope duplicate — keeping/ignoring paths (lines 188-191)
    //   • cross-directory duplicate — file overrides file (lines 202-205)
    //   • ignored-frontmatter-keys (lines 222-224)
    //   • warnIfShadowsBuiltin via scanScope (line 209)
    const ESC = '\x1B';
    const RAW_ESC_RE = /[\x00-\x1F\x7F-\x9F]/;

    it('cannot-read warning sanitizes control bytes included in the filesystem error', () => {
      const warn = vi.fn();
      const dir = join(tmp, 'proj', '.afk', 'agents');
      const poisonedName = `evil${ESC}[2J.md`;
      writeAgent(dir, poisonedName, 'unreadable');
      fsMocks.readFileSync.mockImplementationOnce(() => {
        // Node filesystem errors include the path, so the error text is an
        // independent injection surface from the separately rendered path.
        throw new Error(`EACCES: cannot read '${join(dir, poisonedName)}'`);
      });

      loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      const warnings = warn.mock.calls.map(([msg]) => String(msg));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('cannot read');
      for (const msg of warnings) {
        expect(RAW_ESC_RE.test(msg), `raw control byte in warning: ${JSON.stringify(msg)}`).toBe(
          false,
        );
      }
    });

    it('same-scope duplicate warning never emits raw ESC bytes from filenames', () => {
      // Write two files with the same agent name so the duplicate-in-scope
      // warning fires. The filePath itself is real (can't embed ESC in actual
      // filenames on macOS/Linux in practice), so we verify via the warn
      // callback that paths it receives are sanitized before they reach a
      // terminal. We intercept warn AFTER registry wraps it and verify the
      // already-sanitized output.
      const warn = vi.fn();
      const dir = join(tmp, 'proj', '.afk', 'agents');
      writeAgent(dir, 'a-first.md', 'esc-dupe');
      writeAgent(dir, 'z-second.md', 'esc-dupe');

      loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });

      const dupeWarnings = warn.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.includes('duplicate agent name'));
      expect(dupeWarnings.length).toBeGreaterThan(0);
      for (const msg of dupeWarnings) {
        expect(RAW_ESC_RE.test(msg), `raw control byte in duplicate warning: ${JSON.stringify(msg)}`).toBe(false);
      }
    });

    it('builtin-shadow warning strips ESC sequences injected via a filename-derived origin string', () => {
      // This is the primary attack vector: a hostile .afk/agents/ file whose
      // path (used as the `origin` parameter to warnIfShadowsBuiltin) embeds
      // ANSI escape sequences.  We simulate it by passing the tainted path via
      // pluginAgents.source (which uses the same warnIfShadowsBuiltin codepath
      // with the source string as origin).
      const POISON = `${ESC}[31mINJECTED${ESC}[0m`; // red color injection
      const warn = vi.fn();
      loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn,
        pluginAgents: [
          {
            name: 'git-investigator',
            source: `plugin:${POISON}`,
            definition: { description: 'evil', prompt: 'p' },
          },
        ],
      });
      const msgs = warn.mock.calls.map(([m]) => String(m));
      expect(msgs.some((m) => m.includes('overrides built-in agent'))).toBe(true);
      for (const msg of msgs) {
        expect(RAW_ESC_RE.test(msg), `raw ESC in warning: ${JSON.stringify(msg)}`).toBe(false);
        // The visible injected text must also be absent (sanitizeForDisplay trims it)
        expect(msg).not.toContain(ESC);
      }
    });
  });

  describe('pluginAgents scope', () => {
    it('merges pluginAgents into the registry with their plugin source', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'demo:helper',
            source: 'plugin:demo',
            definition: { description: 'd', prompt: 'p' },
            filePath: '/x/agents/helper.md',
          },
        ],
      });
      expect(registry.get('demo:helper')?.source).toBe('plugin:demo');
      expect(registry.get('demo:helper')?.filePath).toBe('/x/agents/helper.md');
    });

    it('namespaced plugin agents coexist with bare builtins (no shadow)', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'demo:research-agent',
            source: 'plugin:demo',
            definition: { description: 'd', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('research-agent')?.source).toBe('builtin');
      expect(registry.get('demo:research-agent')?.source).toBe('plugin:demo');
    });

    it('plugin agents shadow builtins by name (plugin > builtin)', () => {
      const warn = vi.fn();
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn,
        pluginAgents: [
          {
            name: 'research-agent',
            source: 'plugin:x',
            definition: { description: 'plugin override', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('research-agent')?.source).toBe('plugin:x');
      // The plugin tier's shadow warning is a distinct call site (registry.ts:255)
      // from the file-scope scan (registry.ts:209) — its origin is a
      // `plugin agent (<source>)` label, not a file path. Assert both stable
      // substrings land in the SAME message so this call site's coverage
      // can't silently regress to only one half matching.
      const shadowMessage = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('overrides built-in agent'));
      expect(shadowMessage).toContain('plugin agent (');
      expect(shadowMessage).toContain('overrides built-in agent');
    });

    it('user scope shadows a plugin agent of the same name (user > plugin)', () => {
      writeAgent(join(tmp, 'afk-home', 'agents'), 's.md', 'shared-name');
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'shared-name',
            source: 'plugin:x',
            definition: { description: 'plugin', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('shared-name')?.source).toBe('user');
    });

    it('config scope shadows a plugin agent of the same name (config > plugin)', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'p:dupe',
            source: 'plugin:p',
            definition: { description: 'plugin', prompt: 'p' },
          },
        ],
        configAgents: { 'p:dupe': { description: 'config', prompt: 'c' } },
      });
      expect(registry.get('p:dupe')?.source).toBe('config');
    });
  });
});
