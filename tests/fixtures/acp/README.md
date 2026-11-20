# ACP v1 wire fixtures

## Provenance

* Repository: <https://github.com/agentclientprotocol/agent-client-protocol>.
* Commit: `d98a032006928dffc465f930638f83815b91ebe3` (short form `d98a032`), authored 2026-11-19T22:46:25Z.
* Upstream path: `schema/v1/schema.json`, stable schema, not `schema/v1/schema.unstable.json` or v2.
* Fetched and verified: 2026-11-20.
* Raw source: <https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/d98a032006928dffc465f930638f83815b91ebe3/schema/v1/schema.json>.
* SHA-256: `f4865c6cc6c15ac12df875375f43b82e77142bc1cb38a7785b7e3cfeaec85e5d`.

Verification: fetched the GitHub recursive tree for `d98a032`, resolved its full commit above, fetched `schema/v1/schema.json` from that revision, and compared the bytes with the supplied `/tmp/acp-schema.json` snapshot using `cmp` and `shasum -a 256`. Both files had the identical digest above. The vendored file is an unchanged copy of the fetched stable schema. The initial guessed upstream path `schema/schema.json` returned HTTP 404; tree discovery identified the correct v1 path. The commit API independently confirmed the full revision and author date. No fallback snapshot was needed.

## Transcript format

Each `.ndjson` line is a fixture wrapper `{ "direction": "client_to_agent", "frame": { ... } }` or `{ "direction": "agent_to_client", "frame": { ... } }`. Only `frame` is transmitted. Direction and frame wrappers are not ACP fields. Lines are ordered, not simultaneous. Request ids are correlated independently by originating direction. Numeric client ids and agent string ids beginning `acp:` are deterministic examples. All requests in a fixture have a matching response; notifications have no id.

Every fixture starts with an initialize exchange. Most also create the session. `load-replay` and `resume` instead assume an existing persisted journal for opaque ACP id `11111111-1111-4111-8111-111111111111`, with original cwd `/workspace`. The harness must seed that history, or an ACP-to-journal mapping, before replaying these two examples. The history in `load-replay` is a user request to read `a.txt`, one successful read of `old\n`, and the displayed assistant response. Fixtures do not model the creation of this persisted history in the same process.

`/workspace` is a portable logical fixture root, not a requirement to create that absolute path on the test host. Real-server replay harnesses replace it consistently with their temp workspace, spawn the server in that workspace, and replace opaque session ids with the deterministic fake session's id. `agentInfo.version: "6.0.0"` is illustrative target-release metadata; harnesses replace it with the running package version. These substitutions do not change schema validation.

The standalone contract test does not execute the server or the tools. It verifies every frame against the schema, validates the direction-specific envelope and the exact method-specific params/result definition, matches responses to their requests, and checks notification id absence. This extra payload check matters: the upstream envelope unions are permissive and do not bind `method` strings to a single params definition. Ajv 8 is already a production dependency. The test uses its draft 2020-12 entry point and explicit numeric format validators. JavaScript fixture integers are limited to exactly representable safe integers.

## Golden cases

| File stem | Contract scenario |
|---|---|
| `text-turn` | Initialize, create, text prompt, thought/text chunks, measured usage, normal stop |
| `tool-read` | Read tool auto-allowed, start and terminal result |
| `tool-edit-diff` | Consent, edit, render-only hunk diff retained in final replacement content |
| `tool-bash-failed` | Bash asks with no always option, command fails but turn completes normally |
| `permission-allow-once` | Pending tool precedes permission request, one-time consent |
| `permission-reject` | Explicit rejection fails the tool, not the prompt |
| `permission-allow-always-then-skip` | Exact tool name remembered across turns in the same live session |
| `cancel-during-permission` | Session cancellation, cancelled permission response, failed tool and cancelled prompt |
| `cancel-during-stream` | Notification cancellation during text generation, no cancellation response |
| `load-replay` | Display replay precedes load response, no execution or new consent |
| `resume` | Restore without replay, then continue the conversation |
| `close-idempotent` | Close an active idle session, repeat, close unknown id |
| `bad-version-negotiation` | Client offers 0, agent returns supported 1; incompatible client disconnects |

The target behavior and ordering rules are in `docs/acp-profile.md`. These fixtures freeze the migration contract, not the old server's current behavior. Tests of permission failures, prompt media normalization, malformed transport and implementation seams belong to their later owner lanes; valid golden frames are not malformed-input fixtures.

## Upstream license attribution

The upstream root `LICENSE` was fetched directly at the pinned revision and inspected, not inferred from package metadata. It is the Apache License, Version 2.0. Its attribution is:

```text
Copyright 2025 Zed Industries, Inc. and contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Upstream license source: <https://github.com/agentclientprotocol/agent-client-protocol/blob/d98a032006928dffc465f930638f83815b91ebe3/LICENSE>. The pinned recursive tree contains no separate NOTICE file. The schema has not been modified. This repository is also distributed under Apache-2.0; see the root `LICENSE` for the full terms. The upstream attribution above supplements, and is not replaced by, this repository's own copyright notice.
