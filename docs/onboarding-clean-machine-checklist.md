# Clean-machine onboarding observation

## Goal and ground rules

Observe before fixing. The [friction ledger](onboarding-friction.md) is a research
backlog, not a set of reproduced failures. Nothing has been observed on a real
clean machine yet. Run these passes on a retail Windows 11 machine with no Node,
Git, Python or Visual Studio, and a fresh macOS user account without Homebrew or
Xcode tools. Record the starting state and any deviations. Do not weaken execution
policy, disable Smart App Control, install build tools to hide an error, or repair
PATH during the baseline pass. Stop and record a failure instead.

The scripts install the public npm `latest` package, not the branch source. This
is an intentional global install, not a dry run. They may leave the installed
package, npm cache, a log, and an adjacent `.onboarding-home-*` directory. They do
not remove an existing installation. Use a fresh account, not your daily account.
They never request credentials, send a model message, enable services, update the
package, or change system policy. They use an isolated AFK home and close stdin
for bare launch. Each command has a timeout (15 minutes for install, one minute
for other steps); timeout and exit status are findings and do not stop later steps.

Do not put an API key in a terminal command or the log. Review logs before sending:
paths can identify your account, and network errors can contain proxy information.
Send the full `.log` and `.log.summary.md` to the maintainer through an agreed
private channel first. Do not upload the sandbox or any credential/config files.
Attach sanitized logs to the tracking issue only with the participant's consent.

## Before running

1. Note date, computer model, OS version, account type, default terminal, and
   whether Node, Git, developer tools, afk, or another AI CLI was already present.
2. Download the observation kit from the PR or a reviewed revision. Keep all three
   files in `scripts/onboarding/` together. Extract the ZIP before running it.
3. Record what it took to open a terminal (B1), find the downloaded folder and
   change into it (B2), and understand where to paste a command (B3, B4).
4. Install Node using the official installer at <https://nodejs.org/en/download>.
   Record the version chosen, prompts, administrator requirement, restart, and
   terminal reopening steps (C1, C2, C3). Do not assume the person knows which
   download to choose. The observation script itself requires Node to run.

## Windows 11 baseline

Use **Windows PowerShell 5.1**, not PowerShell 7, for this pass. In the extracted
kit folder, run:

```powershell
& .\scripts\onboarding\observe-windows.ps1 -LogPath .\onboarding-windows.log
```

If policy blocks this downloaded script, do not bypass it or change policy. Copy
and retain the exact error (D11). With consent, open the reviewed script in a text
editor and paste its contents into Windows PowerShell instead, leaving the
`param(...)` defaults and keeping the helper beside it. If that cannot run, send
the error and starting state; this is evidence, not participant failure. An
alternative is to have the maintainer observe these commands directly and record
each complete output and exit code:

```powershell
Get-ExecutionPolicy -List
npm --version
npm.cmd --version
npm.cmd install -g agent-afk
```

Then open a new Windows PowerShell window and record `afk --version`,
`afk.cmd --version`, and `afk.cmd doctor` (D4, D11, J1). The automated script uses
fresh child shells and closed stdin; opening a new terminal also tests inherited
PATH updates and the user-facing terminal experience. Do not enter a credential
for the baseline. Save the complete install output and duration, including pauses,
script warnings, native-binding warnings, or Python prompts (D5, D7, D8, D15).

Optional repeat on an expendable account: use `-WithoutGit` to remove Git
installation directories from child PATH, without uninstalling Git or touching
system PATH. Inspect the prerequisites section to confirm Git really is absent.
This observes install/doctor without Git, not the credentialed agent-shell path
in F12. Repeating a global install can reuse the first pass's files and npm cache;
for an independent cold result use a separate account or reset test machine.

## macOS baseline

Use a fresh account, no Homebrew and no Xcode tools. Install Node from the official
`.pkg`, not a version manager. Do not use `sudo` for the npm install. In the
extracted kit folder run:

```sh
sh scripts/onboarding/observe-macos.sh ./onboarding-macos.log
```

