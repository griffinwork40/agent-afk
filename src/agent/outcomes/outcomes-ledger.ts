/**
 * Effect-ledger extractors for computeOutcomes (compute-outcomes.ts).
 *
 * Pure: reads already-loaded EffectRecord rows, never touches disk. Every
 * accessor is defensive — ledger rows are NDJSON from disk and may carry
 * `args`/`result` of any shape (or none), so a malformed row yields nothing
 * rather than throwing.
 *
 * @module agent/outcomes/outcomes-ledger
 */

import { isAbsolute, resolve } from 'node:path';
import type { EffectRecord } from '../effect-ledger/types.js';
import type { OutcomeCommit, OutcomePr, OutcomeService, PrAction } from './outcomes-v1.schema.js';

// `(?![\w-])` rejects `git commit-tree` / `git commits` (mirrors derive.aggregate.ts).
const COMMIT_CMD_RE = /\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|[^\s;&|"']+)\s+)?commit(?![\w-])/;
// `[main abc1234] subject`, `[detached HEAD abc1234] subject`, `[main (root-commit) abc1234] subject`.
const COMMIT_SUMMARY_RE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s+(.*)$/gm;
// `git log --oneline -1` output line: `abc1234 subject`.
const ONELINE_RE = /^([0-9a-f]{7,40}) (.+)$/m;
// `git rev-parse HEAD` output line: a bare 40-hex sha.
const FULL_SHA_LINE_RE = /^([0-9a-f]{40})$/gm;
const LEADING_CD_RE = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/;
const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;
// `gh pr merge` stdout: `✓ Merged pull request owner/repo#316 (title)`.
const MERGED_REF_RE = /Merged pull request ([\w.-]+\/[\w.-]+)#(\d+)/g;
const SERVICE_RE = /\bafk\s+service\s+(install|uninstall|start|stop|restart)\b(?:[ \t]+([A-Za-z0-9_-]+))?/g;

/** Precedence when one PR URL is seen with several actions: the strongest wins. */
const PR_ACTION_RANK: Record<PrAction, number> = { unknown: 0, update: 1, merge: 2, create: 3 };

/** A ledger row reduced to the two strings the extractors read. */
interface LedgerEffect {
  command: string;
  result: string;
}

/**
 * Flatten a ledger `result` to text. Strings pass through; object results
 * (structured tool output) contribute their string leaves one per line so
 * line-anchored stdout patterns still match.
 */
function resultText(result: unknown, depth = 0): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || depth > 3) return '';
  const values = Array.isArray(result) ? result : Object.values(result);
  return values.map((v) => resultText(v, depth + 1)).filter((t) => t !== '').join('\n');
}

/**
 * Collapse the ledger to one effect per record id (last row wins — the ledger
 * appends `pending` then `executed`/`failed` under the same id) and drop rows
 * that never ran (`pending`) or definitively did not apply (`failed`).
 */
export function settledEffects(entries: readonly unknown[]): LedgerEffect[] {
  const byId = new Map<string, Partial<EffectRecord>>();
  const noIdSeen = new Set<string>();
  const noId: Partial<EffectRecord>[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Partial<EffectRecord>;
    if (typeof rec.id === 'string') {
      byId.set(rec.id, rec);
    } else {
      // Content-hash dedup for id-less rows to prevent silent double-counting.
      const key = JSON.stringify(rec);
      if (!noIdSeen.has(key)) {
        noIdSeen.add(key);
        noId.push(rec);
      }
    }
  }
  const out: LedgerEffect[] = [];
  for (const rec of [...byId.values(), ...noId]) {
    if (rec.status === 'pending' || rec.status === 'failed') continue;
    const args = rec.args;
    const command =
      args && typeof args === 'object' ? (args as Record<string, unknown>)['command'] : undefined;
    if (typeof command !== 'string' || command.length === 0) continue;
    out.push({ command, result: resultText(rec.result) });
  }
  return out;
}

