# Contributing to Agent AFK

Thanks for your interest in contributing! Here's everything you need to get started.

## Prerequisites

- **Node.js ≥ 20** (check: `node --version`)
- **pnpm only** — the lockfile is pnpm-specific; npm/yarn are not supported

## Dev loop

```bash
pnpm install        # install dependencies
pnpm build          # tsc compile + copy prompt *.md files → dist/
pnpm test           # run all tests with vitest
pnpm lint           # tsc --noEmit (strict type-check, no emit)
```

Run a single test file:
```bash
pnpm test src/agent/session.test.ts
```

Run a single test by name:
```bash
pnpm test -t "sends a message"
```

## TypeScript — strict mode

`tsconfig.json` is maximally strict: `noUnusedLocals`, `noUnusedParameters`,
`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must
pass `pnpm lint` (`tsc --noEmit`) before submitting.

## Code style conventions

- Long comment blocks (≥15 lines) must open with `// Invariant:`, `// Contract:`, or `// History:`.
- No source code under `src/` imports from any model SDK directly — only through `src/agent/providers/`.
- After adding an `@anthropic-ai/sdk` import, run `pnpm audit:sdk:update-lock` and fill in the `reason` field.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your changes, ensuring `pnpm lint` and `pnpm test` pass locally.
3. Open a PR using the pull request template.
4. **Sign off your commits (DCO).** This project uses the
   [Developer Certificate of Origin](https://developercertificate.org/) instead
   of a CLA. Add a `Signed-off-by` line to every commit:

   ```bash
   git commit -s -m "your message"
   ```

   By signing off, you certify the DCO and agree that your contribution is
   licensed under **Apache-2.0** (inbound = outbound — the same license the
   project ships under). No copyright assignment, no separate agreement.

See [LICENSING.md](LICENSING.md) for the open-core model.

## Support

> **The free/OSS tier carries no support promise.** Bug reports and PRs are
> welcome, but response time is best-effort. Priority support is a Pro/Team
> offering — see [LICENSING.md](LICENSING.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
Please read it before participating.
