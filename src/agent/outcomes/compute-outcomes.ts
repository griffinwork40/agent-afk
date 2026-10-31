/**
 * computeOutcomes — pure fold of a session's raw signals into OutcomesV1.
 *
 * Inputs are already-loaded data (git log range, effect-ledger rows, tool
 * events, final assistant text); this module performs no I/O. Git access
 * lives in the thin adapter git-range.ts; ledger parsing in
 * outcomes-ledger.ts.
 *
 * Contract: commit dedupe is by sha, where an abbreviated sha that is a
 * prefix of another sha is the same commit. git_log rows always win over
 * effect_ledger rows (full sha + authoritative subject); between two ledger
 * rows the longer sha wins. PRs dedupe by url (strongest action kept),
 * files by absolute path. Caps: commits 200, prs 50, files 500.
 *
 * @module agent/outcomes/compute-outcomes
 */

import { isAbsolute, resolve } from 'node:path';
import type { EffectRecord } from '../effect-ledger/types.js';
import { asString, dedupeToolEvents, parseInput, patchApplyPaths } from '../facets/derive.aggregate.js';
import type { ToolEventInput } from '../facets/schema.js';
import { parseTerminalState } from './terminal-state.js';
import {
  ledgerCommits,
  ledgerPrs,
  ledgerServices,
  settledEffects,
} from './outcomes-ledger.js';
import {
  OUTCOMES_COMMITS_CAP,
  OUTCOMES_FILES_CAP,
  OUTCOMES_PRS_CAP,
  type OutcomeCommit,
  type OutcomeSchedule,
  type OutcomesV1,
} from './outcomes-v1.schema.js';

export interface GitLogEntry {
  sha: string;
  subject: string;
  repo: string;
}

export interface ComputeOutcomesInput {
  cwd: string;
  startHead: string | null;
  endHead: string | null;
  gitLog?: readonly GitLogEntry[];
  /** Raw effect-ledger rows; malformed rows are tolerated and skipped. */
  ledgerEntries: readonly (EffectRecord | unknown)[];
  toolEvents: readonly ToolEventInput[];
  lastAssistantMessage: string | null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const SCHEDULE_TOOLS: Record<string, OutcomeSchedule['action']> = {
  create_schedule: 'create',
  update_schedule: 'update',
  cancel_schedule: 'cancel',
};

function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Dedupe commits, git_log first so it always wins a prefix collision. */
export function mergeCommits(
  gitLog: readonly OutcomeCommit[],
  ledger: readonly OutcomeCommit[],
): OutcomeCommit[] {
  const out: OutcomeCommit[] = [];
  for (const c of [...gitLog, ...ledger]) {
    const sha = c.sha.toLowerCase();
    if (!SHA_RE.test(sha)) continue;
    const idx = out.findIndex((o) => sameCommit(o.sha, sha));
    if (idx < 0) {
      out.push({ ...c, sha });
      continue;
    }
    const prev = out[idx]!;
    // git_log always wins over any existing entry (structurally enforced).
    if (c.source === 'git_log') {
      out[idx] = { ...c, sha };
      continue;
    }
    // A ledger row only upgrades another ledger row, and only to a longer sha.
    if (prev.source === 'effect_ledger' && c.source === 'effect_ledger' && sha.length > prev.sha.length) {
      out[idx] = { ...c, sha };
    }
  }
  return out;
}

/** Absolute file paths from write_file/edit_file/patch_apply tool events. */
export function filesFromToolEvents(events: readonly ToolEventInput[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string): void => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };
  for (const ev of events) {
    if (ev.isError === true) continue;
    const parsed = parseInput(ev.inputRaw ?? ev.input);
    if (FILE_WRITE_TOOLS.has(ev.toolName)) {
      const fp = asString(parsed?.['file_path']);
      if (fp) add(fp);
    } else if (ev.toolName === 'patch_apply' && parsed?.['dry_run'] !== true) {
      for (const fp of patchApplyPaths(parsed)) add(fp);
    }
  }
  return out;
}

/** Schedule ids from create/update/cancel_schedule tool events (result id, else args). */
export function schedulesFromToolEvents(events: readonly ToolEventInput[]): OutcomeSchedule[] {
  const out: OutcomeSchedule[] = [];
  for (const ev of events) {
    const action = SCHEDULE_TOOLS[ev.toolName];
    if (!action || ev.isError === true) continue;
    const result = parseInput(ev.result);
    if (result && typeof result['error'] === 'string') continue;
    const args = parseInput(ev.inputRaw ?? ev.input);
    const id =
      asString(result?.['id']) ?? asString(result?.['taskId']) ?? asString(args?.['taskId']) ?? asString(args?.['id']);
    if (!id) continue;
    if (!out.some((s) => s.id === id && s.action === action)) out.push({ id, action });
  }
  return out;
}

export function computeOutcomes(input: ComputeOutcomesInput): OutcomesV1 {
  const { cwd } = input;
  const effects = settledEffects(input.ledgerEntries);
  const events = dedupeToolEvents([...input.toolEvents]);

  const gitCommits: OutcomeCommit[] = (input.gitLog ?? []).map((g) => ({
    sha: g.sha,
    repo: g.repo,
    subject: g.subject,
    source: 'git_log',
  }));
  const journalCommits = events.flatMap((ev): OutcomeCommit[] => {
    if (ev.toolName !== 'bash' || ev.isError === true || ev.result === undefined) return [];
    const args = parseInput(ev.inputRaw ?? ev.input);
    const command = asString(args?.['command']) ?? ev.input;
    if (!command) return [];
    return ledgerCommits([{ command, result: ev.result }], cwd)
      .map((c) => ({ ...c, source: 'tool_result' as const }));
  });
  const commits = mergeCommits(gitCommits, [...ledgerCommits(effects, cwd), ...journalCommits]);

  const prs = ledgerPrs(effects); // deduped by url inside the extractor
  const files = filesFromToolEvents(events, cwd);

  return {
    schemaVersion: 1,
    cwd,
    startHead: input.startHead,
    endHead: input.endHead,
    commits: commits.slice(0, OUTCOMES_COMMITS_CAP),
    prs: prs.slice(0, OUTCOMES_PRS_CAP),
    filesChanged: files.slice(0, OUTCOMES_FILES_CAP),
    filesChangedTruncated: files.length > OUTCOMES_FILES_CAP,
    schedules: schedulesFromToolEvents(events),
    services: ledgerServices(effects),
    terminalState: input.lastAssistantMessage
      ? (parseTerminalState(input.lastAssistantMessage)?.kind ?? null)
      : null,
  };
}
