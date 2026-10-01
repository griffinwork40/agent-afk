"""Harbor installed-agent adapter for agent-afk.

Usage:
    PYTHONPATH=. harbor run -a bench.harbor.afk_agent:AfkAgent \
        -d terminal-bench --n-tasks 1 \
        --model anthropic/claude-haiku-4-5 \
        --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
        -o bench/harbor/jobs

Kwargs (via --agent-kwarg / -ak):
    variant full|minimal (default: full); max_turns int (default: 100);
    effort low|medium|high|xhigh|max; max_budget_usd e.g. "5.00";
    afk_version npm pin e.g. "5.278.2" (default: latest).

Stream-json done event (cost/token accounting):
    { "type": "done", "metadata": { "totalCostUsd": float|null,
      "usage": { "input_tokens": int, "output_tokens": int,
                 "cache_read_input_tokens": int,
                 "cache_creation_input_tokens": int } } }
    src/agent/types/message-types.ts + src/cli/commands/chat.ts:674-681.

Minimal arm (variant=minimal):
  AFK_FRAMEWORK_PROMPT_FILE → empty file: loadSystemPrompt()
  (src/cli/system-prompt.ts:32-46) returns ""; resolveBaseSystemPrompt()
  (src/cli/system-prompt.ts:~149) sees hasFw=false → overlay-only (or none).
  AFK_MAX_NESTING_DEPTH=0: resolveMaxNestingDepth() (src/agent/tools/nesting.ts:46)
  returns 0 → agent/skill/compose dispatch tools disabled.
  Result: "no framework prompt, no delegation tools; builtin tools and any cwd
  AFK.md overlay remain." Task dirs are benchmark-controlled and typically have
  no afk.config.json, so overlays are usually absent too.

Container safety vars (all verified in src/config/env.ts or env.paths.ts):
  --dangerously-skip-permissions → permissionMode=bypassPermissions
    (src/cli/commands/shared-command-options.ts:114)
  AFK_HOME → entire state tier in trial dir (src/config/env.paths.ts:28)
  NO_UPDATE_NOTIFIER=1 → disable update notifier (src/config/env.ts:1619)
  AFK_DISABLE_SPINE_UPDATE=1 → disable SessionEnd LLM hook (src/config/env.ts:181)
  AFK_FRAMEWORK_PROMPT_FILE (minimal) → src/config/env.whatif.ts:78
  AFK_MAX_NESTING_DEPTH (minimal) → src/config/env.ts:264
  Telegram vars suppressed → prevent push noise from leaked host tokens
"""

from __future__ import annotations

import json
import os
import shlex
import tempfile
from pathlib import Path
from typing import Any, Literal, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DEFAULT_MAX_TURNS = 100
_LOGS_DIR_ENV = "AFK_HOME"  # witness trace + session events land here
_EMPTY_PROMPT_PATH = "/tmp/afk-empty-framework-prompt.txt"

# Env vars suppressed inside the container to avoid leaking host tokens:
#   TELEGRAM_BOT_TOKEN / AFK_TELEGRAM_*  → no telegram push from bench trials
#   HOME set by the container runtime;   AFK_HOME overridden to logs dir below
#   NODE_ENV not overridden — defaults to "production" which is fine
_SUPPRESSED_ENV: tuple[str, ...] = (
    "TELEGRAM_BOT_TOKEN",
    "AFK_TELEGRAM_BOT_TOKEN",
    "AFK_TELEGRAM_ALLOWED_CHAT_IDS",
    "AFK_TELEGRAM_PRIMARY_CHAT_ID",
    "AFK_TELEGRAM_NOTIFY_MODE",
)


