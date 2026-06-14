/**
 * Tests for user-space skill scanner (~/.afk/skills/).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { _resetRegistry, listSkills, getSkill } from './index.js';

// Mock getSkillsDir and getMemoryDir to use a temp directory
const tempDir = join(tmpdir(), `afk-user-skills-test-${Date.now()}`);
const skillsDir = join(tempDir, 'skills');
const memoryDir = join(tempDir, 'memory');
vi.mock('../paths.js', () => ({
  getSkillsDir: () => skillsDir,
  getMemoryDir: () => memoryDir,
}));

// Mock SubagentManager so we can inspect forkSubagent call args without
// actually forking a real LLM session.
//
// Invariant: vi.mock factories are hoisted above imports by vitest. To share
// mock fn references with test bodies, use vi.hoisted() — it runs inside the
// hoisting zone and returns values that are stable across both the factory
// and the test module scope.
const { mockRunToResult, mockForkSubagent } = vi.hoisted(() => {
  const mockRunToResult = vi.fn().mockResolvedValue({ text: 'ok' });
  const mockForkSubagent = vi.fn().mockResolvedValue({ runToResult: mockRunToResult });
  return { mockRunToResult, mockForkSubagent };
});

vi.mock('../agent/subagent.js', () => {
  class MockSubagentManager {
    forkSubagent = mockForkSubagent;
  }
  return { SubagentManager: MockSubagentManager };
});

// Import after mocks are set up
const { scanAndRegisterUserSkills, validateSkillName } = await import(
  './user-skills.js'
);

describe('User-space skill scanner', () => {
  beforeEach(() => {
    _resetRegistry();
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('returns 0 when skills dir does not exist', () => {
    rmSync(skillsDir, { recursive: true, force: true });
    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('returns 0 when skills dir is empty', () => {
    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('discovers and registers a valid SKILL.md', () => {
    const skillDir = join(skillsDir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: A test user skill
---

You are a helpful assistant that does the thing.
`,
    );

    const count = scanAndRegisterUserSkills();
    expect(count).toBe(1);
    expect(listSkills()).toContain('my-skill');

    const skill = getSkill('my-skill');
    expect(skill.description).toBe('A test user skill');
  });

  it('discovers multiple skills', () => {
    for (const name of ['skill-a', 'skill-b', 'skill-c']) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---
name: ${name}
description: Skill ${name}
---

System prompt for ${name}.
`,
      );
    }

    const count = scanAndRegisterUserSkills();
    expect(count).toBe(3);
    for (const name of ['skill-a', 'skill-b', 'skill-c']) {
      expect(listSkills()).toContain(name);
    }
  });

  it('skips directories without SKILL.md', () => {
    const dir = join(skillsDir, 'no-skill-md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Not a skill');

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('skips SKILL.md without valid frontmatter', () => {
    const dir = join(skillsDir, 'bad-frontmatter');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'No frontmatter here, just text.');

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('skips SKILL.md missing name field', () => {
    const dir = join(skillsDir, 'no-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
description: Has description but no name
---

Body text.
`,
    );

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('skips SKILL.md missing description field', () => {
    const dir = join(skillsDir, 'no-desc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: no-desc
---

Body text.
`,
    );

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('skips SKILL.md with empty body', () => {
    const dir = join(skillsDir, 'empty-body');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: empty-body
description: Has frontmatter but no body
---
`,
    );

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('skips dot-prefixed and underscore-prefixed directories', () => {
    for (const name of ['.hidden', '_internal']) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---
name: ${name}
description: Should be skipped
---

Body.
`,
      );
    }

    expect(scanAndRegisterUserSkills()).toBe(0);
  });

  it('registered handler is a function', () => {
    const dir = join(skillsDir, 'callable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: callable
description: A callable skill
---

You are a test assistant.
`,
    );

    scanAndRegisterUserSkills();
    const skill = getSkill('callable');
    expect(typeof skill.handler).toBe('function');
  });

  it('tags discovered skills with origin: user', async () => {
    const { registerSkill: register } = await import('./index.js');
    register({
      name: 'pre-existing-vendored',
      description: 'A vendored skill registered before the scan',
      handler: async () => undefined,
    });
    const dir = join(skillsDir, 'tagged');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: tagged
description: A user-authored skill
---

System prompt.
`,
    );

    scanAndRegisterUserSkills();
    expect(getSkill('tagged').origin).toBe('user');
    expect(getSkill('pre-existing-vendored').origin).toBeUndefined();
  });

  it('falls back to user:<name> when bare name collides with a vendored skill', async () => {
    const { registerSkill: register } = await import('./index.js');
    register({
      name: 'mint',
      description: 'Vendored mint stand-in',
      handler: async () => undefined,
    });

    const dir = join(skillsDir, 'mint');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: mint
description: User-authored mint replacement
---

You are a custom mint.
`,
    );

    const count = scanAndRegisterUserSkills();
    expect(count).toBe(1);
    // Vendored skill keeps the bare name, user skill is reachable under user:mint.
    expect(getSkill('mint').description).toBe('Vendored mint stand-in');
    expect(getSkill('user:mint').description).toBe('User-authored mint replacement');
    expect(getSkill('user:mint').origin).toBe('user');
  });

  it('parses argument-hint and harvests body flags from frontmatter', () => {
    const dir = join(skillsDir, 'with-hints');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: with-hints
description: Demonstrates argument-hint and flags surfacing
argument-hint: "<target> [--dry-run]"
---

You can run with --dry-run to preview, or --verbose for full output.
`,
    );

    scanAndRegisterUserSkills();
    const skill = getSkill('with-hints');
    expect(skill.argumentHint).toBe('<target> [--dry-run]');
    expect(skill.flags).toEqual(['--dry-run', '--verbose']);
  });
});

// ---------------------------------------------------------------------------
// Fix B — validateSkillName spec-conformant name validation
// ---------------------------------------------------------------------------

describe('validateSkillName (agentskills.io v1 spec)', () => {
  it('accepts valid lowercase-hyphenated names', () => {
    const cases = ['pdf-processing', 'data-analysis', 'code-review', 'abc', 'a1b2', 'my-skill'];
    for (const name of cases) {
      expect(validateSkillName(name, name), `expected valid: ${name}`).toEqual({ valid: true });
    }
  });

  it('rejects uppercase letters', () => {
    const r = validateSkillName('PDF-Processing', 'PDF-Processing');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/spec pattern/);
  });

  it('rejects leading hyphen', () => {
    const r = validateSkillName('-pdf', '-pdf');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/spec pattern/);
  });

  it('rejects trailing hyphen', () => {
    const r = validateSkillName('pdf-', 'pdf-');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/spec pattern/);
  });

  it('rejects consecutive hyphens', () => {
    const r = validateSkillName('pdf--processing', 'pdf--processing');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/spec pattern/);
  });

  it('rejects names longer than 64 characters', () => {
    const long = 'a'.repeat(65);
    const r = validateSkillName(long, long);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/1–64 characters/);
  });

  it('rejects empty names', () => {
    const r = validateSkillName('', '');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/1–64 characters/);
  });

  it('rejects name not matching parent directory name', () => {
    const r = validateSkillName('my-skill', 'my-skills');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/does not match parent directory name/);
  });

  it('accepts a 64-character valid name', () => {
    // 64 chars: 'a' repeated 31 times + '-' + 'b' repeated 32 times = 64
    const name = 'a'.repeat(31) + '-' + 'b'.repeat(32);
    expect(name.length).toBe(64);
    expect(validateSkillName(name, name)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// Fix B — scanner-level name validation with stderr warning
// ---------------------------------------------------------------------------

describe('scanSkillsFromDir name validation warnings', () => {
  beforeEach(() => {
    _resetRegistry();
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
    // Only restore spies created in this describe block.
    // Do NOT call vi.restoreAllMocks() — that would restore process.stderr.write
    // AND invalidate the hoisted mockForkSubagent used by the SKILL_ROOT tests.
  });

  it('skips skills with uppercase name and emits a stderr warning', () => {
    const dir = join(skillsDir, 'PDF-Processing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: PDF-Processing
description: An uppercased skill
---

Body.
`,
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const count = scanAndRegisterUserSkills();
    // Capture calls BEFORE restoring so mockRestore doesn't wipe them.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();
    expect(count).toBe(0);
    expect(calls.some((msg) => msg.includes('[afk] skipping skill'))).toBe(true);
    expect(calls.some((msg) => msg.includes('PDF-Processing'))).toBe(true);
  });

  it('skips skills where name does not match dirname and warns', () => {
    // dirname = 'my-skill', but name field = 'different-skill'
    const dir = join(skillsDir, 'my-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: different-skill
description: Name/dirname mismatch
---

Body.
`,
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const count = scanAndRegisterUserSkills();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();
    expect(count).toBe(0);
    expect(calls.some((msg) => msg.includes('does not match parent directory name'))).toBe(true);
  });

  it('skips skills with description exceeding 1024 chars and warns', () => {
    const dir = join(skillsDir, 'too-long-desc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: too-long-desc
description: ${'x'.repeat(1025)}
---

Body.
`,
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const count = scanAndRegisterUserSkills();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();
    expect(count).toBe(0);
    expect(calls.some((msg) => msg.includes('description exceeds'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix A — SKILL_ROOT injection into forked subagent env
//
// These fixtures use `context: fork` because SKILL_ROOT-as-subagent-env only
// applies to the fork path (the handler injects it). Load-mode skills expand
// `${SKILL_ROOT}` in-place into the body instead — covered separately below.
// ---------------------------------------------------------------------------

describe('SKILL_ROOT injection (Fix A — fork path)', () => {
  beforeEach(() => {
    _resetRegistry();
    mkdirSync(skillsDir, { recursive: true });
    mockForkSubagent.mockClear();
    mockRunToResult.mockClear();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('passes SKILL_ROOT env pointing to the skill dir when handler is invoked', async () => {
    const skillName = 'pdf-processing';
    const dir = join(skillsDir, skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: ${skillName}
description: Processes PDF files
context: fork
---

You process PDF files. Scripts are in \${SKILL_ROOT}/scripts/.
`,
    );

    scanAndRegisterUserSkills();
    const skill = getSkill(skillName);

    // Invoke the handler — SubagentManager is mocked so no LLM call happens.
    await skill.handler('process this PDF', undefined, undefined);

    expect(mockForkSubagent).toHaveBeenCalledOnce();
    const callArgs = mockForkSubagent.mock.calls[0]?.[0] as {
      config?: { env?: Record<string, string> };
    };
    expect(callArgs?.config?.env?.['SKILL_ROOT']).toBe(dir);
  });

  it('uses SkillExecutionContext.defaultSubagentModel for forked user skills', async () => {
    const skillName = 'model-aware';
    const dir = join(skillsDir, skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: ${skillName}
description: Uses the inherited subagent model
context: fork
---

You run on the configured child model.
`,
    );

    scanAndRegisterUserSkills();
    const skill = getSkill(skillName);

    await skill.handler('run', undefined, {
      defaultModel: 'opus',
      defaultSubagentModel: 'haiku',
    });

    expect(mockForkSubagent).toHaveBeenCalledOnce();
    const callArgs = mockForkSubagent.mock.calls[0]?.[0] as {
      config?: { model?: string };
    };
    expect(callArgs?.config?.model).toBe('haiku');
  });

  it('SKILL_ROOT resolves to the correct absolute directory path', async () => {
    const skillName = 'data-analysis';
    const dir = join(skillsDir, skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: ${skillName}
description: Runs data analysis
context: fork
---

You analyze data.
`,
    );

    scanAndRegisterUserSkills();
    const skill = getSkill(skillName);
    await skill.handler('analyze this', undefined, undefined);

    const callArgs = mockForkSubagent.mock.calls[0]?.[0] as {
      config?: { env?: Record<string, string> };
    };
    // Must be an absolute path that ends with the skill directory name.
    const skillRoot = callArgs?.config?.env?.['SKILL_ROOT'] ?? '';
    expect(skillRoot).toBeTruthy();
    expect(skillRoot.endsWith(skillName)).toBe(true);
    // Must be absolute (starts with /).
    expect(skillRoot.startsWith('/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// context: load default (2026-06 load-by-default flip)
//
// Disk skills now honor the SKILL.md `context:` field with the same default as
// plugin skills: in-context LOAD unless `context: fork` is explicit. Load mode
// is wired by setting `context: 'load'` + `loadBody` (with `${SKILL_ROOT}`
// expanded in-place) on the registered metadata, so the SkillExecutor's load
// path returns the body to the current agent instead of forking.
// ---------------------------------------------------------------------------

describe('context: load default', () => {
  beforeEach(() => {
    _resetRegistry();
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  function writeSkill(name: string, frontmatterExtra: string, body: string): string {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: a ${name} skill${frontmatterExtra}\n---\n\n${body}\n`,
    );
    return dir;
  }

  it('a SKILL.md WITHOUT a context field registers as load (context=load + loadBody)', () => {
    writeSkill('leaf-skill', '', 'Do the leaf thing.');
    scanAndRegisterUserSkills();
    const skill = getSkill('leaf-skill');
    expect(skill.context).toBe('load');
    expect(skill.loadBody).toContain('Do the leaf thing.');
  });

  it('context: load is honored explicitly', () => {
    writeSkill('explicit-load', '\ncontext: load', 'Loaded body.');
    scanAndRegisterUserSkills();
    const skill = getSkill('explicit-load');
    expect(skill.context).toBe('load');
    expect(skill.loadBody).toContain('Loaded body.');
  });

  it('context: fork leaves context unset (routes to the forking handler) and sets no loadBody', () => {
    writeSkill('forker', '\ncontext: fork', 'Forked body.');
    scanAndRegisterUserSkills();
    const skill = getSkill('forker');
    // Fork disk skills stay on the inline→handler path; the executor's own
    // fork branch expects prompts/system.md, which disk skills do not have.
    expect(skill.context).toBeUndefined();
    expect(skill.loadBody).toBeUndefined();
  });

  it('expands ${SKILL_ROOT} and $SKILL_ROOT in the load body to the absolute skill dir', () => {
    const dir = writeSkill(
      'rooted',
      '',
      'Run "${SKILL_ROOT}/scripts/go.sh" then $SKILL_ROOT/bin/x.',
    );
    scanAndRegisterUserSkills();
    const skill = getSkill('rooted');
    expect(skill.loadBody).toContain(`"${dir}/scripts/go.sh"`);
    expect(skill.loadBody).toContain(`${dir}/bin/x`);
    expect(skill.loadBody).not.toContain('$SKILL_ROOT');
    expect(skill.loadBody).not.toContain('${SKILL_ROOT}');
  });

  it('an unknown context value (typo) falls through to the load default', () => {
    writeSkill('typoed', '\ncontext: lod', 'Body.');
    scanAndRegisterUserSkills();
    const skill = getSkill('typoed');
    expect(skill.context).toBe('load');
    expect(skill.loadBody).toContain('Body.');
  });
});
