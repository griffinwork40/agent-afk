# OpenAI-compatible provider — image limits and many-image guard

> **Context:** Anthropic-direct has a many-image guard
> (`src/agent/providers/anthropic-direct/loop/_many-image-guard.ts`) that
> replaces oversized images with text placeholders once a request carries
> more than 20 image blocks. This document records why an equivalent guard
> is **not** needed for the openai-compatible provider (closes issue #2421).

## Documented limits by backend

| Backend | Image count per request | Per-image size / dimension limit | Total payload | Source |
|---------|------------------------|----------------------------------|---------------|--------|
| OpenAI Chat Completions API | Up to **1,500 images** | Resized (not rejected) to fit model/detail budget; max 65,535 px per side | 512 MB | https://developers.openai.com/api/docs/guides/images-vision |
| OpenAI Responses API | Same as Chat Completions | Same | Same | https://developers.openai.com/api/docs/guides/images-vision |
| xAI / Grok (api.x.ai/v1) | **No documented limit** | Max 20 MiB per image; no dimension-based rejection | Not documented | https://docs.x.ai/developers/model-capabilities/images/understanding |

## Why anthropic-direct needs a guard but openai-compatible does not

Anthropic's API has an **undocumented, non-resizing** behaviour:

- ≤ 20 images in a request → max dimension 8,000 px per side (enforced by
  tool handlers at call time)
- > 20 images in a request → max dimension drops to **2,000 px** with a
  hard HTTP 400 and no auto-resize

An image in the 2,001–8,000 px range passes the per-tool check but causes a
400 once the conversation accumulates more than 20 images. Because the 400
is not retried and the oversized image block persists in history, the session
becomes **unrecoverable** — every subsequent turn re-triggers the same 400.
`enforceManyImageLimit` (applied in `loop/round-request.ts`) exists
specifically to prevent this session-poisoning failure mode.

OpenAI and xAI do **not** have an equivalent cliff:

1. **No session-poisoning threshold.** Neither API silently lowers its
   dimension ceiling at a count boundary. The per-image limits are fixed and
   published.
2. **Images are resized, not rejected, on dimension overflow.** The
   OpenAI API processes images through a configurable `detail` level
   (low / high / original / auto) and resizes them internally to a patch
   budget without rejecting the request. A single image exceeding the patch
   budget is rejected with a clear, per-image error — not a session-wide
   hard failure.
3. **1,500-image and 512 MB limits are practically unhittable.** A typical
   AFK browser-screenshot session captures viewport-sized PNGs (≈ 50–200 KB
   each). Reaching 1,500 images or 512 MB of base64 payload in a single
   request would require an extreme session with no compaction — well beyond
   the context-window token limit that AFK enforces independently via
   `checkContextOverflow`.

## Encoding path

The openai-compatible provider sends images as `image_url` data-URIs on the
Chat Completions wire (`messages.ts:buildUserContent`, `loop.ts:toolResults
ToMessages`) and as `input_image` objects on the Responses API wire
(`responses-messages.ts`). Both are standard OpenAI wire shapes.

## Verdict

No many-image guard is warranted for the openai-compatible provider at this
time. If a new backend is added under the openai-compatible umbrella and its
documentation reveals an undocumented dimension cliff analogous to
Anthropic's, a guard should be added then.

_Investigated 2026-09-30. Issue #2421 closed docs-only._
