# Outside-user trial

**Question:** Can someone get a useful, verified result on an unfamiliar-to-AFK project without Griffin knowing which switch to flip? Recruit three testers, each using a repository they own. This is an observation protocol, not a benchmark of model quality. Do not preconfigure their machine or pick their tasks for them.

## Protocol

1. Obtain consent and record OS, Node version, AFK version, chosen provider and repository type (not its contents). Give the tester [clean-install.md](clean-install.md) and [task-pack.md](task-pack.md). Start the clock before install. Let them choose a task and define a check they can run themselves.
2. Session 1: install and authenticate, run `/get-started` if desired, then do one useful task. Observe their own verification and ask what the final Done/Blocked receipt means to them. Record both successes and failures.
3. Arrange one deliberate interruption using task 5. Close the terminal **while work is in progress**, with tester consent. Do not claim the interrupted turn was saved. Continue on a different day from the saved session, inspect partial work, and verify anew. Keep elapsed time for both days separately as well as end-to-end wall time.
4. Session 2, on another day: have the tester select a *different* useful task for the same repo. Repeat independent verification and receipt comprehension. Record capabilities they never found without prompting.

The facilitator answers **only when asked**. They may clarify the trial procedure and safety limits, not silently fix auth, pick a model, type commands, edit config, or repair the repo. If a safety issue requires stepping in, stop the task and log that intervention immediately, verbatim. Log every hint, screen share, command, or manual rescue in [intervention-log.md](intervention-log.md), including unsolicited steps. Do not erase a failed attempt after rescue. No third-party PR, scheduled process, or other external action without the tester's explicit approval.

## Consent and privacy

Tell testers that their code stays on their machine **unless they choose to share it or the configured model/provider receives it as part of the task**. AFK has no remote analytics by default; it sends prompts and relevant context to the model provider. Local `~/.afk/` holds configuration (possibly credentials), session sidecars and transcripts under `state/`, witness traces under `state/witness/`, logs under `logs/`, and telemetry under `agent-framework/`. The state tier can move with `AFK_STATE_DIR`, and the home with `AFK_HOME` (see `src/paths.ts`). Trace/journal or transcript sharing is **opt-in** and may reveal code, prompts, paths, personal data, or secrets. Never ask for raw credentials. A tester can decline artifact sharing and still participate; use their observation and summary instead. Get permission before recording screens or copying any local artifact.

## Outcomes to record per tester, per task

* **Verified completion:** yes/no; exact check (command, test output, diff review, or human inspection) and who ran it. An agent saying "Done" alone is not verification.
* **Elapsed:** minutes from task start to verified result or stop, plus install/auth time and interruption gap separately.
* **Total cost if known:** AFK displayed USD estimate or provider bill; label unknown for subscription usage or missing figures, never equate estimates to invoices.
* **Human rescue:** minutes of facilitator assistance, with every intervention in the log.
* **Capabilities never discovered:** ask what they expected and could not find before showing any shortcuts.
* **Final receipt understood:** yes/no; have tester paraphrase Done/Blocked and its evidence or unblock condition.

Primary success: each tester completes at least one useful task with an independently checked result, with zero unlogged help. Report the count out of three, not just a pass rate. Also report how many finish the second-day task, resume correctly after interruption, and understand the receipt. A Blocked result with a specific, accurate unblock condition is informative but **not** verified completion. Include failures, cost unknowns, and rescue minutes in the summary.

Command and path basis: `README.md` Quick Start and Configuration; `src/paths.ts`, `src/paths.witness.ts`; `src/cli/slash/commands/resume.ts`; `src/cli/commands/trace.ts`; `src/skills/get-started/index.ts`.
