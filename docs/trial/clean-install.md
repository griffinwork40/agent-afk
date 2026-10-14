# Clean install on a tester's machine

Use your own macOS, Linux, or Windows terminal, a repository you own, and a model account you control. No source checkout or pnpm is required. This guide follows `README.md` Quick Start, `package.json` engines, and the command registrations cited below. Windows has source-level support for the CLI and service manager, although the public quickstart does not separately document a Windows installer. The npm path below also applies in PowerShell; record Windows-specific failures rather than assuming platform parity.

## Install and check

1. Install Node.js from [nodejs.org](https://nodejs.org/) in a supported version: **22.22.2 through 22.x, 24.15.0 through 24.x, or 26+**. Node 23/25 and early Node 22/24 are not supported. Run `node --version` and `npm --version`. If either command fails, fix your Node installation first.
2. Run `npm install -g agent-afk`, then `afk --version`. If your shell cannot find `afk`, check the npm global executable directory is on your PATH. Do not use `sudo` as a first workaround; fix the Node/npm installation permissions instead.
3. Choose **one** authentication route. Keys may incur provider charges. Do not paste secrets into chat, screenshots, or the facilitator's log.

   * **Anthropic API key:** run `afk config env set ANTHROPIC_API_KEY` and enter your key at the masked prompt. Alternatively `afk login` prompts for a key or OAuth token and writes it under `~/.afk/config/afk.env`; it does **not** initiate a browser subscription sign-in. Existing `ANTHROPIC_API_KEY` in your environment takes priority.
   * **Claude subscription OAuth:** if you already use the Claude Code CLI, run `claude login` using its own sign-in flow, then `afk doctor`. AFK can read Claude Code's keychain OAuth credential. This requires that separate CLI and a valid subscription; `afk login` will report an existing credential instead of prompting when it detects one.
   * **OpenAI API key:** run `afk config env set OPENAI_API_KEY`, enter the key at the masked prompt, then select an OpenAI model for the smoke test with `afk chat -m gpt-5 "hello"`. `afk login` is Anthropic-only.
   * **ChatGPT subscription OAuth:** if the Codex CLI is installed, run `codex login` in its own terminal flow, then `afk chat -m gpt-5 "hello"`. AFK reads `~/.codex/auth.json` only when no explicit OpenAI API key overrides it. The Codex CLI owns token refresh; AFK does not. The subscription backend is undocumented and may change.

4. From your repository's root, run `afk doctor` and a smoke test: `afk chat "hello"` for Anthropic, or the OpenAI smoke test above for an OpenAI route. If `afk doctor` flags auth or connectivity, note the exact message in the intervention log. An OpenAI-only user should not assume an Anthropic-specific doctor warning means their OpenAI chat failed; check the model-specific smoke test.
5. Run `afk i` from your repository root. Type `/get-started` and press Enter for optional guided setup, then choose a task from [task-pack.md](task-pack.md). In the REPL, `/help` lists commands. Do not install a daemon or Telegram bot just for this trial.

**⚠ Replace:** The smoke-test model `gpt-5` is an actual example from the current provider docs, not a guarantee your account has access. If unavailable, use an OpenAI model your account supports with `-m`; record that choice. No literal key or machine-specific directory is embedded in a runnable command here.

## After the trial

Run `npm uninstall -g agent-afk` to remove the global package. This does **not** delete local AFK data or revoke model-provider credentials. If you installed a persistent AFK service separately, run `afk service status` and, for each AFK service you own, `afk service uninstall daemon` or `afk service uninstall telegram` **before** removing the package. Do not uninstall another person's services. Review `~/.afk/config/afk.env` for credentials and remove only trial data you personally want removed (including `~/.afk/state/` and `~/.afk/agent-framework/`). Leave pre-existing data alone. `claude login` and `codex login` create credentials outside AFK; use those CLIs' own account controls if revocation is wanted.

## Where are my logs?

`afk trace list` lists witness runs; `afk trace show` displays the latest; `afk trace show --results` can include tool results and may reveal source. Inspect locally before sharing. By default witness traces are under `~/.afk/state/witness/`, sessions under `~/.afk/state/sessions/`, transcripts under `~/.afk/state/transcripts/`, application logs under `~/.afk/logs/`, and telemetry under `~/.afk/agent-framework/`. `AFK_HOME` and `AFK_STATE_DIR` can relocate these tiers. No logs need to be sent to the facilitator.

**Source checks:** `README.md:22-40`, `package.json:127-130`, `src/cli/commands/login-command.ts:18-96`, `src/cli/commands/config-command.env.ts:63-90`, `src/cli/commands/trace.ts:201-278`, `src/cli/commands/interactive.ts:71-98`, `src/cli/commands/shared-command-options.ts:82-114`, `src/skills/get-started/index.ts:44-57`, `src/paths.ts:4-24,194-225`, `src/paths.witness.ts:23-35`, `website/content/docs/configuration/api-keys.mdx:9-88`.
