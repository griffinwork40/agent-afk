# Grant-manager three-way divergence diff (pre-consolidation, @ cd37ef1)

Copies compared:

- **D** = `SessionToolDispatcher` — `src/agent/tools/dispatcher.ts:355-510`
- **A** = `AnthropicDirectProvider` — `src/agent/providers/anthropic-direct/index.ts:540-628`
- **O** = `OpenAICompatibleProvider` — `src/agent/providers/openai-compatible/index.ts:501-592`

Classification legend: **(a)** intentional per-consumer difference · **(b)** drift/possible missed fix · **(c)** cosmetic.

## Summary table

| Method | A vs O | D vs A/O | Classification |
|---|---|---|---|
| `addReadRoot` | identical logic (comment wording differs) | diverges: signature + lazy-init + sessionId sourcing | A↔O: (c); D↔providers: (a) |
| `addWriteRoot` | identical logic (brace style differs) | same divergences as addReadRoot | A↔O: (c); D↔providers: (a) |
| `revokeRoot` | identical logic (comment differs) | diverges: guard anchor + uninit early-return | A↔O: (c); D↔providers: (a) **with one (b) suspect — see below** |
| `getGrants` | **byte-identical** | diverges: resolveBase + allowAll sources | A↔O: identical; D↔providers: (a) |
| `appendAuditLog` / `appendProviderAuditLog` | **byte-identical** (A vs O) | diverges: sessionId source (`this.sessionId` vs `entry.sessionId`) | A↔O: identical; D↔providers: (a) |
| `ensureSharedRoots` | logic differs: A additionally sets `_currentCwd` | D has no lazy init (eager ctor arrays) | A↔O: (a) — `_currentCwd` feeds A's `cwdDependentsFactory` only; D: (a) |
| `setAllowAll` | D only | — | (a) dispatcher-only API |
| `setResolveBase` | D only | — | (a) dispatcher-only API |

Counts: of the 4 shared GrantManager methods (addReadRoot/addWriteRoot/revokeRoot/getGrants) + audit append, **A vs O: 2 byte-identical, 3 cosmetic-only (logic identical)**. **D vs providers: all 5 diverge functionally** (parameterizable, all preserved).

## Exact divergences

### 1. `addReadRoot` — A (index.ts:559-570) vs O (index.ts:522-531): cosmetic (c)

```diff
-    // Invariant: audit only on state change — a repeat grant of an
-    // already-present root must not emit a duplicate ledger record (see
-    // SessionToolDispatcher.addReadRoot; the unconditional append caused a
-    // 196x blow-up of session-grants.jsonl).
+    // Invariant: audit only on state change (see dispatcher.addReadRoot) —
+    // repeat grants of an already-present root must not duplicate the ledger.
```
Comment wording only. Executable statements identical.

### 2. `addWriteRoot` — A (572-582) vs O (533-541): cosmetic (c)

```diff
-    if (!this._sharedReadRoots!.includes(p)) {
-      this._sharedReadRoots!.push(p);
-    }
+    if (!this._sharedReadRoots!.includes(p)) this._sharedReadRoots!.push(p);
```
Brace style only.

### 3. `revokeRoot` — A (584-597) vs O (543-554): cosmetic (c)

```diff
-    // Non-revocable guard: refuse to remove the initial resolveBase, mirroring
-    // the dispatcher-level check (see SessionToolDispatcher.revokeRoot).
```
Comment only.

### 4. `getGrants` — A (599-606) vs O (556-563): byte-identical.

### 5. `appendProviderAuditLog` — A (608-628) vs O (572-592): byte-identical bodies (O carries an extra docstring noting "Inlined rather than extracted to keep the providers independently revertable; consolidate when a third provider needs the same logic" — this workstream is that consolidation).

### 6. `ensureSharedRoots` — A (540-557) vs O (501-508): (a) intentional

```diff
       if (cwd && !this._initialResolveBase) this._initialResolveBase = cwd;
+      // A only:
+      if (cwd && !this._currentCwd) this._currentCwd = cwd;
```
A tracks `_currentCwd` for its `cwdDependentsFactory` in-place root migration on `setCwd` (anthropic-direct/index.ts:877-885). O has no such factory; its cwd re-anchor routes through `SessionToolDispatcher.setResolveBase` instead. Intentional per-consumer.

### 7. `addReadRoot`/`addWriteRoot` — D (dispatcher.ts:355-378) vs providers: (a) intentional

```diff
-  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash'): void {
+  addReadRoot(absPath: string, source: 'slash' | 'tool' = 'slash', sessionId?: string): void {
+    this.ensureSharedRoots();
     const p = path.resolve(absPath);
-    if (!this._readRoots.includes(p)) {
-      this._readRoots.push(p);
-      this.appendAuditLog({ action: 'grant-read', path: p, source });
+    if (!this._sharedReadRoots!.includes(p)) {
+      this._sharedReadRoots!.push(p);
+      this.appendProviderAuditLog({ action: 'grant-read', path: p, source, sessionId });
```
Three functional deltas, all intentional:
- **sessionId sourcing**: D binds `sessionId` at construction and its audit writes `this.sessionId ?? null`; providers take a per-call `sessionId?` and write `entry.sessionId ?? null`. D's 2-arg method is structurally assignable to the `GrantManager` interface (allow-dir.ts:26-31) — a per-call 3rd arg passed by callers is silently dropped on D (see Suspected findings #1).
- **lazy init**: providers must `ensureSharedRoots()` because /allow-dir can run before the first `query()`; D's arrays are eager ctor state.
- **field names / audit fn**: mechanical.

