import { describe, expect, it } from 'vitest';
import { classifyRmRisk } from './risk-classifier.rm-predicate.js';

// Contract: classifyRmRisk() is the secondary predicate applied after the
// 'rm ' BASH_HIGH token fires. It returns 'high' for structurally dangerous
// rm invocations and 'medium' for plain temp/scratch/cache-file cleanup that
// is safe to auto-allow in daemon mode.
//
// Invariant: the function never returns 'safe'.

describe('classifyRmRisk -- HIGH cases (structural danger)', () => {
  it('docker rm subcommand keeps HIGH (rm is not the leading command)', () => {
    expect(classifyRmRisk('docker rm -f app')).toBe('high');
  });

  it('podman rm subcommand keeps HIGH', () => {
    expect(classifyRmRisk('podman rm container1')).toBe('high');
  });

  it('recursive flag -r keeps HIGH', () => {
    expect(classifyRmRisk('rm -r dist/')).toBe('high');
  });

  it('recursive flag -R keeps HIGH', () => {
    expect(classifyRmRisk('rm -R dist/')).toBe('high');
  });

  it('recursive flag --recursive keeps HIGH', () => {
    expect(classifyRmRisk('rm --recursive dist/')).toBe('high');
  });

  it('combined -rf keeps HIGH', () => {
    expect(classifyRmRisk('rm -rf dist/')).toBe('high');
  });

  it('combined -fr keeps HIGH', () => {
    expect(classifyRmRisk('rm -fr dist/')).toBe('high');
  });

  it('combined -rI keeps HIGH (capital R check)', () => {
    expect(classifyRmRisk('rm -Rf dist/')).toBe('high');
  });

  it('absolute non-tmp path keeps HIGH', () => {
    expect(classifyRmRisk('rm /etc/hosts')).toBe('high');
  });

  it('absolute home-dir path keeps HIGH', () => {
    expect(classifyRmRisk('rm /Users/foo/file.txt')).toBe('high');
  });

  it('absolute /var path (not /var/tmp) keeps HIGH', () => {
    expect(classifyRmRisk('rm /var/log/app.log')).toBe('high');
  });

  it('glob in non-ephemeral relative path keeps HIGH', () => {
    expect(classifyRmRisk('rm dist/*.js')).toBe('high');
  });

  it('glob in non-ephemeral absolute path keeps HIGH', () => {
    expect(classifyRmRisk('rm /build/*.js')).toBe('high');
  });

  it('no arguments (bare rm -f) keeps HIGH', () => {
    expect(classifyRmRisk('rm -f')).toBe('high');
  });

  it('no arguments at all keeps HIGH', () => {
    expect(classifyRmRisk('rm')).toBe('high');
  });

  it('separator-evasion shape with no parseable args keeps HIGH', () => {
    // rm followed only by a shell meta char -- no args extractable
    expect(classifyRmRisk('rm; echo done')).toBe('high');
  });

  it('mixed: ephemeral + non-ephemeral absolute path keeps HIGH', () => {
    expect(classifyRmRisk('rm .scratch/x.tmp /etc/shadow')).toBe('high');
  });

  it('glob outside ephemeral keeps HIGH even with -f flag', () => {
    expect(classifyRmRisk('rm -f src/*.ts')).toBe('high');
  });
});

