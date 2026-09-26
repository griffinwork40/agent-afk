/**
 * Usage text for `afk whatif` / `/whatif`.
 *
 * Extracted from args.ts to keep that file within the 350-code-line ceiling.
 *
 * @module whatif/args.usage
 */

export const WHATIF_USAGE = `\
afk whatif — predict the behavioural impact of a proposed change.

USAGE
  afk whatif [change text...]  [flags]
  /whatif [change text...]  [flags]

EXAMPLES
  # Plain English — compiled to a ChangeSpec, confirmed before running
  afk whatif "turn off auto-routing"
  afk whatif "always ask before using tools"

  # Explicit flags (can be combined and repeated)
  afk whatif --append "Always ask a clarifying question before running tools."
  afk whatif --model claude-haiku-4-5 --verify
  afk whatif --memory-add "prefers pnpm test:file" --memory-category preference

  # Load a prepared ChangeSpec file
  afk whatif --spec ./my-change.json

  # Quick single-turn estimate
  afk whatif "disable diagnose skill" --quick

  # Full verification with custom judge and budget
  afk whatif --append "Never use bash" --verify --judge claude --max-usd 3

CHANGE FLAGS (accumulate in order)
  --append <text>              Append text to your AFK.md (user scope)
  --append-project <text>      Append text to project AFK.md
  --file <path>=<localfile>    Set a file (path: home:<rel> or project:<rel>)
  --hot <localfile>            Replace HOT.md with a local file's content
  --memory-add <text>          Add a memory fact
  --memory-category <cat>      Category for the next --memory-add
                               (preference|convention|decision|learning; default: preference)
  --memory-remove <id>         Remove a memory fact by numeric id
  --disable-skill <name>       Disable a skill by name
  --disable-plugin <name>      Disable a plugin by name
  --model <id>                 Test a different candidate model
  --effort <level>             Test a different effort level
  --env KEY=VALUE              Set an env var in the candidate sandbox
  --spec <file.json>           Load a full ChangeSpec from a JSON file

RUN OPTIONS
  --agent-model <id>           Model the agent under test uses (default: current)
  --analyst-model <id>         Model for compile/predict/judge (default: sonnet)
  --verify                     Run episodes and verify predictions empirically
  --quick                      Single-turn episodes (sets --max-turns 1)
  --turns <n>                  Real turns to replay (default: 12)
  --samples <n>                Samples per episode per environment (default: 3)
  --max-usd <n>                Budget cap in USD (default: 5)
  --judge auto|jev|claude      Judge to use (default: auto)
  --concurrency <n>            Parallel episodes (default: 4)
  --max-turns <n>              Max turns per episode (default: 3)
  --timeout <sec>              Episode timeout in seconds (default: 180)
  --keep-sandboxes             Keep sandbox directories after run
  --yes                        Skip confirmation of compiled spec
  --json                       Print results as JSON to stdout
`;
