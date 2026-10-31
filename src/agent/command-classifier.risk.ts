/** Legacy approval-tier policy. Kept separate from the mutation facet: a
 * medium-risk command is not necessarily mutating, nor is default-allow proof
 * of read-only execution. Tables retain their original order and raw view. */
import type { RiskVerdict } from './risk-classifier.js';
import type { MutationVerdict } from './command-classifier.js';
import { findHighBashPattern } from './risk-classifier.bash-boundary.js';
import { isSafeAtCommandPosition } from './risk-classifier.bash-safe.js';

// ---------------------------------------------------------------------------
// Bash rule tables
// Checked in order; first match wins within each tier.
// The `high` table is checked before `medium`; `safe` patterns shortcut
// before the default-medium fallback.
// ---------------------------------------------------------------------------

/**
 * Bash commands that map to `high` risk.
 * Sources: common destructive/irreversible shell patterns.
 */
const BASH_HIGH: readonly string[] = [
  'rm -rf',
  'rm ',
  'sudo',
  'eval ',
  'chmod',
  'chown',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'mkfs',
  'fdisk',
  'diskutil eraseDisk',
  'dd if=',
  'dd of=',
  '| sh',
  '| bash',
  '|sh',
  '|bash',
  // Outbound HTTP write methods — autonomous agents posting to external APIs
  // can send irreversible mutations (payments, emails, Webhooks) without a
  // human in the loop. BASH_HIGH gates these behind the AFK approval prompt.
  // Note: `curl https://… | bash` already matches `| bash` above; these entries
  // catch curl-to-API patterns that don't pipe to a shell.
  //
  // Prefixless forms (`-X POST` not `curl -X POST`) deliberately match even
  // when intervening flags separate curl from the method flag — e.g.
  // `curl -H 'Content-Type: …' -X POST`. `-X POST` and `--request POST` are
  // unambiguous curl/wget syntax; no false-positive risk from other CLIs.
  // The `-XPOST` no-space form is valid curl shorthand.
  '-X POST',
  '-X PUT',
  '-X PATCH',
  '-X DELETE',
  '-XPOST',
  '-XPUT',
  '-XPATCH',
  '-XDELETE',
  '--request POST',
  '--request PUT',
  '--request PATCH',
  '--request DELETE',
  'curl --data',
  'curl -d',
  'curl -F',
  'wget --post-data',
  'wget --post-file',
  'launchctl load',
  'launchctl bootstrap',
  'launchctl submit',
  'launchctl start ',
  'launchctl kickstart',
  'launchctl enable ',
  'systemctl enable ',
  'systemctl start ',
  'systemctl daemon-reload',
  // Real binaries whose names merely CONTAIN a token above (GNU coreutils `g*`
  // on macOS, secure-rm, partitioners, sudoers editor). Plain `includes` used
  // to catch them; word-start matching (#3534) needs them listed explicitly.
  'grm ',
  'srm ',
  'gchmod',
  'gchown',
  'gdd if=',
  'gdd of=',
  'dcfldd',
  'dc3dd',
  'gsudo',
  'sfdisk',
  'cfdisk',
  'gfdisk',
  'visudo',
];

/**
 * Bash commands that map to `medium` risk.
 * These are reversible-but-notable operations: pushes (without --force),
 * installs, redirects, moves.
 */
const BASH_MEDIUM: readonly string[] = [
  'git push',
  'git reset',
  'git commit',
  'git stash drop',
  'git stash clear',
  'npm install',
  'pnpm install',
  'yarn',
  'pip install',
  'apt ',
  'apt-get ',
  'brew install',
  'tee ',
  ' > ',
  ' >> ',
  'mv ',
  'cp ',
  'mkdir',
  'touch',
  'pnpm build',
  'tsc ',
  'eslint --fix',
];

/**
 * Bash commands that map to `safe`.
 * Read-only operations and test/lint invocations with no side-effects.
 */