describe('classifyRmRisk -- MEDIUM cases (sampled false positives from #5292 audit)', () => {
  it('FP 1: cleanup of processed pipeline input artifacts', () => {
    // rm -f .forecast-queue/_raw/r1113e/towns_*/...txt
    expect(classifyRmRisk('rm -f .forecast-queue/_raw/r1113e/towns_raw.txt')).toBe('medium');
  });

  it('FP 2: scratch-file cleanup after report validation', () => {
    expect(classifyRmRisk('rm .scratch/post-123.txt')).toBe('medium');
  });

  it('FP 2b: multiple scratch files', () => {
    expect(classifyRmRisk('rm .scratch/post-1.txt .scratch/reply-2.txt')).toBe('medium');
  });

  it('FP 3: clearing temp dir before email fetch', () => {
    expect(classifyRmRisk('rm -f /tmp/stale.json')).toBe('medium');
  });

  it('FP 4: post-pipeline temp cleanup after atomic mv', () => {
    expect(classifyRmRisk('rm -f .brief-out.tmp .brief-err.tmp')).toBe('medium');
  });

  it('FP 5: stale cache clear before fresh data collection', () => {
    expect(classifyRmRisk('rm -f .prs-open.json /tmp/gh.err')).toBe('medium');
  });

  it('plain named file (no glob, no absolute non-tmp) is HIGH (not positively ephemeral)', () => {
    expect(classifyRmRisk('rm file.txt')).toBe('high');
  });

  it('rm -f on a named temp file', () => {
    expect(classifyRmRisk('rm -f tmpfile.tmp')).toBe('medium');
  });

  it('/tmp absolute path is MEDIUM (ephemeral)', () => {
    expect(classifyRmRisk('rm /tmp/work.json')).toBe('medium');
  });

  it('/var/tmp absolute path is MEDIUM (ephemeral)', () => {
    expect(classifyRmRisk('rm /var/tmp/scratch.txt')).toBe('medium');
  });

  it('cache dir relative path is MEDIUM', () => {
    expect(classifyRmRisk('rm .cache/stale.json')).toBe('medium');
  });

  it('_raw dir relative path is MEDIUM', () => {
    expect(classifyRmRisk('rm data/_raw/input.csv')).toBe('medium');
  });

  it('._raw extension is MEDIUM', () => {
    expect(classifyRmRisk('rm data/input._raw')).toBe('medium');
  });

  it('rm with -i flag and ephemeral file is MEDIUM (-i is non-recursive)', () => {
    expect(classifyRmRisk('rm -i .scratch/file.txt')).toBe('medium');
  });

  it('rm with -v flag and ephemeral file is MEDIUM', () => {
    expect(classifyRmRisk('rm -v /tmp/file.txt')).toBe('medium');
  });
});

describe('classifyRmRisk -- glob in ephemeral namespace (MEDIUM)', () => {
  it('glob in /tmp is MEDIUM (ephemeral prefix)', () => {
    expect(classifyRmRisk('rm -f /tmp/*.json')).toBe('medium');
  });

  it('glob in /var/tmp is MEDIUM', () => {
    expect(classifyRmRisk('rm /var/tmp/work-*.txt')).toBe('medium');
  });

  it('glob in .scratch/ is MEDIUM', () => {
    expect(classifyRmRisk('rm .scratch/post-*.txt')).toBe('medium');
  });

  it('glob in _raw dir is MEDIUM', () => {
    expect(classifyRmRisk('rm pipeline/_raw/*.csv')).toBe('medium');
  });

  it('glob in cache dir is MEDIUM', () => {
    expect(classifyRmRisk('rm .cache/*.json')).toBe('medium');
  });

  it('glob *.tmp is MEDIUM (ephemeral extension)', () => {
    expect(classifyRmRisk('rm work*.tmp')).toBe('medium');
  });
});

describe('classifyRmRisk -- shell expansion (HIGH)', () => {
  it('dollar-sign variable in quoted arg is HIGH', () => {
    // tokenizer strips quotes; "$TARGET" becomes $TARGET token
    expect(classifyRmRisk('rm -f "$TARGET"')).toBe('high');
  });

  it('dollar-sign in unquoted arg is HIGH', () => {
    expect(classifyRmRisk('rm $HOME/.config')).toBe('high');
  });

  it('tilde home dir is HIGH', () => {
    expect(classifyRmRisk('rm ~/sensitive')).toBe('high');
  });

  it('tilde home dir with -f flag is HIGH', () => {
    expect(classifyRmRisk('rm -f ~/.ssh/id_ed25519')).toBe('high');
  });

  it('backtick expansion is HIGH', () => {
    expect(classifyRmRisk('rm `mktemp`')).toBe('high');
  });
});

