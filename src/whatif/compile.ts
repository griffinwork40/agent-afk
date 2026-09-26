/**
 * Natural-language → `ChangeSpec` compiler.
 *
 * Sends a structured prompt to the model asking it to map plain English into
 * a list of `Change` objects. Validates every entry against the `Change` union
 * and drops invalid entries. Throws if no valid changes remain (unless the
 * model returned an UNRESOLVED spec).
 *
 * The model is explicitly instructed NOT to invent file contents it hasn't
 * seen. For `file` changes the user must quote the exact content; if it is
 * unknown the model returns a spec with title starting `UNRESOLVED:` and an
 * empty change list.
 *
 * @module whatif/compile
 */

import { z } from 'zod';
import { extractJsonAs } from './json-extract.js';
import type { Change, ChangeSpec, CompleteFn } from './types.js';

// ---------------------------------------------------------------------------
// Zod schemas for the Change union
// ---------------------------------------------------------------------------

const AppendChangeSchema = z.object({
  kind: z.literal('append'),
  target: z.enum(['user-afk-md', 'project-afk-md']),
  text: z.string(),
});

const FileChangeSchema = z.object({
  kind: z.literal('file'),
  path: z.string(),
  content: z.string(),
});

const HotChangeSchema = z.object({
  kind: z.literal('hot'),
  content: z.string(),
});

const MemoryAddSchema = z.object({
  kind: z.literal('memory-add'),
  content: z.string(),
  category: z.enum(['preference', 'convention', 'decision', 'learning']),
});

const MemoryRemoveSchema = z.object({
  kind: z.literal('memory-remove'),
  id: z.number().int(),
});

const DisableSkillSchema = z.object({
  kind: z.literal('disable-skill'),
  name: z.string(),
});

const DisablePluginSchema = z.object({
  kind: z.literal('disable-plugin'),
  name: z.string(),
});

const ModelChangeSchema = z.object({
  kind: z.literal('model'),
  model: z.string(),
});

const EffortChangeSchema = z.object({
  kind: z.literal('effort'),
  effort: z.string(),
});

const EnvChangeSchema = z.object({
  kind: z.literal('env'),
  key: z.string(),
  value: z.string(),
});

const AnyChangeSchema = z.discriminatedUnion('kind', [
  AppendChangeSchema,
  FileChangeSchema,
  HotChangeSchema,
  MemoryAddSchema,
  MemoryRemoveSchema,
  DisableSkillSchema,
  DisablePluginSchema,
  ModelChangeSchema,
  EffortChangeSchema,
  EnvChangeSchema,
]);

const SpecOutputSchema = z.object({
  title: z.string(),
  changes: z.array(z.unknown()),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(ctx: { skills: string[]; plugins: string[] }): string {
  const skillList = ctx.skills.length > 0 ? ctx.skills.join(', ') : '(none known)';
  const pluginList = ctx.plugins.length > 0 ? ctx.plugins.join(', ') : '(none known)';

  return `You are a change-spec compiler for agent-afk's what-if engine.

Your job: convert a plain-English change request into a JSON ChangeSpec.

## Change kinds

Each change is one of these exact shapes (use "kind" to select):

1. append — add text to an AFK.md file
   {"kind":"append","target":"user-afk-md"|"project-afk-md","text":"<text to append>"}

2. file — replace a file with new content
   {"kind":"file","path":"home:<rel>"|"project:<rel>","content":"<exact file contents>"}
   IMPORTANT: path must start with "home:" (for ~AFK_HOME) or "project:" (for project cwd).

3. hot — replace the HOT.md memory file entirely
   {"kind":"hot","content":"<exact new HOT.md content>"}

4. memory-add — add a memory fact
   {"kind":"memory-add","content":"<the fact>","category":"preference"|"convention"|"decision"|"learning"}

5. memory-remove — remove a memory fact by numeric id
   {"kind":"memory-remove","id":<number>}

6. disable-skill — disable a named skill
   Known skills: ${skillList}
   {"kind":"disable-skill","name":"<skill name>"}

7. disable-plugin — disable a named plugin
   Known plugins: ${pluginList}
   {"kind":"disable-plugin","name":"<plugin name>"}

8. model — change the model
   {"kind":"model","model":"<model id or alias>"}

9. effort — change the effort level
   {"kind":"effort","effort":"low"|"medium"|"high"|"max"}

10. env — set a non-secret environment variable
    {"kind":"env","key":"<VAR_NAME>","value":"<value>"}

## Critical rules

- For "file" and "hot" changes: you may ONLY use content explicitly quoted by the user.
  Never invent, guess, or generate file contents you have not seen verbatim.
  If the request requires file content you do not know, set UNRESOLVED mode (below).
- Drop any change you cannot safely construct.
- If zero valid changes remain because content is unknown, use UNRESOLVED mode.

## UNRESOLVED mode

When the request requires file contents you do not know:
{"title":"UNRESOLVED: <reason>","changes":[]}

## Output format

Respond with ONLY a JSON object (no prose, no fences):
{"title":"<one-line human description>","changes":[<Change>, ...]}`;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/** Context handed to the compiler so it can enumerate available skills/plugins. */
export interface CompileCtx {
  skills: string[];
  plugins: string[];
}

/**
 * Compile a plain-English change description into a validated `ChangeSpec`.
 *
 * - Invalid Change entries are silently dropped.
 * - Throws when no valid changes remain (unless the title starts `UNRESOLVED:`).
 */
export async function compileChangeSpec(
  text: string,
  complete: CompleteFn,
  model: string,
  ctx: CompileCtx,
): Promise<ChangeSpec> {
  const system = buildSystemPrompt(ctx);
  const { text: responseText } = await complete({
    system,
    user: text,
    maxTokens: 2048,
    model,
  });

  const raw = extractJsonAs(responseText, SpecOutputSchema);
  const title = raw.title.trim();

  // UNRESOLVED path — model indicates content unknown; return as-is.
  if (title.startsWith('UNRESOLVED:')) {
    return { title, changes: [] };
  }

  // Validate each entry against the Change union; drop invalid ones.
  const valid: Change[] = [];
  for (const entry of raw.changes) {
    const parsed = AnyChangeSchema.safeParse(entry);
    if (parsed.success) {
      valid.push(parsed.data);
    }
  }

  if (valid.length === 0) {
    throw new Error(
      `compileChangeSpec: no valid changes after validation (title: "${title}"). ` +
        `Raw changes count: ${raw.changes.length}`,
    );
  }

  return { title, changes: valid };
}