/** Repo for a ledger command: a leading `cd <path> &&`, else the session cwd. */
export function repoFromCommand(command: string, cwd: string): string {
  const m = LEADING_CD_RE.exec(command);
  const target = m?.[1] ?? m?.[2] ?? m?.[3];
  const base = target && !target.startsWith('~') && !target.includes('$')
    ? resolve(cwd, target) : cwd;
  const gitC = /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command);
  const gitTarget = gitC?.[1] ?? gitC?.[2] ?? gitC?.[3];
  if (!gitTarget || gitTarget.startsWith('~') || gitTarget.includes('$')) return base;
  return isAbsolute(gitTarget) ? gitTarget : resolve(base, gitTarget);
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

/**
 * Commits from `git commit` ledger rows. Parses the commit summary line(s)
 * from stdout and, when present in the same result, upgrades a short sha with
 * a full 40-hex sha from `git rev-parse HEAD` that it prefixes. Falls back to
 * a `git log --oneline` line when the commit itself ran with `-q`.
 */
export function ledgerCommits(effects: readonly LedgerEffect[], cwd: string): OutcomeCommit[] {
  const out: OutcomeCommit[] = [];
  for (const { command, result } of effects) {
    if (!COMMIT_CMD_RE.test(command) || result === '') continue;
    const repo = repoFromCommand(command, cwd);
    const fullShas = [...result.matchAll(FULL_SHA_LINE_RE)].map((m) => m[1]!);
    const upgrade = (sha: string): string => fullShas.find((f) => f.startsWith(sha)) ?? sha;
    const found: OutcomeCommit[] = [];
    for (const m of result.matchAll(COMMIT_SUMMARY_RE)) {
      found.push({ sha: upgrade(m[1]!), repo, subject: firstLine(m[2]!), source: 'effect_ledger' });
    }
    if (found.length === 0 && /\bgit\s+log\b[^\n]*--oneline/.test(command)) {
      const m = ONELINE_RE.exec(result);
      if (m) found.push({ sha: upgrade(m[1]!), repo, subject: firstLine(m[2]!), source: 'effect_ledger' });
    }
    out.push(...found);
  }
  return out;
}

/** Infer the PR action from the gh verb in the command. */
export function prActionFromCommand(command: string): PrAction {
  if (/\bgh\s+pr\s+create\b/.test(command)) return 'create';
  if (/\bgh\s+pr\s+merge\b/.test(command)) return 'merge';
  if (/\bgh\s+pr\s+(?:edit|comment|review)\b/.test(command)) return 'update';
  return 'unknown';
}

/** Merge a PR into the list, keeping the strongest action for a repeated URL. */
export function addPr(list: OutcomePr[], pr: OutcomePr): void {
  const existing = list.find((p) => p.url === pr.url);
  if (!existing) list.push(pr);
  else if (PR_ACTION_RANK[pr.action] > PR_ACTION_RANK[existing.action]) existing.action = pr.action;
}

/** PRs from ledger results naming a github.com PR URL (or a gh merge ref). */
export function ledgerPrs(effects: readonly LedgerEffect[]): OutcomePr[] {
  const out: OutcomePr[] = [];
  for (const { command, result } of effects) {
    if (result === '') continue;
    const action = prActionFromCommand(command);
    for (const m of result.matchAll(PR_URL_RE)) addPr(out, { url: m[0], action });
    if (action === 'merge') {
      for (const m of result.matchAll(MERGED_REF_RE)) {
        addPr(out, { url: `https://github.com/${m[1]}/pull/${m[2]}`, action });
      }
    }
  }
  return out;
}

/** Services from `afk service <action> <name>` ledger commands. */
export function ledgerServices(effects: readonly LedgerEffect[]): OutcomeService[] {
  const out: OutcomeService[] = [];
  for (const { command } of effects) {
    for (const m of command.matchAll(SERVICE_RE)) {
      const svc = { name: m[2] ?? 'unknown', action: m[1]! };
      if (!out.some((s) => s.name === svc.name && s.action === svc.action)) out.push(svc);
    }
  }
  return out;
}
