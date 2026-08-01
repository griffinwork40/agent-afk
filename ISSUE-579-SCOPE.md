# Issue #579 Scope — Best Fix (shadow-verified + adversarially critiqued)

State: OPEN on GitHub (`gh issue view 579`). Two independent halves. Git baseline `55bf2a8` (clean).

## TL;DR recommendation (with dissent)

**Ship two separate PRs:**
- **PR 1 (O2, cheap, low-risk):** pragmatist's sequencing — extend `READ_ALLOWLIST_REL` exact-file carve-outs for `.ssh/config` + `.ssh/known_hosts`; defer `afk.config.json` (model-slot `apiKey` lives there; `config_get target=config` is UNMASKED — see Correction 1). Mirror the `mcp.json` test pattern.
- **PR 2 (O3):** paranoid's **curated leaf-dir allowlist** — `rm -rf` downgrades to `medium` ONLY when every target's basename ∈ {`node_modules`,`dist`,`build`,`.next`,`coverage`,`.cache`,`__pycache__`,`.turbo`,`.parcel-cache`} AND resolves inside `workspaceRoot` via `safeRealpath` AND has no shell metacharacters. Keep `'rm -rf'` in `BASH_HIGH` as default-deny; **keep `'rm -f '`** (forced single delete gate — see paranoid). Fail-closed when root unknown or any target unresolvable/unparseable.

**Dissent = true.** The pragmatist argues the O3 curated list is 2-3× the diff of a 20-line gate-side "in-workspace" downgrade and may be good enough for a bug-fix issue. The architect argues both fixes entrench fragmented allowlists and the right long-term move is a unified `safe_read_file` (masked) tool + promoting `safe-destruct-detect` to enforcement. Both are legitimate; see matrix. **Decision point: cost/speed (pragmatist) vs. structural safety (paranoid).**

---

## Shadow-verify (3 load-bearing claims, all re-derived independently)

| Claim | Verdict | Note |
|---|---|---|
| A. SSH keys have arbitrary names (`github_key`) → deny-glob fail-open → whole-dir safer | **CONFIRMED** | repo's OWN surfaces (`worktree-ignored-patterns.ts:44-45`, `at-file-inject.ts:91`) already miss `github_key` — corroborates gaps in narrower matchers |
| B. `afk.config.json` carries `apiKey` → defer carve-out | **CONFIRMED** (conclusion holds; one sub-claim REFUTED) | see Correction 1 |
| C. `classifyBash` gets no `RiskContext` → refactor needed | **CONFIRMED** (diagnosis); simpler alternative surfaced | see Correction 2 |

### Correction 1 (applies to O2)
The scoping's justification "config_get already provides masked reads so raw file access is unnecessary" is **WRONG**. `mutate.ts:207-212` masks ONLY `target: 'env'` (where `cls === 'secret'`); `listConfig` (`:322-325`) and `getConfigValue` (`:315-320`) for `target: 'config'` return **raw unmasked JSON**. So `config_get target=config key=models.large` returns `{"apiKey":"sk-..."}` in the clear. The deferral conclusion is therefore **stronger** (no masked-read escape hatch exists); the threat-model disk path is `models.{slot}.apiKey` (`types.ts:307`), hand-editable, read by `parseBinding` (`model-slots.ts:424`). Drop the bad justification; keep the defer.

### Correction 2 (applies to O3)
`classifyBash` indeed receives no `RiskContext` (`risk-classifier.ts:279` discards it). BUT the gate already holds `workspaceRoot` + the raw command at `afk-mode-gate.ts:329` — it can do the `rm`-target workspace check **itself**, downgrading to `medium` without touching the classifier's pure signature (no test-surface ripple). This is Path P2; the original P1 (refactor `classifyBash`) corrupts the pure-classifier/policy-gate separation documented at `risk-classifier.ts:1-17`. **All three critics effectively chose P2 over P1** — P1 is dead.

---

## Devils-advocate matrix (all 3 critics returned `strong`)

| Option | Cost | Risk | Scope-fit | Goal-fit | Note |
|---|---|---|---|---|---|
| **Paranoid** (curated allowlist + env-gated ssh carve-outs) | medium | **low** | good | excellent | only one that structurally closes `rm -rf ./`, `$PWD`, symlinks, multi-target, `.env`, globbing |
| **Pragmatist** (O2 standalone + cheap P2 gate-side downgrade) | **low** | medium-high (O3) | excellent (O2) / poor (O3) | good (O2) / weak (O3) | sequencing argument correct & independent of O3 path; O3 inherits in-workspace hole |
| **Original** (carve-outs + P1 refactor) | medium-high | high | poor (O3) | good (O2) / mixed (O3) | P1 refactor is wrong-level scope creep for a bugfix |
| **Architect** (`safe_read_file` + promote safe-destruct-detect) | high | low-long-term / high-short-term | poor (scope-creeps) | excellent in principle | right direction, wrong issue; `config_get` raw-JSON side channel is a real SEPARATE finding |

