/**
 * /init — scan the current project and generate an AFK.md.
 *
 * Sends a structured prompt to the model asking it to read project metadata
 * files, analyze the codebase, and write a useful AFK.md. The model does all
 * the heavy lifting — this command just frames the task.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatCommandBreadcrumb } from '../_lib/command-tags.js';
import { createSkillRenderer } from '../_lib/create-skill-renderer.js';
import { createConsoleWriter } from '../writer.js';
import { runWithSink } from '../../../agent/_lib/skill-sink-channel.js';
import type { SlashCommand } from '../types.js';

const INIT_PROMPT = `You are initializing this project for use with AFK (an AI agent CLI).

Your job: scan this project and generate an \`AFK.md\` file in the project root. AFK.md is a plain markdown file (no YAML frontmatter) that serves as the system prompt for all AFK sessions in this project.

## Steps

1. **Discover project metadata** — read these files if they exist:
   - \`package.json\`, \`tsconfig.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`Makefile\`, \`CMakeLists.txt\`
   - \`.github/workflows/\` (CI config)
   - \`docker-compose.yml\`, \`Dockerfile\`
   - \`README.md\` or \`README\`
   - Any existing \`CLAUDE.md\` or \`AGENTS.md\` (borrow relevant context)

2. **Scan directory structure** — list top-level directories and key subdirectories to understand the project layout.

3. **Generate AFK.md** with these sections:
   - **What This Is** — one-paragraph description of the project (language, framework, purpose)
   - **Commands** — build, test, lint, dev commands (extracted from package.json scripts, Makefile targets, etc.)
   - **Architecture** — key directories and their purpose, entry points, major subsystems
   - **Conventions** — coding style, naming patterns, anything notable from config files (strictness levels, linting rules)
   - Only include sections where you found real content. Skip empty sections.

4. **Write the file** — write AFK.md to the project root. Keep it concise — under 150 lines. This file is loaded into every session, so brevity matters.

## Format rules
- Plain markdown, no YAML frontmatter
- Use code blocks for commands
- Use tables for directory layouts
- Don't include boilerplate or filler — every line should earn its place`;

export const initCmd: SlashCommand = {
  name: '/init',
  summary: 'Scan project and generate AFK.md',
  hint: 'When you\'re in a fresh repo and want the model to bootstrap an AFK.md system prompt that captures conventions, commands, and architecture.',
  async handler(ctx, args) {
    const afkMdPath = resolve(process.cwd(), 'AFK.md');
    const claudeMdPath = resolve(process.cwd(), 'CLAUDE.md');

    const blocks: ContentBlockParam[] = [];

    blocks.push({ type: 'text', text: formatCommandBreadcrumb('init', args) });

    let instruction = INIT_PROMPT;

    if (existsSync(afkMdPath) && !args.includes('--force')) {
      instruction += `\n\n## Existing AFK.md detected
An AFK.md already exists at \`${afkMdPath}\`. Read it first — then update it with any new information from the project scan. Preserve user-written content and only add/refresh sections derived from project metadata. If the existing file is already good, say so and make minimal changes.`;
    }

    if (existsSync(claudeMdPath)) {
      instruction += `\n\n## CLAUDE.md detected
A CLAUDE.md exists at \`${claudeMdPath}\`. Read it and incorporate relevant context (commands, conventions, architecture) into the AFK.md. Don't duplicate — adapt.`;
    }

    if (args.trim()) {
      const cleaned = args.replace('--force', '').trim();
      if (cleaned) {
        instruction += `\n\n## Additional context from user\n${cleaned}`;
      }
    }

    blocks.push({ type: 'text', text: instruction });

    // TODO: `out` is explicitly overridden with `createConsoleWriter()` here
    // rather than using `ctx.out` (the canonical pattern in builtin-skills.ts
    // and plugin-skills.ts). Verification shows this is STALE — `ctx.out` is
    // a required field on SlashContext and is already used in the catch block
    // below. The divergence is preserved for now to avoid a silent behaviour
    // change; a follow-up should remove the override and align with ctx.out.
    const renderer = createSkillRenderer(ctx, {
      skillName: 'init',
      out: createConsoleWriter(),
      onCancel: () => {
        ctx.session.current.interrupt().catch(() => {});
      },
    });

    try {
      await renderer.arm();
      await runWithSink(renderer.sink, async () => {
        for await (const event of ctx.session.current.sendMessageStream(blocks)) {
          renderer.sink(event);
        }
      });
    } catch (err) {
      ctx.out.line();
      ctx.out.error(`init failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await renderer.dispose();
    }

    return 'continue';
  },
};
