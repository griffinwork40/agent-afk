# Headless / Machine-Readable Output

`afk chat` supports a structured streaming output format for headless consumers — CI pipelines, shell scripts, or wrapper programs that need to process AFK's response programmatically rather than read a human-formatted terminal display.

## `--format stream-json`

```
afk chat "<message>" --format stream-json
```

Writes the raw `OutputEvent` stream to **stdout** as [NDJSON](https://ndjson.org/) (newline-delimited JSON) — one event object per line. No spinner, no ANSI colour codes, no markdown rendering. Stdout contains only valid JSON lines.

### OutputEvent schema

The canonical type definition lives in two files:

- **`src/agent/types/session-types.ts:82`** — `OutputEvent` discriminated union
- **`src/agent/types/message-types.ts:121`** — `MessageChunk` discriminated union (payload of `chunk` events)

Summary of event shapes:

| `type`       | Additional fields                                          | Notes                                            |
|--------------|------------------------------------------------------------|--------------------------------------------------|
| `chunk`      | `chunk: MessageChunk`                                      | Streaming text/tool fragment                     |
| `message`    | `message: { content: string; timestamp: string }`          | Complete assistant message                       |
| `done`       | `metadata?: ResponseMetadata`                              | Always the final event in a successful turn      |
| `error`      | `error: { message: string; ... }`                          | Fatal error; process exits with code 1           |
| `progress`   | `progress: { taskId, description, totalTokens, ... }`      | Subagent progress (may be absent on simple turns)|
| `suggestion` | `suggestion: string`                                       | Prompt suggestion from the model                 |
| `panel`      | `spec: { kind, title?, body }`                             | Skill-emitted card/panel                         |
| `paused`     | `reason: 'usage-limit'; resetsAt?: string; accountId?`     | OAuth usage-limit hit; `resetsAt` is ISO-8601    |
| `resumed`    | `hotSwapped: boolean; accountId?`                          | Resumed after pause                              |

`Date` fields (e.g. `paused.resetsAt`) are serialized as ISO-8601 strings.

### Example NDJSON transcript

A minimal single-turn exchange:

```ndjson
{"type":"chunk","chunk":{"type":"content","content":"Hello"}}
{"type":"chunk","chunk":{"type":"content","content":", world!"}}
{"type":"message","message":{"content":"Hello, world!","timestamp":"2024-06-01T12:00:01.234Z"}}
{"type":"done","metadata":{"durationMs":812,"usage":{"input_tokens":14,"output_tokens":5}}}
```

A turn that hits a usage-limit pause:

```ndjson
{"type":"paused","reason":"usage-limit","resetsAt":"2024-06-01T13:00:00.000Z"}
{"type":"resumed","hotSwapped":false}
{"type":"chunk","chunk":{"type":"content","content":"Continuing after the pause."}}
{"type":"done"}
```

### Consumer guide

**Reading with `jq`:**

```bash
# Print only the text content of chunk events
afk chat "summarise this repo" --format stream-json \
  | jq -r 'select(.type == "chunk" and .chunk.type == "content") | .chunk.content'

# Extract final token usage
afk chat "count words" --format stream-json \
  | jq 'select(.type == "done") | .metadata.usage'

# Detect tool-use events in the stream
afk chat "list files" --format stream-json \
  | jq 'select(.type == "chunk" and .chunk.type == "tool_use")'

# Exit-code-aware pipeline: stream-json exits 1 on error, 0 on done
afk chat "build the project" --format stream-json | tee run.ndjson
echo "exit: $?"
```

**Parsing in Node/TypeScript:**

```typescript
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const proc = spawn('afk', ['chat', 'say hi', '--format', 'stream-json']);
const rl = createInterface({ input: proc.stdout });

for await (const line of rl) {
  const event = JSON.parse(line); // type: OutputEvent
  if (event.type === 'chunk' && event.chunk.type === 'content') {
    process.stdout.write(event.chunk.content);
  }
  if (event.type === 'done') break;
  if (event.type === 'error') {
    console.error('AFK error:', event.error.message);
    process.exit(1);
  }
}
```

### What is NOT in scope

- **stream-json input** — the format affects output only; the `<message>` argument is still a plain string.
- **Session resume** — `--format stream-json` supports session persistence and resume; pass `--resume`, `--continue`, or `--session-id` exactly as with text output.
- **claude-cli wire format compatibility** — the NDJSON shape is AFK-native; it is not translated to any external streaming protocol.