Record EACCES verbatim if it occurs; do not change ownership or npm prefix during
the baseline (D2). The script keeps the actual global prefix, isolates AFK state,
and skips afk launches if it detects an existing Claude Code Keychain entry.
That skip means the account was not clean; do not delete a real token to proceed.
Open a new Terminal window and record whether `afk --version` is found (D3, D5).
Repeat with Node 20 only in a disposable account or machine to capture unsupported
runtime output (C4). Avoid changing an existing working development environment.

## Human eyes and credentialed passes

Do these only after the uncredentialed baseline, with participant consent. Keep
secrets out of screenshots and logs. Authentication or a paid model request is
not part of the automated scripts.

| Check | Ledger IDs | What to record |
| --- | --- | --- |
| Hidden key entry | E1, E2, E3, E4, E5, E14, E16 | What the prompt explains, where the person looks for a key, billing assumptions, whether pasting looks broken, legacy console Backspace behaviour. Never share the typed key or key file. |
| Windows security | D8, D14 | Native module errors without build tools, Smart App Control prompts on a freshly reset Windows 11 machine. Do not turn protection off. |
| Windows shell | F12, F13 | With no Git and a working credential, ask the agent to run the npm version check; note policy errors. Try a folder named José and note garbled output. |
| Window flashes | I3, H4 | Observe launch and background version-check flashes. Service-at-logon testing requires a separate, explicit service-install pass; record windows and whether closing them stops the process. |
| macOS dialogs | F2, F11 | With consent, launch from the home folder and send one harmless message. Note Xcode tools dialogs and any file-access warning. Cancel unwanted installs. |
| Console experience | F3, F7, F10, F14, J11 | Banner clearing, what to type, quit discoverability, image paste, colour-only labels and accessibility. |
| Return tomorrow | B4, I6 | Close Terminal normally, then ask them to find and reopen afk the next day without hints. |
| Folder variations | D18 | Repeat from a path with spaces/apostrophes/non-ASCII and a OneDrive/iCloud-backed folder. Record sync configuration. |
| Updates | I2, I4 | Separate expendable-account experiment for opt-in auto-update and a locked native module. No cache editing, daemon startup, or update is done in the baseline. |
| Discovery and cost | A1-A7, G1-G3, H1-H5, J7-J10 | Confusing terminology, cost visibility, help channels and optional setup. Record stalls, not speculative fixes. |

## Watch a real first-timer

Recruit two or three people who have never used a terminal. Start each with only
the README link, a fresh computer/account, and consent to observe. **Say nothing;
log every stall** with timestamp, screen/command, their words, duration, and the
ledger ID (or a new ID if none fits). Do not teach or repair during the baseline.
Intervene only for safety, privacy, or a request to stop; mark the intervention.
Ask what they expected after the pass. Preserve failures even if later resolved.
Two consecutive sessions with no new ledger item is a minimum stopping signal,
not proof that onboarding is complete.

## What CI can and cannot establish

The separate `onboarding-observe.yml` workflow covers Node majors 20, 22, 24 and 26
on Windows and macOS, full published-package installs, command resolution,
execution policy, no-credential non-TTY launch, help, doctor, and Windows without
Git directories on child PATH. A job summary shows exit codes and durations; the
artifact contains complete output. Nonzero observed commands do not fail the job.
A missing driver/runtime/log or a failed artifact upload does fail the job.

Hosted runners already have Git, build tools, writable npm locations, and relaxed
PowerShell policy. Removing Git directories is not removing all developer tools.
They cannot show retail execution policy, Smart App Control, GUI flashes, hidden
input usability, real startup PATH inheritance after the Node installer, or human
comprehension. They do not test credential validity, paid requests, Telegram,
services, updates, synchronized folders, or an interactive terminal. The official
macOS Node `.pkg` permission scenario remains a human pass: changing a privileged
hosted runner's Node installation would still not reproduce a retail account's
ownership and administrator boundary. Do not label a green observation job a
successful onboarding experience or upgrade ledger statuses automatically.
