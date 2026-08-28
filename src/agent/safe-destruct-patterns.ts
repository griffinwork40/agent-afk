/**
 * Curated destructive / irreversible command pattern table for the safe-destruct
 * PreToolUse hook.
 *
 * Pulled into its own module to keep `safe-destruct-detect.ts` under the
 * project-wide 350-LOC ceiling after the two-tier (OBSERVE / BLOCK) split.
 *
 * @module agent/safe-destruct-patterns
 */

/**
 * Tier assignment for a destructive pattern.
 *
 * - `'observe'` — hook records the attempt but always returns `decision:
 *   'approve'`. Used for high-volume routine operations or recoverable ones
 *   where a hard block would create 326-class friction.
 * - `'block'` — hook returns `decision: 'block'` with a human-readable reason.
 *   Reserved for unrecoverable or externally-irreversible operations that are
 *   never inner-loop for a well-behaved agent.
 */
export type PatternTier = 'observe' | 'block';

/**
 * Required when tier === 'block'. The reason string surfaces directly to the
 * agent through HookBlockedError → tool result content. It must:
 *   (a) name the matched pattern id,
 *   (b) say in one clause why it is blocked (unrecoverable / external),
 *   (c) name the recoverable alternative or the explicit way to proceed.
 */
export type DestructivePattern =
  | { readonly id: string; readonly re: RegExp; readonly tier: 'observe' }
  | { readonly id: string; readonly re: RegExp; readonly tier: 'block'; readonly blockReason: string };