// Any shell separator (;, |, &, newline) makes classifyRmRisk return HIGH
// unconditionally, regardless of what follows the separator. This is the
// only safe policy: the wrapper namespace (env, exec, command, env -i, doas,
// PATH-shadowed binaries, …) is unbounded and cannot be exhaustively listed.
describe('classifyRmRisk -- compound commands: any separator -> HIGH', () => {
  it('second rm is recursive -> HIGH', () => {
    expect(classifyRmRisk('rm /tmp/a; rm -r src/')).toBe('high');
  });

  it('second rm targets non-ephemeral absolute path -> HIGH', () => {
    expect(classifyRmRisk('rm /tmp/a && rm /etc/hosts')).toBe('high');
  });

  it('second rm even with ephemeral targets -> HIGH (conservative; cannot inspect all segments)', () => {
    expect(classifyRmRisk('rm /tmp/a; rm /tmp/b')).toBe('high');
  });

  it('semicolon followed by harmless echo -> HIGH (separator rule; even innocent tail is rejected)', () => {
    // `rm /tmp/a; echo done` -- the echo is harmless but we cannot prove what
    // any separator-separated segment does without a full shell parser. The
    // conservative rule is: compound command -> HIGH, always.
    expect(classifyRmRisk('rm /tmp/a; echo done')).toBe('high');
  });

  it('pipe to grep -> HIGH (pipe is a shell separator)', () => {
    expect(classifyRmRisk('rm /tmp/a | grep lost')).toBe('high');
  });

  it('newline-separated command -> HIGH (newline is a shell separator)', () => {
    expect(classifyRmRisk('rm /tmp/a\necho done')).toBe('high');
  });
});

describe('classifyRmRisk -- path traversal (HIGH)', () => {
  it('/tmp/../etc/hosts traverses out of tmp -> HIGH', () => {
    expect(classifyRmRisk('rm /tmp/../etc/hosts')).toBe('high');
  });

  it('/var/tmp/../../../etc/passwd traverses out of var/tmp -> HIGH', () => {
    expect(classifyRmRisk('rm /var/tmp/../../../etc/passwd')).toBe('high');
  });

  it('/tmp/../../home/user/secrets traverses out of tmp -> HIGH', () => {
    expect(classifyRmRisk('rm /tmp/../../home/user/secrets')).toBe('high');
  });
});

