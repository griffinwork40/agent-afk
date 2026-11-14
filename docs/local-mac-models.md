# Running afk against a local Mac model (oMLX)

afk can drive any OpenAI-compatible server through a [model slot](model-slots.md).
This page walks through serving a model on Apple Silicon with
[oMLX](https://github.com/jundot/omlx), pointing the `local` slot at it, checking
the connection, and the settings that worked best in our runs.

## 1. Start a server

```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
omlx start            # background service; restarts on crash
```

oMLX serves an OpenAI-compatible API at `http://localhost:8000/v1` by default.

- oMLX refuses to bind to a non-loopback address unless an API key is set
  (`OMLX_API_KEY`). To reach the server from another machine, prefer a private
  network such as Tailscale over exposing the port publicly, and set a key either way.
- Ollama (`http://localhost:11434/v1`) and LM Studio (`http://localhost:1234/v1`)
  work the same way through their OpenAI-compatible endpoints. Only the base URL
  and the model id change.

## 2. Point the `local` slot at it

Use the model id exactly as the server lists it under `GET /v1/models`.

Environment variables (per shell, or via `afk config env set`):

```bash
export AFK_MODEL_LOCAL='<model-id-from-/models>'
export AFK_MODEL_LOCAL_BASE_URL='http://localhost:8000/v1'
export AFK_MODEL_LOCAL_API_KEY='<your OMLX_API_KEY, or any non-empty string if none>'
```

The equivalent `afk.config.json` entry. `contextWindow` is config-file only
(there is no env var for it):

```jsonc
{
  "models": {
    "local": {
      "id": "<model-id-from-/models>",
      "provider": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "<key>",
      "contextWindow": 65536
    }
  }
}
```

Env vars win over the file. You can keep `baseUrl`/`apiKey` in env and only
`id`/`contextWindow` in the file. Then select the slot:

```bash
afk -m local
```

## 3. Verify

```bash
afk doctor
curl -H "Authorization: Bearer $AFK_MODEL_LOCAL_API_KEY" http://localhost:8000/v1/models
```

For every slot with a custom endpoint, `afk doctor` probes `GET <baseUrl>/models`
and reports a row named `Model slot "local" endpoint`:

| Result | Meaning |
| --- | --- |
| ✓ pass | server reachable and the slot's model id is listed |
| ⚠ warn | reachable, but the id is not listed (the row shows ids that are), or 401/403, or another HTTP error |
| ✗ fail | unreachable: connection refused, DNS failure, or timeout (3 s) |

The probe sends only the slot's own key (`AFK_MODEL_LOCAL_API_KEY` or
`models.local.apiKey`), as a header, and never prints it. It does not replicate
afk's runtime fallbacks (`OPENAI_API_KEY`, Codex, ChatGPT or xAI OAuth), so for a
slot without its own key, or one that authenticates another way, a 401/403 is
reported as "auth unverified" rather than "auth rejected".

## 4. Recommended settings

These are what we measured on our hardware, not guarantees.

**Thinking mode is a server setting.** Reasoning/thinking is controlled by the
server, for example oMLX per-model settings or the chat-template kwarg
`enable_thinking`. afk has no switch for it. For agent tool loops, non-thinking
mode was faster with no quality loss in our runs.

**Serve one request at a time.** A single-GPU local server tends to do best with
one request at a time. In one measurement, letting the server take 2 requests at
once made a 5-subagent fan-out 1.67x slower. Set the server's maximum concurrent
requests to 1.

**Preferred: per-slot concurrency cap (#3886).** Set `maxConcurrency` on the
`local` slot so only requests to the local endpoint are serialised — cloud-tier
fan-outs and parallel read/grep/web calls stay fully parallel:

```jsonc
// afk.config.json
{ "models": { "local": { "id": "qwen3.6b", "maxConcurrency": 1 } } }
```

Or via env (wins over config):

```bash
export AFK_MODEL_LOCAL_MAX_CONCURRENCY=1
```

**Alternative: process-global caps** (use only when the local model is the only
model in the session — these also serialise cloud-tier subagents and parallel
read/grep/web tool calls):

```bash
export AFK_MAX_CONCURRENT_SUBAGENT_CALLS=1
export AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS=1
```

**Model choice: one data point.** On one Apple Silicon MacBook Pro (M5 Max,
128 GB) we ran 15 agent-shaped tasks x 2 runs:

| Model | Tasks passed |
| --- | --- |
| Qwen3.6-35B-A3B, 4-bit MoE | 26/30 |
| dense 27B with speculative decoding | 25/30 |
| Claude Sonnet (cloud, reference) | 30/30 |

n=30 per arm on one machine, so no significance claim. The MoE was also about 2x
faster per task.

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `afk doctor` ✗ fail, "connection refused" or "timed out" | The server is down or on another port. Run `omlx start` (or start Ollama / LM Studio) and `curl <baseUrl>/models`. |
| ⚠ warn "returned 401" / "403" (auth rejected) | The slot's own key does not match the server key (`OMLX_API_KEY`). Fix `AFK_MODEL_LOCAL_API_KEY`. |
| ⚠ warn "returned 401" / "403" (auth unverified) | doctor sent no key, so it could not check auth. "the slot has no key of its own": at runtime afk may use `OPENAI_API_KEY` or Codex credentials; give the slot its own key to let doctor verify it. Other reasons (ChatGPT OAuth, an xAI route with or without a key, a slot whose `provider` disagrees with the global `AFK_PROVIDER`): verify by starting a session on the slot. |
| ⚠ warn "not listed; available: …" | The slot id does not match the server's id. Copy one of the listed ids into `AFK_MODEL_LOCAL`. |
| ⚠ warn "did not return an OpenAI-style model list" | The base URL is missing the API prefix. Most servers need `/v1`. |
| Errors or truncation on long sessions | afk assumes a larger window than the local model has. Set `models.local.contextWindow` to the window the server actually serves (`afk config set models.local.contextWindow <N>`). |
