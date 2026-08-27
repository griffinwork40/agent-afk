# ADR 0003 — Credibility signals: PR/test counts over npm downloads

Status: **Accepted**

Closes issue #1282.

---

## Context

The npm "downloads last month" counter for `agent-afk` is inflated by registry
mirrors and security scanners. A spot-check of the download log found that 636
of 905 versions with any downloads had exactly **1** download — the mirror
signature pattern. The raw download number therefore tells a prospective user
nothing meaningful about real adoption.

Carrying a download-count badge (e.g. `shields.io/npm/dm/agent-afk`) on the
README or website would:

- Present a number that is mostly mirror noise as a trust signal.
- Create an ongoing maintenance obligation to explain why the figure fluctuates
  even when no real users showed up.
- Undermine the project's stated commitment to accuracy and auditability.

## Decision

**npm download counts are not used as credibility signals anywhere in this
project** — not in README.md badges, not in the website landing page, not in
documentation prose, and not in any marketing copy.

The following signals are preferred because they are **unfakeable** and directly
reflect real work:

| Signal | Why it's trustworthy |
|---|---|
| **Merged PRs** (~915+) | Every merge is a public, auditable, date-stamped event on GitHub. |
| **Test files** (~899+) | A count of `*.test.ts` files under `src/` and `tests/` that CI must pass. |
| **Published versions** (~916+) | Each version is a real release decision, visible on npmjs.com. |
| **Custom CI audit gates** (10+) | Named test files in `tests/` that audit project-specific invariants (deps, function size, terminal width, chalk SGR, etc.). |

## Consequences

1. The README badge row **does not** include an npm-downloads badge and
   **must not** gain one in future PRs.
2. The website (`website/`) **does not** cite download counts in any stats
   section and must not add them.
3. If a future contributor wants to add a download badge, the preferred
   response is to link to this ADR and suggest one of the signals in the table
   above instead.
4. Periodic re-evaluation is fine (e.g. if npm publishes a verified-human
   download API), but the bar is: the number must be unfakeable by automated
   scanners.
