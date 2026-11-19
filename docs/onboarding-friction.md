# Onboarding friction ledger

Snapshot: 2026-11-19. This is an observation backlog, not a list of reproduced bugs.
Nothing here has been observed on a real clean machine yet. Hosted-runner results
are useful evidence, but are not clean-machine observations.

Status meanings (including mixed qualifiers in the original inventory):
- **confirmed**: source or documentation was read, not runtime behaviour verified.
- **reported**: a research agent cited it without a coordinator reread.
- **inferred**: reasoning or ecosystem knowledge; needs observation.
- **external**: evidence from another tool, not afk.
- **unresolved**: conflicting evidence or an open question.
- **blind spot**: not audited. A7 retains this original status explicitly.

After an observation, append a dated note under the relevant ID with OS, shell,
Node/npm/package versions, exact command, exit code, elapsed time, log artifact
link, and whether the symptom occurred. Distinguish hosted runner from retail
machine and interactive from redirected stdin. Preserve the original status and
evidence; do not promote a code-reading claim into a reproduced failure.
Redact private information before sharing logs. Never include credentials.
Candidate fixes below are proposals, not existing commands or approved changes.
See [the human protocol](onboarding-clean-machine-checklist.md).

## Original inventory (2026-11-19)

Source: seven read-only research agents plus coordinator rereads, all on 2026-11-19 against `main` at `234b2864e`.

Status key:

- **confirmed**: the coordinator read the cited file and saw it.
- **reported**: a research agent cited it; the coordinator did not reread it.
- **inferred**: follows from ecosystem knowledge or reasoning; needs a real machine.
- **external**: seen in other tools' issue trackers, not in afk.

Severity key: **blocker** (a non-developer cannot proceed without outside help), **confusing**, **papercut**.

Nothing in this file has been observed on a real clean machine.

## A. Discover

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| A1 | both | confusing | reported | Docs state the audience is developers and engineers | `website/content/docs/index.mdx:10-12` | Add a "never used a terminal?" path from the top |
| A2 | both | confusing | confirmed | README says "That's it. You're in." after four commands with no prerequisites explained | `README.md:34` | Say what is needed first, link the from-zero guide |
| A3 | both | papercut | confirmed | README first code block includes `afk whatif --append ... --verify`; copying the block runs an advanced command | `README.md:24-32` | Trim Quick Start to three commands |
| A4 | both | confusing | confirmed | Docs navigation has no beginner page | `website/content/docs/meta.json` | Add one under "Get started" |
| A5 | both | confusing | reported | Every onboarding example assumes a code project; no non-coding use is shown | `quickstart.mdx:38-41`, `first-session.mdx:54-60`, `skills/bundled.mdx:10-24` | One non-coding example |
| A6 | mac | papercut | inferred | README video may not play in Safari | `README.md:15-18` | Check on a real machine |
| A7 | both | unknown | blind spot | The agentafk.com landing page source is not in this repo and was not audited | none | Audit separately |

## B. Open a terminal

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| B1 | both | blocker | confirmed | Docs require "a terminal" and never say what one is or how to open it | `website/content/docs/installation.mdx:12` | Per-OS page with the exact clicks |
| B2 | both | blocker | confirmed | "change into the project you want afk to inspect" with no explanation of folders or `cd` | `website/content/docs/quickstart.mdx:38` | Explain, or let the first run work from any folder safely |
| B3 | win | confusing | confirmed | README commands are in `bash` blocks and never say where to type them on Windows | `README.md:24` | Name Windows Terminal and PowerShell |
| B4 | both | confusing | inferred | How to paste, how to quit (Cmd+Q closes the whole Terminal), how to reopen tomorrow are never covered | none | Cover in the from-zero page |

## C. Get a runtime

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| C1 | both | blocker | confirmed | Node requirement is a semver range plus a plain sentence, with no download link; steps start at `node --version` | `installation.mdx:10,22-29` | Link the LTS installer; later, bundle Node |
| C2 | both | confusing | inferred | nodejs.org offers several install methods and version numbers a newcomer cannot choose between | none | Say exactly which button |
| C3 | win | blocker | inferred | The Node installer needs administrator rights; a work laptop stops here | none | Per-user runtime in the installer |
| C4 | both | confusing | confirmed (code), unverified (output) | No runtime Node version guard; startup errors go through a raw `console.error(err)` | `src/cli/index.ts:306`; no `process.versions.node` check in `src/cli/index.ts` | Friendly guard before the bundle loads |
| C5 | both | papercut | reported | Bundle targets node20 while `engines` requires 22.22.2 or newer | `scripts/build-dist.mjs:101`, `package.json:155-157` | Align |

