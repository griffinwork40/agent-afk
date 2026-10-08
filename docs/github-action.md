# `run-afk` GitHub Action

A reusable [composite action](../.github/actions/run-afk/action.yml) that installs
[agent-afk](https://www.npmjs.com/package/agent-afk) and runs a single `afk chat`
prompt inside a GitHub Actions workflow.

## Quick start

```yaml
# .github/workflows/my-workflow.yml
name: AI Review

on: [pull_request]

jobs:
  afk-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: griffinwork40/agent-afk/.github/actions/run-afk@main
        id: afk
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review the staged diff and summarise the key changes.

      - name: Print response
        run: echo "${{ steps.afk.outputs.response }}"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | **yes** | — | Anthropic API key. Pass via a repository secret (`${{ secrets.ANTHROPIC_API_KEY }}`). Never hard-code it in the workflow. |
| `prompt` | **yes** | — | Prompt forwarded to `afk chat`. Supports YAML multi-line literals (`\|`). |
| `afk-version` | no | `latest` | npm version of agent-afk to install (e.g. `5.0.0`, `latest`, or any dist-tag). Use `local` to skip the install step and run from a previously checked-out repo where `pnpm install` has already been called. |
| `node-version` | no | `22` | Node.js version. Must satisfy the `engines.node` field in agent-afk's `package.json` (`^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`). |
| `model` | no | *(repo default)* | Model slug forwarded to `afk chat --model`. When empty the repo's configured default is used. |
| `working-directory` | no | `.` | Directory to run `afk chat` from. A project-local `AFK.md` in this directory is picked up as the operator overlay. |
| `output-file` | no | *(none)* | When set, the response is also written to this path (relative to `working-directory`) so it can be uploaded as an artifact. |

## Outputs

| Output | Description |
|--------|-------------|
| `response` | The text response returned by `afk chat`. |

## Security

- The `anthropic-api-key` input is mapped to `ANTHROPIC_API_KEY` in the env block
  of the run step — it is **never echoed** to logs or passed as a shell argument.
- Third-party actions inside the composite action are pinned to their full commit
  SHA, not a mutable tag, to prevent supply-chain attacks.
- No other secrets or tokens are required. The action deliberately unsets
  `AFK_TELEGRAM_BOT_TOKEN` so the Telegram subsystem is never initialised in CI.

## Advanced: run from the local repo checkout

When you want to test a change to agent-afk itself (e.g. in CI for this repo),
pass `afk-version: local` and call `pnpm install --frozen-lockfile` before
invoking the action:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: pnpm/action-setup@v4

  - uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: pnpm

  - run: pnpm install --frozen-lockfile

  - uses: ./.github/actions/run-afk
    with:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      afk-version: local
      prompt: 'Hello from a local build!'
```

## Advanced: capture the response as an artifact

```yaml
- uses: griffinwork40/agent-afk/.github/actions/run-afk@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: Generate a release summary.
    output-file: release-notes.md

- uses: actions/upload-artifact@v4
  with:
    name: release-notes
    path: release-notes.md
```

## Workflow lint / validation CI

A [validation workflow](../.github/workflows/validate-action.yml) checks the
`action.yml` schema on every PR that touches `.github/actions/run-afk/`. It does
**not** send real API requests; it verifies that the YAML is well-formed and that
all required inputs are declared. See `tests/github-action.test.ts` for the
companion vitest suite.
