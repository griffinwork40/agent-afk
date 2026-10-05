"""Helpers for writing afk.config.json into the trial container's AFK_HOME.

Extracted from afk_agent.py to keep that file under 350 code lines.

Public API used by AfkAgent:
    _validate_context_window(value) -> int | None
    _build_config_write_command(afk_home, model_id, context_window) -> str
"""

from __future__ import annotations

import json
import shlex

# Maximum accepted contextWindow override (mirrors MAX_CONTEXT_WINDOW_OVERRIDE
# in src/agent/session/model-slots.ts:477 — values above are rejected at write).
MAX_CONTEXT_WINDOW_OVERRIDE = 10_000_000


def validate_context_window(value: int | str | None) -> int | None:
    """Validate and coerce the context_window kwarg.

    Returns None when value is None (feature disabled).
    Raises ValueError with a clear message on invalid input.
    """
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"context_window must be a positive integer, got {value!r}"
        )
    if n <= 0:
        raise ValueError(
            f"context_window must be > 0, got {n}"
        )
    if n > MAX_CONTEXT_WINDOW_OVERRIDE:
        raise ValueError(
            f"context_window must be ≤ {MAX_CONTEXT_WINDOW_OVERRIDE:,} "
            f"(MAX_CONTEXT_WINDOW_OVERRIDE), got {n}"
        )
    return n


def build_config_write_command(
    afk_home: str,
    model_id: str,
    context_window: int,
) -> str:
    """Return a POSIX shell command that writes $AFK_HOME/config/afk.config.json.

    The JSON is built via json.dumps (injection-safe) and passed to the shell
    via shlex.quote so no shell metacharacters in model_id can escape.

    Slot choice: "local" is used because:
      - Its default id is '' (unconfigured), so setting it does not shadow any
        existing cloud-model routing when afk is invoked with a raw model id.
      - contextWindowOverrideFor() matches binding.id === concreteId regardless
        of slot, so any slot works; "local" matches the source-comment example
        at src/agent/model-limits.ts:~246.
      - provider is included so loadConfig routing works with
        AFK_PROVIDER=openai-compatible.
    """
    config_obj = {
        "models": {
            "local": {
                "id": model_id,
                "provider": "openai",
                "contextWindow": context_window,
            }
        }
    }
    config_json = json.dumps(config_obj)
    config_dir = f"{afk_home}/config"
    config_path = f"{config_dir}/afk.config.json"
    # Use printf '%s' to avoid printf format-string interpretation of the JSON.
    # shlex.quote wraps the JSON in single quotes, neutralising all metacharacters.
    return (
        f"mkdir -p {shlex.quote(config_dir)} && "
        f"printf '%s' {shlex.quote(config_json)} > {shlex.quote(config_path)}"
    )