## D. Install afk

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| D1 | both | blocker | confirmed | npm is the only install path; no install script, Homebrew, winget, or binary is tracked | `git ls-files` search, zero hits | One-command installer |
| D2 | mac | blocker | inferred | `npm install -g` fails with EACCES after the nodejs.org installer; docs mention permissions only on the Linux tab | `installation.mdx:65` (Linux only) | Installer with a user-owned prefix |
| D3 | mac | confusing | confirmed | PATH hint tells the user to append an export line to `~/.zshrc` and `source` it, with no plain explanation | `scripts/postinstall.mjs:343-364` | Plain wording; installer fixes PATH |
| D4 | win | confusing | confirmed | PATH hint is skipped entirely on Windows | `scripts/postinstall.mjs:328-330` | Real Windows hint |
| D5 | both | confusing | unresolved | Newer npm may skip or block install scripts, so the PATH hint never shows; a code comment says npm 11.19 and later skip silently, an agent says npm 12 blocks and 11.16 and later only warn | `src/cli/update-checker.ts:356-358`, `README.md:25` | Observe with real npm versions |
| D6 | both | papercut | confirmed | pnpm skips postinstall unless approved | `README.md:36` | Already documented |
| D7 | both | confusing | inferred | npm prints deprecation, funding, and audit lines plus a long silent pause that read as errors | none | One line in the guide: this is normal |
| D8 | win | blocker if true | unresolved | `better-sqlite3` ships prebuilds and has no install script, but upstream issue 1516 reports npm attempting a compile on Windows without Python | `package.json:167` | Observe on a machine with no build tools |
| D9 | both | confusing | reported, inferred | With a missing sqlite binding the REPL shows a misleading "Invalid options" | `src/cli/commands/interactive.ts:217`, `bootstrap-session-builder.ts:240` | Name the real cause |
| D10 | both | confusing | reported | Chromium is never downloaded; first browser use fails with a developer-style install hint | `playwright-missing.ts:195` | Plain message |
| D11 | win | blocker | inferred | The default execution policy on a retail machine blocks `npm.ps1` itself, before afk is involved | third-party repro, not run here | Tell users to use `npm.cmd`, or ship `afk.cmd` |
| D12 | win | blocker | confirmed | Docs force a choice between native Windows and WSL2 with no recommendation; the WSL route needs an elevated PowerShell | `installation.mdx:74-84` | Recommend native; move WSL to an aside |
| D13 | win | confusing | confirmed | "install a supported Windows Node.js version and Git for Windows" with no links | `installation.mdx:76` | Links and which options to pick |
| D14 | win | blocker if true | inferred | Smart App Control on new Windows 11 installs may block unsigned native files | none | Observe on a fresh image |
| D15 | win | papercut | confirmed (line), inferred (effect) | postinstall is run as `node scripts/postinstall.mjs \|\| true`; `cmd.exe` has no `true`, so a crash in the script would fail the install | `package.json:26` | `\|\| exit 0` |
| D16 | both | confusing | confirmed | CI never installs the package the way a user does: Windows runs from source with pnpm and smoke-tests `node dist/cli.mjs` | `.github/workflows/ci.yml:543-597` | Observation workflow |
| D17 | mac | confusing | confirmed | `ci.yml` has no macOS runner at all | `runs-on` values in `ci.yml`: ubuntu-latest, windows-2022 | Observation workflow |
| D18 | both | confusing | external, inferred | Sync and backup tools (OneDrive, iCloud) modifying `node_modules`; user folders with spaces, apostrophes, or non-ASCII characters; long paths | gemini-cli issue 27778 | Observe |

