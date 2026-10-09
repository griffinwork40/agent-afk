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
      # pinned to SHA for supply-chain safety; tag: actions/checkout@v4
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262

      # pinned to SHA for supply-chain safety; tag: griffinwork40/agent-afk/.github/actions/run-afk@v5
      - uses: griffinwork40/agent-afk/.github/actions/run-afk@<pin-to-a-release-SHA>
        id: afk
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review the staged diff and summarise the key changes.

      - name: Print response
        run: echo "${{ steps.afk.outputs.response }}"
```

> **Supply-chain note:** All third-party actions inside the composite action are
> already pinned to full commit SHAs.  The examples above follow the same
> convention — replace `<pin-to-a-release-SHA>` with the full 40-character commit
> SHA of the agent-afk release you want to target.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | **yes*** | — | Anthropic API key. Pass via a repository secret (`${{ secrets.ANTHROPIC_API_KEY }}`). Never hard-code it in the workflow. *Required when routing to Anthropic models; may be omitted when using an OpenAI or xAI provider exclusively. |
| `prompt` | **yes** | — | Prompt forwarded to `afk chat`. Supports YAML multi-line literals (`\|`). |
| `openai-api-key` | no | *(empty)* | OpenAI API key (`OPENAI_API_KEY`). Required when routing to OpenAI or OpenAI-compatible models (e.g. `gpt-4o`, `o3`). Pass via a repository secret. |
| `xai-api-key` | no | *(empty)* | xAI API key (`XAI_API_KEY`). Required when routing to xAI Grok models in API-key mode. Pass via a repository secret. |
| `afk-version` | no | `latest` | npm version of agent-afk to install (e.g. `5.0.0`, `latest`, or any dist-tag). Use `local` to run from the checked-out repo (see [Local mode](#advanced-run-from-the-local-repo-checkout)). |
| `node-version` | no | `22` | Node.js version. Must satisfy the `engines.node` field in agent-afk's `package.json` (`^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`). |
| `model` | no | *(repo default)* | Model slug forwarded to `afk chat --model`. When empty the repo's configured default is used. |
| `working-directory` | no | `.` | Directory to run `afk chat` from. A project-local `AFK.md` in this directory is picked up as the operator overlay. |
| `output-file` | no | *(none)* | When set, the response is also written to this path (relative to `working-directory`) so it can be uploaded as an artifact. |

## Outputs

| Output | Description |
|--------|-------------|
| `response` | The assistant's text response, extracted from `afk chat --format json`. Contains only the message content, with no spinner output, headings, or cost metadata. |

## Security

- The `anthropic-api-key` input is mapped to `ANTHROPIC_API_KEY` in the `env:`
  block of the run step. It is **never echoed** to logs or passed as a shell
  argument.
- All other inputs that appear in `run:` scripts (`prompt`, `model`,
  `output-file`, `afk-version`) are also routed through `env:` variables
  (`AFK_PROMPT`, `INPUT_MODEL`, `INPUT_OUTPUT_FILE`, `INPUT_AFK_VERSION`). No
  `${{ inputs.* }}` expression appears inside any `run:` body, which prevents
  shell injection when a prompt contains command-substitution characters such as
  `$(...)` or backticks.
- Third-party actions inside the composite action are pinned to their full commit
  SHA, not a mutable tag, to prevent supply-chain attacks.
- No other secrets or tokens are required. The action deliberately unsets
  `AFK_TELEGRAM_BOT_TOKEN` so the Telegram subsystem is never initialised in CI.
- The `GITHUB_OUTPUT` multiline delimiter is generated at runtime using
  `openssl rand -hex 16` (with a `/dev/urandom` fallback) so a crafted prompt
  cannot inject a delimiter and truncate or overwrite subsequent outputs.

## Response output

The action runs `afk chat --format json`, which writes a structured JSON object
to stdout (spinner and cost metadata go to stderr and appear in the CI log, not
in the captured output). The `response` output and `output-file` contain only the
plain-text assistant message extracted from the `message` field of that JSON
object, with no terminal formatting, headings, or cost lines.

## Advanced: run from the local repo checkout

When you want to test a change to agent-afk itself (for example, in the CI
workflow for this repo), pass `afk-version: local`. In local mode the action:

1. Resolves the repository root from its own location inside the checkout.
2. Builds the CLI from source with `pnpm run build:dist`.
3. Invokes `node dist/cli.mjs` directly instead of the global `afk` binary.

The caller must run `pnpm install --frozen-lockfile` before invoking the action
so that all build dependencies are present.

```yaml
steps:
  # pinned to SHA for supply-chain safety; tag: actions/checkout@v4
  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262

  # pinned to SHA for supply-chain safety; tag: pnpm/action-setup@v6
  - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86

  # pinned to SHA for supply-chain safety; tag: actions/setup-node@v4
  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
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
# pinned to SHA for supply-chain safety; tag: griffinwork40/agent-afk/.github/actions/run-afk@v5
- uses: griffinwork40/agent-afk/.github/actions/run-afk@<pin-to-a-release-SHA>
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: Generate a release summary.
    output-file: release-notes.md

# pinned to SHA for supply-chain safety; tag: actions/upload-artifact@v4
- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
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