### Synthesizer's pick: **Paranoid**, with pragmatist's O2 sequencing adopted.
The concrete O3 failure modes the paranoid surfaced are real, not theoretical:
- `rm -rf ./` / `rm -rf $PWD` — `path.resolve` collapses to workspace root → "inside workspace" → **PASSES** the original/pragmatist check and deletes the whole tree.
- `rm -rf symlink-in-workspace → /etc` — `classifyBash` (`:149-166`) does **NO** path resolution; substring anchors don't catch it.
- `rm -rf node_modules /etc` — multi-target; substring "in-workspace" can't parse it.
- `rm -rf .env` — gitignored secrets; "in-workspace" allows it.
- `rm -rf *.log` where a log symlinks to `/etc/passwd` — glob unhandled; classifier sees the raw string.

Only the curated **basename-match + safeRealpath + no-metacharacters + ALL-targets-pass** approach structurally excludes these.

---

## O2 open decisions (need operator input)
1. **`.ssh/config` carve-out vs. masked reader.** Paranoid argues `.ssh/config` carries `ProxyCommand` secrets, `IdentityFile` paths (reveal key names + infra topology), `User`+`HostName` (internal IPs), `LocalForward` (network topology) — it's NOT "non-secret." Options: (a) carve it out anyway (matches issue's literal acceptance, but opens an exfil-enumeration path); (b) gate behind `AFK_READ_SSH_CONFIG=1` env flag (paranoid's lean); (c) build a masked `ssh_config_get` reader (architect's lean, more work). `known_hosts` likewise reveals every host ever contacted — paranoid gates it behind `AFK_READ_SSH_KNOWN_HOSTS=1`.
   - Symlink safety for any carve-out is already handled by the leaf-non-dereference invariant (`read-denylist.ts:200-203` + `:381`) — a `~/.ssh/config → ~/.ssh/id_rsa` symlink resolves to the key path which isn't in the allowlist → stays denied. Confirmed safe.
2. **`afk.config.json`** — defer confirmed (Correction 1). The `config_get` raw-JSON side channel is a separate finding worth its own issue (architect).

## O3 open decisions (need operator input)
1. **Curated allowlist contents** — is {node_modules, dist, build, .next, coverage, .cache, __pycache__, .turbo, .parcel-cache} the right set? Anything to add (e.g. `out`, `target`, `tmp`)?
2. **`rm -rf .git`** — paranoid adds `/.git` to the always-block list (history loss). Confirm.
3. **Keep `'rm -f '`** as a BASH_HIGH entry (forced single-delete stays gated) — paranoid insists; dropping bare `'rm '` is fine but `'rm -f '` should not be dropped. Confirm.
4. **Path P2 confirmed**: gate-side downgrade in `afk-mode-gate.ts` after `classifyRisk`, NOT a `classifyBash` refactor.

---

## Files to touch
- `src/agent/tools/handlers/read-denylist.ts:168` (`READ_ALLOWLIST_REL` — add `.ssh/config`, `.ssh/known_hosts`; decide env-gate)
- `src/agent/tools/handlers/read-denylist.test.ts` (mirror `mcp.json` carve-out tests at ~:194-225; siblings/pseudo-children stay denied; re-deniable via `AFK_READ_DENYLIST`)
- `src/agent/risk-classifier.ts:53` (drop bare `'rm '` → `rm foo.txt` falls to medium; keep `'rm -rf'`; add `'rm -f '` per paranoid)
- `src/agent/afk-mode-gate.ts` ~:329-334 (gate-side `rm -rf` downgrade: basename-match against allowlist + `safeRealpath` inside workspaceRoot + no metacharacters + ALL targets pass + fail-closed)
- `src/agent/risk-classifier.test.ts:18-24` (flip `rm foo.txt` high→medium; `rm -rf dist/` stays high per classifier, gate downgrades)
- `src/agent/afk-mode-gate.test.ts:40` (flip `rm -rf node_modules` block→allow; add symlink/multi-target/`./`/`.env` block cases)

## Separate follow-ups (NOT in #579)
- Architect's `safe_read_file` masked-reader tool (unify `maskSecret` + `redactInlineSecrets` + carve-outs).
- Architect's `config_get` raw-JSON side channel (`mutate.ts:323-325` returns unmasked afk.config.json) — its own issue.
- Architect's promote `safe-destruct-detect` observe→enforce unification.
- Bash-restriction-hook divergence: `bash-restriction-hook.ts:127` (`\.ssh\b`) will still block `cat ~/.ssh/config` even after typed-tool carve-out — document or fix.