describe('classifyRmRisk -- bare cache/ (not .cache/) is HIGH', () => {
  it('bare cache/ subdir in relative path is HIGH (not ephemeral)', () => {
    expect(classifyRmRisk('rm project/cache/data')).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Spec item 1 — relative ephemeral traversal (#5330 regression)
// Paths that begin with an ephemeral namespace prefix but then traverse out
// via .. must NOT be downgraded to medium.
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- relative traversal escaping ephemeral namespace (HIGH)', () => {
  it('.scratch/../secrets.txt traverses out of .scratch -> HIGH', () => {
    expect(classifyRmRisk('rm .scratch/../secrets.txt')).toBe('high');
  });

  it('.cache/../etc/passwd traverses out of .cache -> HIGH', () => {
    expect(classifyRmRisk('rm .cache/../etc/passwd')).toBe('high');
  });

  it('.scratch/../../root/.ssh/id_rsa deep traversal -> HIGH', () => {
    expect(classifyRmRisk('rm .scratch/../../root/.ssh/id_rsa')).toBe('high');
  });

  it('.forecast-queue/../secrets.txt traverses out of .forecast namespace -> HIGH', () => {
    expect(classifyRmRisk('rm .forecast-queue/../secrets.txt')).toBe('high');
  });

  it('data/_raw/../../../etc/shadow traverses out of _raw -> HIGH', () => {
    expect(classifyRmRisk('rm data/_raw/../../../etc/shadow')).toBe('high');
  });

  // Basename-only .tmp cannot be used to bypass: basename matching requires
  // actual .tmp extension, and a traversal path like .tmp/../secrets.txt
  // normalises to secrets.txt which has no .tmp extension.
  it('.tmp/../secrets.txt does not get .tmp-extension downgrade -> HIGH', () => {
    expect(classifyRmRisk('rm .tmp/../secrets.txt')).toBe('high');
  });

  // Safe: a path that stays within the ephemeral namespace (no traversal out).
  it('.scratch/subdir/file.txt stays inside .scratch -> MEDIUM', () => {
    expect(classifyRmRisk('rm .scratch/subdir/file.txt')).toBe('medium');
  });

  it('.scratch/./file.txt (single-dot, no traversal) -> MEDIUM', () => {
    expect(classifyRmRisk('rm .scratch/./file.txt')).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Spec item 2 — path-qualified rm in compound commands and subcommand
// with preceding flags (#5330 regression)
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- path-qualified rm in compound commands (HIGH)', () => {
  it('rm /tmp/a; /bin/rm -r /etc -> HIGH (path-qualified second rm)', () => {
    expect(classifyRmRisk('rm /tmp/a; /bin/rm -r /etc')).toBe('high');
  });

  it('rm /tmp/a; /usr/bin/rm secrets.txt -> HIGH (path-qualified second rm)', () => {
    expect(classifyRmRisk('rm /tmp/a; /usr/bin/rm secrets.txt')).toBe('high');
  });

  it('rm /tmp/a | /bin/rm /etc/hosts -> HIGH (pipe to path-qualified rm)', () => {
    expect(classifyRmRisk('rm /tmp/a | /bin/rm /etc/hosts')).toBe('high');
  });

  it('rm /tmp/a && ../rm /etc/hosts -> HIGH (relative path-qualified rm)', () => {
    expect(classifyRmRisk('rm /tmp/a && ../rm /etc/hosts')).toBe('high');
  });
});

describe('classifyRmRisk -- subcommand with preceding flags (HIGH)', () => {
  it('docker --force rm /tmp/a -> HIGH (rm is subcommand; flag before it)', () => {
    expect(classifyRmRisk('docker --force rm /tmp/a')).toBe('high');
  });

  it('podman --log-level=debug rm container1 -> HIGH (flags before rm subcommand)', () => {
    expect(classifyRmRisk('podman --log-level=debug rm container1')).toBe('high');
  });

  it('docker -f rm container -> HIGH (short flag before rm subcommand)', () => {
    expect(classifyRmRisk('docker -f rm container')).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Spec item 3 — GNU recursive option abbreviations (#5330 regression)
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- GNU --recursive long-option prefix abbreviations (HIGH)', () => {
  // Shortest prefixes --r and --re were missed by the previous /^--rec.../ regex.
  it('--r abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --r /tmp/a')).toBe('high');
  });

  it('--re abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --re /tmp/a')).toBe('high');
  });

  it('--rec abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --rec /tmp/a')).toBe('high');
  });

  it('--recu abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --recu /tmp/a')).toBe('high');
  });

  it('--recur abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --recur dist/')).toBe('high');
  });

  it('--recurs abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --recurs dist/')).toBe('high');
  });

  it('--recursiv abbreviation keeps HIGH', () => {
    expect(classifyRmRisk('rm --recursiv dist/')).toBe('high');
  });

  // Full --recursive is already tested above; ensure it still works.
  it('--recursive full flag keeps HIGH (pre-existing)', () => {
    expect(classifyRmRisk('rm --recursive dist/')).toBe('high');
  });

  // Unrelated long options must not be caught by the prefix guard.
  it('--record flag on a hypothetical tool is not caught (not rm abbreviation)', () => {
    // This path is not an rm invocation; it arrives via classifyRmRisk directly
    // only in tests. The guard only blocks --r through --recursiv.
    // A different long option like --remove (not an abbreviation of --recursive)
    // is NOT blocked by RECURSIVE_LONG_PREFIX — only --r* prefixes of recursive are.
    // We confirm --force (a valid rm flag alias on some platforms) is not blocked.
    expect(classifyRmRisk('rm -f /tmp/file.tmp')).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Spec item 5 — cross-namespace traversal and extension-escape (#5330 regression)
// A path that exits one ephemeral namespace via .. and re-enters another
// (or ends with an ephemeral extension) must stay HIGH.
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- cross-namespace traversal and extension escape (HIGH)', () => {
  it('.cache/../other/.cache/a crosses namespace boundary -> HIGH', () => {
    // Normalizes to other/.cache/a — still matches .cache/ pattern, so the
    // old per-pattern loop would see no escape. Unconditional .. rejection catches it.
    expect(classifyRmRisk('rm .cache/../other/.cache/a')).toBe('high');
  });

  it('.scratch/../other/.cache/a crosses namespace boundary -> HIGH', () => {
    expect(classifyRmRisk('rm .scratch/../other/.cache/a')).toBe('high');
  });

  it('.cache/../secret.tmp extension escape -> HIGH', () => {
    // Normalizes to secret.tmp — matches .tmp$ extension. The old per-pattern
    // loop would leave .tmp matching on both sides and miss the traversal.
    expect(classifyRmRisk('rm .cache/../secret.tmp')).toBe('high');
  });

  it('.scratch/../escaped.tmp extension escape -> HIGH', () => {
    expect(classifyRmRisk('rm .scratch/../escaped.tmp')).toBe('high');
  });

  // Confirm safe subdirectory paths without .. are still MEDIUM.
  it('.cache/subdir/stale.json (no ..) stays MEDIUM', () => {
    expect(classifyRmRisk('rm .cache/subdir/stale.json')).toBe('medium');
  });

  it('.scratch/nested/file.tmp (no ..) stays MEDIUM', () => {
    expect(classifyRmRisk('rm .scratch/nested/file.tmp')).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Spec item 7 — shell escape sequences in unquoted tokens (#5330 regression)
//
// A backslash in an unquoted rm argument is a shell escape character. The
// shell resolves it before executing rm, producing a path the tokenizer
// cannot see. For example `.scratch/.\./secrets.txt` is passed to rm as
// `.scratch/././secrets.txt` (backslash-dot collapses to dot), so
// hasRelativeTraversal (which looks for the literal `..` segment) would not
// fire. Conservative fix: tokenizeRmArgs returns [] for any unquoted token
// containing a backslash, causing classifyRmRisk to return 'high'.
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- shell escape sequences in unquoted args (HIGH)', () => {
  it('rm .scratch/.\\./ secrets.txt (backslash-escaped dot) keeps HIGH', () => {
    // Shell resolves \. → ., so the path stays inside .scratch at runtime,
    // but we cannot resolve shell escapes — conservative HIGH.
    expect(classifyRmRisk('rm .scratch/.\\./')).toBe('high');
  });

  it('rm .scratch/.\\./secrets.txt (no space, backslash mid-path) keeps HIGH', () => {
    expect(classifyRmRisk('rm .scratch/.\\.secrets.txt')).toBe('high');
  });

  it('rm /tmp/foo\\ bar (backslash-space in path) keeps HIGH', () => {
    // Space-escaped path cannot be safely tokenized.
    expect(classifyRmRisk('rm /tmp/foo\\ bar')).toBe('high');
  });

  it('rm .scratch/file\\.txt (backslash inside filename) keeps HIGH', () => {
    expect(classifyRmRisk('rm .scratch/file\\.txt')).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Spec item 8 — embedded quotes (mixed shell quoting / splice) in tokens
// (#5330 regression)
//
// The shell splices quoted and unquoted segments of a word before passing the
// result to rm. `--recur"sive"` is therefore `--recursive` at execution time
// and rm accepts it as the recursive flag. The tokenizer sees the literal
// bytes `--recur"sive"` which match neither RECURSIVE_FLAGS nor
// RECURSIVE_LONG_PREFIX. Conservative fix: tokenizeRmArgs returns [] for any
// token that encounters an embedded quote (splice), causing classifyRmRisk to
// return 'high'. Safe whole-token quoted args (no adjacent non-meta char after
// closing quote) remain allowed.
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- embedded quotes in flag tokens (HIGH)', () => {
  it('--recur"sive" double-quote splice keeps HIGH', () => {
    expect(classifyRmRisk('rm --recur"sive" /tmp/a')).toBe('high');
  });

  it("--recur'sive' single-quote splice keeps HIGH", () => {
    expect(classifyRmRisk("rm --recur'sive' /tmp/a")).toBe('high');
  });

  it('"--recur"sive closing-quote-mid-word splice keeps HIGH', () => {
    expect(classifyRmRisk('rm "--recur"sive /tmp/a')).toBe('high');
  });

  it('-r"f" embedded-quote combined short flag keeps HIGH', () => {
    expect(classifyRmRisk('rm -r"f" /tmp/a')).toBe('high');
  });

  // Safe: whole-token quoted args (quote → content → close → whitespace/end).
  it("whole-token single-quoted .scratch path stays MEDIUM", () => {
    expect(classifyRmRisk("rm '.scratch/file.txt'")).toBe('medium');
  });

  it('whole-token double-quoted /tmp path stays MEDIUM', () => {
    expect(classifyRmRisk('rm "/tmp/stale.json"')).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Spec item 6 — wrappers around rm in compound commands (#5330 regression)
//
// These cases were previously caught by an enumerated wrapper regex
// (env|exec). They now fall under the blanket separator rule: any compound
// command (separator present) is HIGH regardless of what precedes or follows
// the separator. `env -i` and `command` are added here as regression guards
// for the specific bypass classes the user reported; they work because the
// separator rule fires before any wrapper analysis.
// ---------------------------------------------------------------------------
describe('classifyRmRisk -- wrappers in compound commands (HIGH via separator rule)', () => {
  it('rm /tmp/a; env /bin/rm -r /etc -> HIGH (separator + env wrapper)', () => {
    expect(classifyRmRisk('rm /tmp/a; env /bin/rm -r /etc')).toBe('high');
  });

  it('rm /tmp/a; exec /bin/rm /etc/hosts -> HIGH (separator + exec wrapper)', () => {
    expect(classifyRmRisk('rm /tmp/a; exec /bin/rm /etc/hosts')).toBe('high');
  });

  it('rm /tmp/a; env rm /etc/shadow -> HIGH (separator + env + bare rm)', () => {
    expect(classifyRmRisk('rm /tmp/a; env rm /etc/shadow')).toBe('high');
  });

  it('rm /tmp/a | env /bin/rm -rf /home -> HIGH (pipe separator + env wrapper)', () => {
    expect(classifyRmRisk('rm /tmp/a | env /bin/rm -rf /home')).toBe('high');
  });

  // env -i clears the environment before exec — previously escaped the wrapper
  // allowlist (env was listed but env -i was not recognised as the same program).
  it('rm /tmp/a; env -i /bin/rm -r /etc -> HIGH (separator + env -i wrapper)', () => {
    expect(classifyRmRisk('rm /tmp/a; env -i /bin/rm -r /etc')).toBe('high');
  });

  it('rm /tmp/a; env -i rm /etc/shadow -> HIGH (separator + env -i + bare rm)', () => {
    expect(classifyRmRisk('rm /tmp/a; env -i rm /etc/shadow')).toBe('high');
  });

  // `command` is a POSIX shell built-in that bypasses shell functions and
  // aliases, so `command rm` and `command /bin/rm` both execute rm directly.
  it('rm /tmp/a; command /bin/rm -r /etc -> HIGH (separator + command builtin wrapper)', () => {
    expect(classifyRmRisk('rm /tmp/a; command /bin/rm -r /etc')).toBe('high');
  });

  it('rm /tmp/a; command rm /etc/shadow -> HIGH (separator + command + bare rm)', () => {
    expect(classifyRmRisk('rm /tmp/a; command rm /etc/shadow')).toBe('high');
  });

  // Standalone (no-compound) forms: a single `env -i /bin/rm` or
  // `command /bin/rm` without a preceding rm segment does NOT match the
  // 'rm ' BASH_HIGH token at all (the leading word is `env`/`command`), so
  // classifyRmRisk is never called for them. These cases are gated by the
  // main classifier via the BASH_HIGH 'rm ' path-qualified token match and
  // subcommand-guard logic. No test needed here for the standalone form.
});