## E. First launch and sign-in

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| E1 | both | blocker | confirmed | Bare `afk` with no credential prints only `Anthropic API key or OAuth token: ` with hidden input: no explanation, no link, no provider choice | `src/cli/auth-wizard.ts:20`, `src/cli/first-run.ts:65-75` | Guided sign-in |
| E2 | both | blocker | confirmed | The quickstart never says where a key comes from or that it costs money | `website/content/docs/quickstart.mdx:1-60` | Link and one sentence on billing |
| E3 | both | confusing | confirmed (code) | Nothing warns that pasted text stays invisible | `src/cli/auth-wizard.ts:19-21` | One line before the prompt |
| E4 | both | confusing | confirmed | Any non-empty input is saved and reported as success; nothing tests it until the first message fails | `src/cli/auth-wizard.ts:41-51` | Live check before saving |
| E5 | both | blocker | confirmed | A key from another provider is saved as `ANTHROPIC_API_KEY` | `src/cli/auth-wizard.ts:41-49` | Key sanity check |
| E6 | both | confusing | confirmed | "Restart any running afk daemon to pick up the new token." is shown to first-time users | `src/cli/auth-wizard.ts:52` | Only when a daemon is running |
| E7 | both | blocker | confirmed | `afk login` is Anthropic only with no browser flow; OpenAI users are told to `export OPENAI_API_KEY=...` | `src/cli/commands/login-command.ts:44-56`, `quickstart.mdx:32` | Provider menu |
| E8 | both | blocker | confirmed | The credential gate only runs for the Anthropic route; there is no provider picker | `src/cli/first-run.ts:65` | Provider menu |
| E9 | both | blocker | reported | OpenAI first message fails with "No OpenAI auth found. Set OPENAI_API_KEY, ..." | `src/agent/providers/openai-compatible/auth.ts:374-376` | Provider menu |
| E10 | both | blocker | reported | ChatGPT subscription needs the separate Codex CLI; the token is never refreshed | `openai-compatible/auth.ts:356-363` | Document; later, a login flow |
| E11 | both | blocker | reported | Local models need hand-set environment variables | `README.md:162` | Provider menu |
| E12 | both | blocker | reported | Claude subscription users must install Claude Code and run `claude login` first | `quickstart.mdx:32`, `keychain.ts:229-280` | Policy call; out of scope |
| E13 | both | confusing | confirmed (README), inferred (behaviour) | `npx agent-afk chat "hello"` is advertised with no sign-in step and hits the same gate | `README.md:38`, `src/cli/first-run.ts:13` | Mention sign-in |
| E14 | win | confusing | confirmed (code), inferred (effect) | The hidden prompt treats only `\x7f` as backspace; a console sending `\b` corrupts the key | `src/utils/prompt-secret.ts:70` | Accept `\b` |
| E15 | win | papercut | reported | Docs call the key file `~/.afk/config/afk.env` and never give the Windows path | `quickstart.mdx:30`, `src/paths.ts:57,393` | Show the Windows path |
| E16 | both | confusing | external | Subscription versus API billing confusion is the largest complaint class in other tools' trackers | claude-code issue 16157, gemini-cli issue 2711 | Plain cost page at the start |

Works well, keep: masked entry, credential auto-detection from Claude Code and Codex (`login-command.ts:67-80`), the xAI device-code login (`provider.ts:176-208`), the non-interactive message (`first-run.ts:70`).

## F. First session

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| F1 | both | confusing, safety | confirmed | New installs default to `bypassPermissions` | `src/cli/config/types.ts:490` | Explain and offer a choice at first run |
| F2 | both | blocker, safety | reported | A newcomer launches in the home folder with full file access and no warning in the banner | `interactive.ts:268`, `quickstart.mdx:47` | Warn or ask when cwd is the home folder |
| F3 | both | confusing | confirmed | First-run banner lists `/skills`, `/help`, `/keys`; no `/get-started`, no example of what to type | `src/cli/commands/interactive/first-run.ts:81-87` | Name `/get-started`, add an example |
| F4 | both | confusing | reported | `/get-started` is run by the model, so it cannot help before a credential works | `src/skills/get-started/index.ts:53-54` | Non-model setup |
| F5 | both | confusing | reported | `/get-started` assumes developer knowledge (set `ANTHROPIC_API_KEY`, `git rev-parse`, hand-edit `afk.env`, `/init` scans the repo) | `src/skills/get-started/prompts/system.md:14,22,42,57` | Rewrite |
| F6 | win | papercut | reported | `/get-started` uses `uname` and says Windows services are unsupported; docs say Task Scheduler works | `system.md:45`, `run-as-service.mdx:62` | Fix text |
| F7 | both | confusing | reported | The screen clears on launch, which looks like a crash | `interactive.ts:266` | Leave a line of context |
| F8 | both | confusing | confirmed | A single plain word such as `afk setup` is sent to the paid model as a prompt unless it is a near miss of a real command | `unknown-command-guard.ts:116-124` | Register `setup` |
| F9 | both | confusing | confirmed (ordering) | The unknown-command check runs inside the action, after the credential gate hook, so a typo asks for a key first | `interactive.ts:124`, `first-run.ts:84` | Check before the gate |
| F10 | both | confusing | reported | Quitting: the `/exit` hint scrolls away; Ctrl+C needs a second press | `interactive.signal-handlers.ts:56-118` | Persistent hint |
| F11 | mac | papercut | inferred | A git call triggers the Xcode tools popup | none | Observe |
| F12 | win | blocker for non-Git users | confirmed (code), inferred (effect) | Without Git Bash the agent shell is bare `powershell.exe -Command`; agent runs of `npm` hit the script block | `src/utils/resolve-shell.ts:188` | Observe first; no Bypass without a repro |
| F13 | win | papercut | reported, inferred | PowerShell 5.1 output in the OEM code page is decoded as UTF-8 | `bash.overflow.ts:97` | Force UTF-8 |
| F14 | win | papercut | reported | Image paste is not implemented | `repl.mdx:166` | Document |