class AfkAgent(BaseInstalledAgent):
    """Harbor installed agent for agent-afk (afk CLI).

    Runs `afk chat --format stream-json` inside the trial container.
    Supports two ablation arms:
      full    – full framework prompt + all tools enabled
      minimal – empty framework prompt + AFK_MAX_NESTING_DEPTH=0
                (no framework scaffolding, no subagent dispatch tools;
                 builtin tools and any cwd AFK.md overlay remain)
    """

    capabilities = AgentCapabilities(atif=False)

    @staticmethod
    @override
    def name() -> str:
        return "afk"

    def __init__(
        self,
        logs_dir: Path,
        variant: Literal["full", "minimal"] = "full",
        max_turns: int = _DEFAULT_MAX_TURNS,
        effort: str | None = None,
        max_budget_usd: str | None = None,
        afk_version: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._variant = variant
        self._max_turns = int(max_turns)
        self._effort = effort
        self._max_budget_usd = max_budget_usd
        self._afk_version = afk_version  # None → latest
        # Accumulated from stream-json for populate_context_post_run
        self._last_done_metadata: dict[str, Any] | None = None
        super().__init__(logs_dir, **kwargs)

    @override
    def get_version_command(self) -> str | None:
        return (
            'export NVM_DIR="$HOME/.nvm" && '
            '. "$NVM_DIR/nvm.sh" 2>/dev/null || true && '
            "afk --version"
        )

    @override
    def parse_version(self, stdout: str) -> str:
        # afk --version emits e.g. "5.278.2" or a semver line
        return stdout.strip().split("\n")[0].strip()

    # ------------------------------------------------------------------
    # Install
    # ------------------------------------------------------------------

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Install Node via nvm (glibc only) then npm install -g agent-afk."""
        await self.ensure_system_dependencies(
            environment,
            ("curl", "bash", "git", "ca_certificates"),
        )

        pkg = f"agent-afk@{self._afk_version}" if self._afk_version else "agent-afk"

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                + nvm_node_install_snippet()
                + f" && npm install -g {pkg}"
                + " && afk --version"
            ),
        )

        # For minimal arm: create the empty prompt file once at install time
        # so it is stable across multiple run() calls.
        if self._variant == "minimal":
            await self.exec_as_agent(
                environment,
                command=f"touch {shlex.quote(_EMPTY_PROMPT_PATH)}",
            )

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._build_env(environment)
        log_path = (self.environment_logs_dir / "afk-stream.txt").as_posix()

        cli_flags = self._build_cli_flags()

        # Instruction is passed via an env var then piped to stdin, matching
        # ClaudeCode's pattern to avoid shell-injection on special chars.
        instruction_var = "HARBOR_AFK_INSTRUCTION"
        run_env = {**env, instruction_var: instruction}

        await self.exec_as_agent(
            environment,
            command=(
                'export NVM_DIR="$HOME/.nvm" && '
                '. "$NVM_DIR/nvm.sh" 2>/dev/null || true && '
                f'printf "%s" "${instruction_var}" | '
                f"afk chat --format stream-json {cli_flags}"
                f" 2>&1 | tee {log_path}"
            ),
            env=run_env,
        )

        # Parse the tee'd log for usage/cost
        self._last_done_metadata = self._parse_done_metadata(log_path, environment)

    # ------------------------------------------------------------------
    # Post-run context population
    # ------------------------------------------------------------------

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        meta = self._last_done_metadata
        if meta is None:
            # Best-effort: try reading the stream log from the host-side logs dir
            stream_path = self.logs_dir / "afk-stream.txt"
            try:
                content = stream_path.read_text(encoding="utf-8", errors="replace")
                meta = _extract_done_metadata_from_text(content)
            except OSError:
                pass

        if meta is None:
            # No usage data available — left unset per spec
            return

        cost = meta.get("totalCostUsd")
        if isinstance(cost, (int, float)):
            context.cost_usd = float(cost)

        usage = meta.get("usage") or {}
        input_tokens = usage.get("input_tokens", 0) or 0
        output_tokens = usage.get("output_tokens", 0) or 0
        cache_read = usage.get("cache_read_input_tokens", 0) or 0
        cache_creation = usage.get("cache_creation_input_tokens", 0) or 0

        context.n_input_tokens = int(input_tokens + cache_creation)
        context.n_output_tokens = int(output_tokens)
        context.n_cache_tokens = int(cache_read)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _build_env(self, environment: BaseEnvironment) -> dict[str, str]:
        """Construct the env dict for the afk chat run."""
        env: dict[str, str] = {}

        # Forward the API key from model_connection (same pattern as ClaudeCode)
        access = self.model_connection
        if access.api_key:
            env["ANTHROPIC_API_KEY"] = access.api_key
        if access.configured_base_url:
            env["ANTHROPIC_BASE_URL"] = access.configured_base_url

        # Wire logs dir as AFK_HOME so witness trace lands with the trial artifacts
        # (src/config/env.paths.ts:28)
        env[_LOGS_DIR_ENV] = self.environment_logs_dir.as_posix()

        # Disable update-available notifier (src/config/env.ts:1619 NO_UPDATE_NOTIFIER)
        env["NO_UPDATE_NOTIFIER"] = "1"

        # Disable the SessionEnd SPINE.md LLM hook — no git diff in containers
        # (src/config/env.ts:181 AFK_DISABLE_SPINE_UPDATE)
        env["AFK_DISABLE_SPINE_UPDATE"] = "1"

        # Suppress Telegram tokens that don't belong in headless bench runs
        for key in _SUPPRESSED_ENV:
            env[key] = ""

        # Minimal arm ablation knobs (verified in src/config/env.whatif.ts:78
        # and src/config/env.ts:264 respectively)
        if self._variant == "minimal":
            env["AFK_FRAMEWORK_PROMPT_FILE"] = _EMPTY_PROMPT_PATH
            env["AFK_MAX_NESTING_DEPTH"] = "0"

        return env

    def _build_cli_flags(self) -> str:
        """Build the afk chat CLI flags string."""
        parts: list[str] = [
            f"--max-turns {self._max_turns}",
            # Bypass the permission gate — no grant manager in a container
            # (src/cli/commands/shared-command-options.ts:114)
            "--dangerously-skip-permissions",
        ]

        # Strip provider prefix from model name (anthropic/claude-... → claude-...)
        resolved_model = self._resolved_model_name()
        if resolved_model:
            parts.append(f"--model {shlex.quote(resolved_model)}")

        if self._effort:
            parts.append(f"--effort {shlex.quote(self._effort)}")

        if self._max_budget_usd:
            parts.append(f"--max-budget-usd {shlex.quote(self._max_budget_usd)}")

        return " ".join(parts)

    def _resolved_model_name(self) -> str | None:
        """Strip provider prefix from Harbor model name (mirrors ClaudeCode)."""
        if not self.model_name:
            return None
        # Harbor passes "anthropic/claude-sonnet-4-5" — afk expects "claude-sonnet-4-5"
        if "/" in self.model_name:
            return self.model_name.split("/", 1)[-1]
        return self.model_name

    def _parse_done_metadata(
        self,
        log_path: str,
        environment: BaseEnvironment,
    ) -> dict[str, Any] | None:
        """Try to read the tee'd stream log from the container and extract done metadata.

        Returns None if the file is missing or the done event is absent/malformed.
        Relies on environment.exec (synchronous read) being available post-run.
        """
        # We cannot easily read back a remote file without an async call;
        # populate_context_post_run (sync) will read the host-side copy instead.
        return None


def _extract_done_metadata_from_text(content: str) -> dict[str, Any] | None:
    """Parse NDJSON stream log and return the `metadata` dict from the first
    `done` event.  Returns None if not found.

    Event structure (src/agent/types/session-types.ts, OutputEvent union):
      { "type": "done", "metadata": { "totalCostUsd": float|null,
          "usage": { "input_tokens": int, "output_tokens": int,
                     "cache_read_input_tokens": int,
                     "cache_creation_input_tokens": int } } }
    """
    for line in content.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "done":
            meta = event.get("metadata")
            if isinstance(meta, dict):
                return meta
    return None
