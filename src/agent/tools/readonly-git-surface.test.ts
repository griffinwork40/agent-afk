/**
 * Prompt/grant reconciliation for the AFK_READONLY_GIT_TOOL swap: the
 * git-investigator's pinned prompt says "You have Bash", so the runtime must
 * (a) tell it about git_read at registry composition and (b) surface the
 * git_read hint on the FIRST denied bash call, which dies at the static
 * allowlist gate rather than the read-only bash gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READONLY_BASH_DISABLED_REASON,
  readOnlyBashDenialOverride,
  withGitReadSubstitution,
} from './readonly-git-surface.js';
import { GIT_READ_SUBCOMMANDS } from './git-read.policy.js';
import { builtinAgents } from '../agents/builtins.js';

const FLAG = 'AFK_READONLY_GIT_TOOL';
let saved: string | undefined;

beforeEach(() => { saved = process.env[FLAG]; });
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

function gitInvestigatorPrompt(): string {
  return builtinAgents().get('git-investigator')?.definition.prompt ?? '';
}

describe('flag off: unchanged', () => {
  beforeEach(() => { delete process.env[FLAG]; });

  it('leaves the prompt body byte-identical', () => {
    expect(withGitReadSubstitution('body')).toBe('body');
    expect(gitInvestigatorPrompt()).not.toContain('Tool substitution by this runtime');
  });

  it('keeps the generic denial for bash', () => {
    expect(readOnlyBashDenialOverride('bash', true)).toBeUndefined();
  });

  // #4059: git_read must be absent from research-agent when the flag is off —
  // the grant is strictly opt-in to preserve existing behaviour.
  it('research-agent excludes git_read from its tools array when flag is off (#4059)', () => {
    const tools = builtinAgents().get('research-agent')?.definition.tools ?? [];
    expect(tools).not.toContain('git_read');
  });

  it('research-agent prompt does not mention git_read when flag is off (#4059)', () => {
    const prompt = builtinAgents().get('research-agent')?.definition.prompt ?? '';
    expect(prompt).not.toContain('git_read');
  });
});

describe('flag on', () => {
  beforeEach(() => { process.env[FLAG] = '1'; });

  it('appends the git_read substitution note to git-investigator only', () => {
    const prompt = gitInvestigatorPrompt();
    expect(prompt).toContain('Tool substitution by this runtime');
    expect(prompt).toContain('Bash is NOT available');
    expect(prompt).toContain('"paths":["src/x.ts"]');
    expect(builtinAgents().get('research-agent')?.definition.prompt).not.toContain('Tool substitution by this runtime');
  });

  // #4059: research-agent gains git_read as a direct additive grant (not a bash
  // swap) so it can answer git questions without the nested git-investigator hop.
  it('research-agent includes git_read in its tools array (#4059)', () => {
    const tools = builtinAgents().get('research-agent')?.definition.tools ?? [];
    expect(tools).toContain('git_read');
  });

  it('research-agent git_read grant is mentioned in the composed prompt (#4059, #942)', () => {
    const prompt = builtinAgents().get('research-agent')?.definition.prompt ?? '';
    expect(prompt).toContain('git_read');
  });

  it('research-agent git_read grant preserves read-only contract: no Bash, Edit, or Write (#4059)', () => {
    const tools = builtinAgents().get('research-agent')?.definition.tools ?? [];
    expect(tools).toContain('git_read');
    for (const forbidden of ['Bash', 'bash', 'Edit', 'Write', 'edit_file', 'write_file']) {
      expect(tools, `${forbidden} must not appear in research-agent tools`).not.toContain(forbidden);
    }
  });

  it('lists every git_read subcommand in the note and the denial reason', () => {
    const note = withGitReadSubstitution('');
    for (const sub of GIT_READ_SUBCOMMANDS) {
      expect(note).toContain(sub);
      expect(READONLY_BASH_DISABLED_REASON).toContain(sub);
    }
  });

  it('overrides the denial only for bash on a read-only surface', () => {
    expect(readOnlyBashDenialOverride('bash', true)).toBe(READONLY_BASH_DISABLED_REASON);
    expect(readOnlyBashDenialOverride('bash', false)).toBeUndefined();
    expect(readOnlyBashDenialOverride('workspace_publish', true)).toBeUndefined();
  });
});