Works well, keep: the error classifier messages for a bad key, an empty balance (with a billing link), a rate limit, and no network (`classifier.ts:179,217-218,233,273`).

## G. Cost

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| G1 | both | blocker | confirmed | No spend cap by default; `AFK_MAX_BUDGET_USD` is unset | `website/content/docs/guides/unattended-runs.mdx:104` | Offer a cap at first run |
| G2 | both | confusing | confirmed (quickstart), reported (index) | The quickstart never mentions cost; the cost guide is not in the "Start here" cards | `quickstart.mdx:1-60`, `index.mdx:18-25` | Link it at the start |
| G3 | both | papercut | reported | `/cost` is session-local and must be typed | `usage-and-cost.mdx` | Show on exit |

## H. Away path (Telegram, service, schedules)

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| H1 | both | blocker | reported | Telegram setup assumes BotFather, bot tokens, and chat IDs; a wizard exists but starts after those | `surfaces/telegram.mdx:12-14`, `src/telegram/setup-wizard.ts` | Walkthrough with the exact taps |
| H2 | both | blocker | reported | Keeping it running needs launchd, systemd, or Task Scheduler knowledge; Linux needs `loginctl enable-linger` | `guides/run-as-service.mdx:44-66` | Offer service install at the end of setup |
| H3 | both | confusing | reported | Scheduling uses five-field cron with no reference link | `guides/scheduling.mdx:25` | Link or plain-language schedules |
| H4 | win | confusing | inferred | The Task Scheduler action may show a console window at logon; closing it kills the daemon | `src/service/windows/task-xml.ts:157,167` | Observe |
| H5 | both | blocker | reported | The Exa key requires hand-editing a hidden dotfile | `system.md:42` | A command that sets it |

## I. Week two (updates, reopening, removal)

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| I1 | both | papercut | confirmed | The update banner prints a raw `npm install -g --allow-scripts=agent-afk agent-afk` command | `src/cli/update-checker.ts:206-207` | Say `afk update` |
| I2 | win | blocker (opt-in setting) | confirmed (code), inferred (effect) | Opt-in auto-update spawns bare `npm` with no shell and no error listener | `src/cli/update-checker.ts:359-363` | Reuse `resolveNpmCli` as `afk update` does |
| I3 | win | confusing | reported, inferred | The background version check is detached without `windowsHide`; a console window may flash | `src/cli/update-checker.ts:130-133` | `windowsHide` |
| I4 | win | confusing | inferred | `afk update` while a REPL or daemon holds the sqlite module fails with EBUSY | `src/cli/commands/update.ts:115` | Detect and ask to stop |
| I5 | both | confusing | reported | No `afk uninstall`; removal is a manual ordered procedure and leaves credentials in plaintext | `docs/trial/clean-install.md:23` | `afk uninstall` |
| I6 | both | blocker | inferred | No app icon; a newcomer cannot find the tool tomorrow | none | Say how to reopen; later, a launcher |
| I7 | both | papercut | confirmed | Only a `latest` dist-tag exists; there is no pre-release channel | `npm view agent-afk dist-tags` | Add `next` |

## J. Doctor, help, visibility