### 8. `revokeRoot` — D (384-396) vs providers: (a) intentional, one (b) suspect

```diff
-    // resolveBase is non-revocable
-    if (p === this.resolveBase) return;
+    if (!this._sharedReadRoots) return;          // providers: uninit no-op (NO audit row)
+    if (this._initialResolveBase && p === this._initialResolveBase) return;
```
- **Guard anchor divergence**: D protects the *current* `resolveBase` — which `setResolveBase()` (dispatcher.ts:446-485) *migrates* on worktree rename/`/cwd`, so after a rename the NEW cwd is non-revocable and the ORIGINAL launch dir becomes revocable. Providers protect the *initial* resolveBase, explicitly documented as "fixed at session start and preserved as the /allow-dir non-revocable anchor even across renames" (anthropic-direct/index.ts:236-237). These are opposite policies, each documented — classified (a), flagged as Suspected finding #2 because they cannot both be the intended /allow-dir semantics.
- **Uninit early-return**: providers silently no-op (no audit row) when called before any init; D cannot be uninitialized. (a).

### 9. `getGrants` — D (399-406) vs providers: (a) intentional

```diff
-      resolveBase: this.resolveBase,
-      readRoots: this._readRoots.slice(),
-      writeRoots: this._writeRoots.slice(),
-      allowAll: this._allowAll,
+      resolveBase: this._initialResolveBase,
+      readRoots: this._sharedReadRoots?.slice() ?? [],
+      writeRoots: this._sharedWriteRoots?.slice() ?? [],
+      allowAll: pathContainmentBypassed(this._currentPermissionMode),
```
D's `allowAll` is a live boolean flipped by `setAllowAll()` (file-tool half of /bypass); providers derive it from `_currentPermissionMode` (path-approval-hook half). Both halves of the same documented dual-toggle design (dispatcher.ts:408-415, openai-compatible/index.ts:266-269). (a).

### 10. `appendAuditLog` (D, 487-510) vs `appendProviderAuditLog` (providers): (a)

```diff
-        sessionId: this.sessionId ?? null,
+        sessionId: entry.sessionId ?? null,
```
Plus catch-comment wording (c). Output shape `{timestamp, sessionId, action, path, source}` with sessionId-always-present-or-null is identical across all three (asserted by dispatcher-audit-log.test.ts).

## Consolidation resolutions (what `grant-manager.ts` adopts)

Independently re-verified against `git show cd37ef1:<path>` (fresh 3-way extraction) — all
entries above confirmed accurate; no missed or misstated divergence found.

| # | Divergence | Adopted in `PathGrantManager` | Why |
|---|---|---|---|
| 1–3, cosmetic A↔O | comment wording / brace style | A's fuller comments (196x rationale, non-revocable guard) | Strictest documentation; zero executable delta. |
| 7a sessionId sourcing | D: ctor-bound; providers: per-call arg | Per-call `sessionId?` arg, falling back to optional `getDefaultSessionId` hook (D supplies it) | Superset: per-call wins when passed, consumer default otherwise. The dispatcher's delegating wrapper deliberately keeps its 2-arg signature, so a per-call 3rd arg is still dropped on D exactly as before (Suspected finding #1 is report-only, not fixed) — observable behavior unchanged for all three consumers. |
| 7b lazy vs eager init | providers: `ensureSharedRoots()`; D: eager ctor arrays | Optional `ensureInitialized?` hook (providers bind it; D omits) plus `getReadRoots(): string[] \| undefined` uninit contract | Preserves each consumer's init lifecycle exactly. |
| 8a non-revocable anchor | D: CURRENT `resolveBase` (migrates); providers: INITIAL resolveBase (fixed) | `getProtectedRoot()` hook — each consumer keeps its own documented policy | Opposite, *both documented* policies — unifying either way would change /allow-dir semantics for one consumer. Preserved verbatim; flagged as Suspected finding #2 for a follow-up decision. |
| 8b uninit revoke no-op | providers: silent no-op, no audit row | `if (!readRoots) return;` before any work | Strictest: never emit an audit row for a revoke that mutated nothing. D can't hit this path (eager init) so D is unaffected. |
| 9 `allowAll` source | D: live `setAllowAll` boolean; providers: mode-derived | `getAllowAll()` hook | Two halves of the documented dual-toggle /bypass design — per-consumer by construction. |
| 10 audit emission | `sessionId: this.sessionId ?? null` vs `entry.sessionId ?? null` | `entry.sessionId ?? getDefaultSessionId?.() ?? null` | Same stable `{timestamp, sessionId, action, path, source}` schema (key always present, null-coalesced) as all three originals. |

Structure: `PathGrantManager` is composed (private instance field + thin delegating
methods) into all three consumers; public surfaces and grant-state ownership are
unchanged — each consumer holds its own instance, no shared module state.

## Drift/bug verdict

**No (b)-class code drift found**: the 196x audit-dedup fix ("audit only on state change") is present in ALL THREE copies; the sessionId-null coalescing is present in all three; the non-revocable guard exists in all three (with the anchor-policy divergence above). The copies were kept in sync remarkably well — divergences are per-consumer by design, plus cosmetic comment/brace drift between A and O.
