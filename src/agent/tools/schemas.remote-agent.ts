/**
 * Tool schema for `remote_agent`: run an afk agent on another machine over
 * SSH and return its final answer. Implementation: `src/remote/`; handler:
 * `handlers/remote-agent.ts`; design: `docs/remote-dispatch.md`.
 *
 * @module agent/tools/schemas.remote-agent
 */

import type { AnthropicToolDef } from './types.js';

export const remoteAgentTool: AnthropicToolDef = {
  name: 'remote_agent',
  // Outbound effect on another machine plus a billed model run there.
  category: 'web',
  concurrencySafe: true,
  description:
    'Run an afk agent on ANOTHER computer over SSH (Tailscale/LAN) and return its final ' +
    'answer. The remote agent works in that machine\'s own files, repos, accounts, and ' +
    'model subscriptions; nothing is copied from here, so move code with git. Use it to ' +
    'spread work across machines or to act on state that only exists on the remote.\n\n' +
    '`host` is a name from ~/.afk/config/hosts.json (`{ "<name>": { "ssh": "user@host", ' +
    '"cwd"?: "...", "afkPath"?: "..." } }`) or a literal ssh target / ~/.ssh/config alias. ' +
    'The run is detached on the remote, so it survives a dropped connection or this ' +
    'machine sleeping; the tool reconnects and resumes. A sleeping or offline host fails ' +
    'fast. The result names the remote session id: pass it as `resume` to continue the ' +
    'same conversation on that host.\n\n' +
    'The remote agent cannot dispatch subagents or further remote agents. It runs headless ' +
    'under that machine\'s own configured permissionMode, which is bypassPermissions by ' +
    'default, so remote_agent is risk class high and autonomous mode (AFK gate) holds it ' +
    'for approval. This call blocks until the remote finishes; for long work, call it from ' +
    'a background `agent`.',
  input_schema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'Host name from hosts.json, or a literal ssh target (e.g. "user@host", an ~/.ssh/config alias).',
      },
      prompt: {
        type: 'string',
        description: 'The task for the remote agent. It has none of your context: make it self-contained.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory ON THE REMOTE (absolute or ~/...). Default: the host\'s hosts.json "cwd", else its home dir.',
      },
      model: {
        type: 'string',
        description: 'Model for the remote run (slot, alias, or id as configured on that host). Default: the remote\'s own default.',
      },
      resume: {
        type: 'string',
        description: 'Remote session id from a previous remote_agent result, to continue that conversation on the same host.',
      },
    },
    required: ['host', 'prompt'],
  },
};