// Invariant: Tier calibration is a measured constraint, not a preference.
//
// Five weeks of catch-records (359 approve events, 165 sessions) show:
//
//   rm-recursive-force:    326 firings (91%) — routine cleanup in cron jobs
//   git-branch-force-delete: 13
//   git-push-force:           6
//   git-reset-hard:           5
//   everything else:          0
//
// A blanket block would have stopped ~326 legitimate operations. Tiers encode
// the calibration outcome: OBSERVE for high-volume / recoverable operations,
// BLOCK for unrecoverable or externally-irreversible ones that are never
// inner-loop. The rationale for each controversial assignment is inline below.
// Do NOT move a pattern from OBSERVE to BLOCK without re-measuring firing rates;
// the asymmetry is intentional, not an oversight.
//
// Pattern ids are stable public identifiers used by telemetry, tests, and the
// trace substrate. Changing an id breaks deduplication across the 165-session
// history. New ids are append-only.
// Known constraint: regex-based detection cannot distinguish executable commands
// from quoted/echoed mentions (e.g. `echo 'git reset --hard'`, `grep
// 'terraform destroy'`). OBSERVE-tier false positives are noisy but harmless;
// BLOCK-tier false positives are a known cost accepted for safety — they fire
// rarely in practice and the agent can explain the context to the operator.
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  // ── rm: recursive AND force (irrecoverable, no prompt) ─────────────────────
  //
  // Invariant: stays OBSERVE despite being destructive because of the measured
  // 326-firing base rate (91% of all catch-records). Promoting to BLOCK would
  // have blocked 91% of legitimate operations across the shadow window. A
  // future re-calibration can revisit this if the rate drops significantly, but
  // any change must be measured, not assumed. The commit objects and most build
  // artifacts are reproducible; the irrecoverability risk is accepted.
  {
    id: 'rm-recursive-force',
    re: /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+/i,
    tier: 'observe',
  },
  // Recursive and force in separate flag tokens (`rm -r -f`, `rm -f -r`).
  {
    id: 'rm-recursive-force-split',
    re: /\brm\s+-[a-z]*r[a-z]*\s+-[a-z]*f|\brm\s+-[a-z]*f[a-z]*\s+-[a-z]*r/i,
    tier: 'observe',
  },
  // Long-form, both flags present in either order.
  {
    id: 'rm-recursive-force-long',
    re: /\brm\s+[^|&;\n]*--recursive\b[^|&;\n]*--force\b|\brm\s+[^|&;\n]*--force\b[^|&;\n]*--recursive\b/i,
    tier: 'observe',
  },
  // The explicit "yes, wipe /" escape hatch — always catastrophic.
  {
    id: 'rm-no-preserve-root',
    re: /\brm\b[^|&;\n]*--no-preserve-root\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [rm-no-preserve-root] — explicit root-wipe flag, irrecoverable; remove the --no-preserve-root flag, or target a non-root path instead.',
  },

  // ── git: history / worktree destroyers ─────────────────────────────────────
  //
  // git reset --hard: BLOCK — discards uncommitted work permanently. Measured
  // at 5 firings in 5 weeks, so it is not inner-loop.
  {
    id: 'git-reset-hard',
    re: /\bgit\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*reset\s+--hard\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [git-reset-hard] — discards all uncommitted changes irrecoverably; commit or run "git stash" first. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  // git clean -f: BLOCK — removes untracked files with no recovery path.
  {
    id: 'git-clean-force',
    re: /\bgit\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*clean\s+-[a-z]*f|\bgit\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*clean\s+[^|&;\n]*--force\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [git-clean-force] — deletes untracked files irrecoverably; use "git clean -n" (dry-run) to preview. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  // git push --force: BLOCK — rewrites remote history, potentially for all
  // consumers. Measured at 6 firings in 5 weeks; not inner-loop.
  {
    id: 'git-push-force',
    re: /\bgit\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*push\b[^|&;\n]*--force(?!-)|\bgit\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*push\b[^|&;\n]*(?<![\w-])-f\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [git-push-force] — rewrites remote history, permanently destructive for all branch consumers; prefer "--force-with-lease" or coordinate with collaborators first.',
  },
  // Invariant: git branch -D stays OBSERVE because only the ref is deleted —
  // the commit objects survive in the reflog for at least 30 days by default.
  // Recovery: `git reflog` + `git checkout -b <name> <sha>`. Measured at 13
  // firings in 5 weeks; promoting to BLOCK would have been the #2 largest
  // friction source after rm-recursive-force.
  // Case-sensitive: `-D` force-deletes; `-d` refuses on unmerged.
  { id: 'git-branch-force-delete', re: /\bgit\s+branch\s+[^|&;\n]*-D\b/, tier: 'observe' },

  // ── filesystem / raw device ─────────────────────────────────────────────────
  {
    id: 'dd-to-device',
    re: /\bof=\/dev\/(?!null\b|zero\b|random\b|urandom\b|stdout\b|stderr\b|tty\b)\S/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [dd-to-device] — writing directly to a block device is irrecoverable; verify the target path is a file, not a device node.',
  },
  {
    id: 'mkfs',
    re: /\bmkfs(\.\w+)?\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [mkfs] — formats a filesystem, irrecoverably destroying all data on the target device; confirm the device path. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  {
    id: 'redirect-to-block-device',
    re: />\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)\w*/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [redirect-to-block-device] — shell redirect to a block device overwrites raw sectors irrecoverably; redirect to a file path instead.',
  },
  // Invariant: find -delete stays OBSERVE because most usages target build
  // artifacts and temp files (zero firings in 5 weeks suggests it is rare but
  // routine when it does appear); state is typically reproducible from source.
  {
    id: 'find-delete',
    re: /\bfind\b[^|&;\n]*-delete\b|\bfind\b[^|&;\n]*-exec\s+rm\b/i,
    tier: 'observe',
  },
  {
    id: 'shred',
    re: /\bshred\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [shred] — overwrites file data irrecoverably, bypassing the filesystem; use "rm" if secure deletion is not required. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },

  // ── SQL ─────────────────────────────────────────────────────────────────────
  //
  // Split from the former monolithic `sql-drop-truncate-delete` id:
  //   - sql-drop-truncate: DDL destructors → BLOCK (schema changes are external
  //     / unrecoverable without a backup).
  //   - sql-delete-from: DML row removal → OBSERVE (routine in development SQL;
  //     zero firings in 5 weeks confirm it is not a high-risk inner-loop op in
  //     this agent's usage profile, and transactions often wrap it).
  //
  // Exception: the old `sql-drop-truncate-delete` id had 0 firings in the
  // 5-week shadow window, so no trace data is orphaned by the split.
  {
    id: 'sql-drop-truncate',
    re: /\b(drop\s+(table|database|schema|index)\b|truncate\s+table\b)/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [sql-drop-truncate] — DDL destructor removes schema objects or all rows without a transaction rollback path; back up or use a migration with a down step. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  {
    id: 'sql-delete-from',
    re: /\bdelete\s+from\b/i,
    tier: 'observe',
  },

  // ── outbound HTTP writes (curl / wget) ─────────────────────────────────────
  //
  // Invariant: OBSERVE (not BLOCK) — curl writes are inner-loop for many agent
  // workflows (posting to local dev servers, CI webhooks, self-hosted APIs).
  // A hard block would generate unacceptable friction; OBSERVE records the event
  // so audit logs capture outbound mutations without stopping the flow.
  //
  // Two patterns cover the common shapes:
  //   curl-write-method: explicit method override via -X (POST / PUT / PATCH / DELETE).
  //   curl-data-flag:    body-payload flags (-d / --data / -F / --form) which imply
  //                      a POST even when -X is omitted.
  //
  // wget --post-data is captured under curl-data-flag via a shared pattern that
  // is checked after these two entries (see curl-data-flag regex).
  // Regex uses [^|;&]* to stop at shell pipeline/compound boundaries so a piped
  // command is not misattributed to the preceding curl invocation.
  {
    id: 'curl-write-method',
    re: /\bcurl\b[^|;&]*\s(-X\s*|--request\s+)(POST|PUT|PATCH|DELETE)\b/i,
    tier: 'observe',
  },
  {
    id: 'curl-data-flag',
    re: /\bcurl\b[^|;&]*\s(-d\b|--data\b|-F\b|--form\b)|\bwget\b[^|;&]*\s(--post-data\b|--post-file\b)/i,
    tier: 'observe',
  },

  // ── infra / containers ───────────────────────────────────────────────────────
  //
  // Invariant: docker-destructive and kubectl-delete stay OBSERVE because their
  // state is typically declarative and re-creatable from manifests / Dockerfiles.
  // `kubectl delete pod` is inner-loop for many operators (pod restarts); a
  // block here would be the #3 largest friction source. Zero firings in 5 weeks
  // is consistent with rare-but-routine usage.
  {
    id: 'docker-destructive',
    re: /\bdocker\s+(system\s+prune|volume\s+(rm|prune)|image\s+prune|container\s+prune|network\s+prune)\b|\bdocker\b[^|&;\n]*\brmi?\s+[^|&;\n]*-f/i,
    tier: 'observe',
  },
  { id: 'kubectl-delete', re: /\bkubectl\s+delete\b/i, tier: 'observe' },
  // Invariant: terraform-destroy stays BLOCK because it tears down real external
  // infrastructure (VMs, load balancers, DNS records, databases) that cannot be
  // reconstructed by re-running plan — re-apply creates new resources with new
  // IDs / IPs, breaking dependent systems. It is never an inner-loop operation.
  {
    id: 'terraform-destroy',
    re: /\bterraform\s+destroy\b/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [terraform-destroy] — tears down live external infrastructure irrecoverably (new apply creates new resources, not the same ones); run "terraform plan -destroy" to preview. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  {
    id: 'launchctl-service-register',
    re: /\blaunchctl\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*(load|bootstrap|submit|start|kickstart|enable)(?:\s|$)/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [launchctl-service-register] — installs a persistent launchd service that survives reboots and session boundaries; use `afk service install` via /service-setup instead. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
  {
    id: 'systemctl-service-enable',
    re: /\bsystemctl\s+(?:(?:-{2}[\w-]+(?:=\S+)?|-[A-Za-z](?:\s+\S+)?)\s+)*(enable|start|daemon-reload)(?:\s|$)/i,
    tier: 'block',
    blockReason:
      'safe-destruct: blocked [systemctl-service-enable] — enables/starts a systemd unit that persists across sessions and reboots; use `afk service install` via /service-setup instead. This hook cannot be self-bypassed: if the destruction is genuinely intended, stop and ask the operator to run it.',
  },
];