| # | Platform | Severity | Status | What happens | Evidence | Candidate fix |
|---|---|---|---|---|---|---|
| J1 | win | confusing | confirmed (code), inferred (output) | The doctor Node check builds a path with `new URL(import.meta.url).pathname`, wrong on Windows | `src/cli/commands/doctor-checks.subsystem.ts:248` | `fileURLToPath` |
| J2 | win | confusing | reported | The doctor PATH fix says `~/.zshrc` on Windows | `src/cli/commands/doctor-checks.ts:186`, `common-errors.mdx:159` | Per-OS hint |
| J3 | both | confusing | confirmed (exit), reported (check) | A missing Anthropic key is a hard fail, so OpenAI-only users get exit code 1 | `src/cli/commands/doctor.ts:31`, `doctor-checks.ts:61-65` | Fail only for the active provider |
| J4 | both | papercut | reported | The pass detail always says "ANTHROPIC_API_KEY set" even when the key came from the keychain | `doctor-checks.ts:59` | Name the real source |
| J5 | both | confusing | reported | Doctor does not check key validity, balance, connectivity, git, Chromium, global install permissions, or a home-folder cwd | `doctor-checks.ts:337-367` | Add newcomer checks |
| J6 | both | confusing | confirmed (structure) | Doctor ends with a count summary, no plain "you're ready" or next step | `src/cli/commands/doctor.ts:20-31` | Plain ending |
| J7 | both | blocker for the maintainer | reported | No telemetry or crash reporting; `/bug` needs a GitHub account | `bug.ts:49-67` | `doctor --report` plus a no-account link |
| J8 | both | confusing | confirmed | Discussions are disabled; no community link or support address | `gh api repos/griffinwork40/agent-afk` | Decide a channel |
| J9 | both | context | confirmed | Eight issues from outside authors, all developers, none about installing | `gh issue list` | Watch real installs |
| J10 | both | confusing | reported | No glossary; REPL, daemon, MCP, skill, plugin, subagent, worktree, hook, provider, model slot appear undefined | `README.md:40,86`, `index.mdx:14,30-35` | Glossary |
| J11 | both | papercut | reported | When the status rail overflows it drops labels for glyphs and colour only; no screen reader guidance | `verdict-ledger.ts:206` | Document `AFK_AGENT_AFK_ASCII`; review |

## Clean-machine experiments

Run on a retail Windows 11 machine with no Node, Git, or build tools, and on a fresh macOS user account. Record every prompt and error verbatim.

Windows:

1. In a fresh Windows Terminal: `Get-ExecutionPolicy -List`, then `npm --version`. Expect the `npm.ps1` script-block error; then `npm.cmd --version` works. (D11)
2. With no Python or Visual Studio: `npm.cmd i -g agent-afk`, then `afk.cmd doctor`. Look for `gyp ERR! find Python` or a memory-store warning. (D8)
3. With Git absent and a key set: `afk.cmd chat "run npm --version"`. Expect the tool output to show the script-block error. (F12)
4. `afk.cmd doctor`: look for "engines.node not found". (J1)
5. `afk.cmd config set updatePolicy auto`, write an older version into the `latestVersion` field of `%USERPROFILE%\.afk\cache\update-check.json`, then `afk.cmd chat hi`. Expect a `spawn npm ENOENT` crash. (I2)
6. Set `checkedAt` in that cache file to 0, launch `afk.cmd`, watch for a flashing console window. (I3)
7. Run `afk.cmd daemon`; in a second window run `afk.cmd update --pin <other version>`. Expect EBUSY or EPERM. (I4)
8. In the legacy console host (`conhost.exe`), at `afk.cmd login` type `abc`, Backspace, `d`, Enter. Check whether `afk.env` contains `abd`. (E14)
9. `afk.cmd service install daemon`, sign out and back in. Look for a visible cmd window. (H4)
10. Create a folder named `José`, ask the agent to list its parent, check for garbled text. (F13)
11. On a freshly reset machine with Smart App Control on, ask for a search. Look for a block notification. (D14)
12. Repeat step 2 from a user folder containing a space or apostrophe, and with Documents redirected to OneDrive. (D18)
13. Repeat the install without administrator rights. (C3)

macOS:

1. Fresh user account, no Xcode tools, no Homebrew. Install Node from the nodejs.org `.pkg`, then `npm install -g agent-afk`. Record whether EACCES appears. (D2)
2. Record the full npm output and how long it pauses. (D7)
3. Open a new Terminal window and run `afk --version`. Record whether the command is found and whether the PATH box printed. (D3, D5)
4. Run bare `afk` with no credential. Record the exact screen. (E1)
5. Paste a key at the hidden prompt. Record what the screen shows. (E3)
6. Launch from the home folder and send one message. Record whether any popup appears, including the Xcode tools dialog. (F2, F11)
7. Quit with Cmd+Q, then try to find and reopen the tool. (B4, I6)
8. With Node 20 installed instead: run `npm install -g agent-afk` and `afk --version`. Record the exact output. (C4)

Both, with a real person who has never used a terminal: hand them only the README link, say nothing, and log every stall with a timestamp.