const BASH_SAFE: readonly string[] = [
  'pnpm test',
  'vitest',
  'jest',
  'pytest',
  'cargo test',
  'go test',
  'git status',
  'git log',
  'git diff',
  'git show',
  'ls ',
  'cat ',
  'head ',
  'tail ',
  'find ',
  'grep ',
  'echo ',
  'printf ',
  // GitHub CLI read-only subcommands — commonly used by agents to poll CI/PR
  // status without mutating anything. Only the read-access verbs (view, list,
  // checks, status, diff) are safe-listed; mutating verbs (merge, create, edit,
  // close, comment, review, approve) are NOT listed here and fall through to
  // the default-medium rule.
  // Matched by leading words at command position (risk-classifier.bash-safe.ts)
  // so `gh pr view --json` and `gh run list --limit 5` both hit the entry. The
  // check order (high → medium → safe) means any command that ALSO contains a
  // BASH_HIGH token (e.g. `| bash`) is gated before it ever reaches this table.
  'gh pr view',
  'gh pr list',
  'gh pr checks',
  'gh pr status',
  'gh pr diff',
  'gh run view',
  'gh run list',
  'gh issue view',
  'gh issue list',
  'gh issue status',
  'gh repo view',
  // curl/wget read-only HTTP probes — these modes are non-mutating and widely
  // used in CI health checks. `-I`/`--head` issue an HTTP HEAD request; `-sI`
  // combines silent + HEAD. Note: `-si` (lowercase i) prints response headers
  // for a GET — still read-only, but NOT a HEAD probe. `wget --spider` is the
  // wget equivalent of HEAD mode.
  'curl --head',
  'curl -I ',
  'curl -sI ',
  'curl -si ', // trailing space is intentional — blocks `-siX POST` (flags without separator)
  'wget --spider',
];

export function classifyCommandRisk(
  cmd: string,
  mutation: () => MutationVerdict,
  tokenize: (view: string) => readonly (readonly string[])[],
): RiskVerdict {
  // Invariant: scan the original command for HIGH before MEDIUM before SAFE.
  // No heredoc stripping or quote parsing: wrappers, interpreters and later
  // consumers can execute any payload. HIGH tokens are only discounted when
  // glued to a preceding word character (`platform `, `retrieval `), which
  // can never start a shell word — see risk-classifier.bash-boundary.ts.
  const high = findHighBashPattern(cmd, BASH_HIGH);
  if (high !== undefined) return { level: 'high', reason: `bash-pattern: matched '${high}'`, category: 'bash-destructive' };
  for (const p of BASH_MEDIUM) {
    if (cmd.includes(p)) return { level: 'medium', reason: `bash-pattern: matched '${p}'`, category: 'bash-mutating' };
  }
  // SAFE requires every segment to start with a safe-table command — never a
  // substring hit inside an argument (`--head`, `"cat food"`); see
  // risk-classifier.bash-safe.ts.
  //
  // Guard: even when the command-position check passes, run `classifyBashCommand`
  // (the readonly-bash tokenizer-based classifier) as a second opinion. It catches
  // mutation patterns that the simple substring HIGH table misses when the signal
  // is quoted or flag-separated — e.g. `curl -I … -X "POST"` where `-X POST`
  // (unquoted) is in BASH_HIGH but `-X "POST"` (quoted method) is not, yet the
  // tokenizer's CURL_WRITE_METHOD regex still flags it. If either classifier says
  // mutating, return high. This is strictly tightening: no previously-high or
  // previously-medium verdict changes, only safe→high for the divergent cases.
  // (#3846 golden case: `curl -I https://example.com -X "POST"`)
  if (isSafeAtCommandPosition(cmd, BASH_SAFE, tokenize)) {
    const guard = mutation();
    if (guard.mutating) {
      return { level: 'high', reason: `bash-mutation-guard: ${guard.reason ?? 'mutation detected'}`, category: 'bash-destructive' };
    }
    return { level: 'safe', category: 'read-only' };
  }
  // Default: medium — unknown bash commands are not safe by assumption.
  return { level: 'medium', category: 'bash-mutating' };
}
