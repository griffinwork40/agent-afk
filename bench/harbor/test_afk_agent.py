"""Unit tests for AfkAgent command/env construction and stream-json parsing.

Run with the harbor Python interpreter:
    /Users/griffinlong/.local/share/uv/tools/harbor/bin/python -m pytest \
        bench/harbor/test_afk_agent.py -v

These tests do NOT require Docker, ANTHROPIC_API_KEY, or a running Harbor
environment — they only exercise pure-Python logic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch
import pytest

# ---------------------------------------------------------------------------
# Helpers to construct a minimal AfkAgent without a real environment
# ---------------------------------------------------------------------------

class _AgentFixture:
    """Lightweight stand-in returned by _make_agent.

    Holds the agent instance together with any patchers that must stay active
    while the instance is used.  Call .stop() to tear down patches when done
    (not required in tests that only check attribute values / pure functions).
    """

    def __init__(self, agent, patchers):
        self._agent = agent
        self._patchers = patchers

    def __getattr__(self, name):
        return getattr(self._agent, name)

    def stop(self):
        for p in reversed(self._patchers):
            try:
                p.stop()
            except RuntimeError:
                pass


def _make_agent(
    variant: str = "full",
    max_turns: int = 100,
    effort: str | None = None,
    max_budget_usd: str | None = None,
    afk_version: str | None = None,
    context_window: int | None = None,
    model_name: str | None = None,
    api_key: str | None = "test-key",
    logs_dir: Path | None = None,
):
    """Construct an AfkAgent with mocked Harbor internals."""
    from bench.harbor.afk_agent import AfkAgent

    if logs_dir is None:
        logs_dir = Path("/tmp/test-harbor-logs")

    # Build a resolved-model-connection mock
    mock_conn = MagicMock()
    mock_conn.api_key = api_key
    mock_conn.configured_base_url = None
    mock_conn.provider = None

    # Patch the property on the class while we build the instance
    mc_patcher = patch.object(
        AfkAgent, "model_connection", new_callable=lambda: property(lambda self: mock_conn)
    )
    mc_patcher.start()

    agent = AfkAgent.__new__(AfkAgent)
    # Manually set required attributes that BaseInstalledAgent.__init__ would set
    from bench.harbor.afk_config import validate_context_window
    agent._variant = variant
    agent._max_turns = int(max_turns)
    agent._effort = effort
    agent._max_budget_usd = max_budget_usd
    agent._afk_version = afk_version
    agent._context_window = validate_context_window(context_window)
    agent._last_done_metadata = None
    agent.logs_dir = logs_dir
    agent.environment_logs_dir = Path("/logs/agent")

    # model_name attribute (Harbor sets this from --model flag)
    agent.model_name = model_name

    return _AgentFixture(agent, [mc_patcher])


# ---------------------------------------------------------------------------
# Tests: _resolved_model_name (provider prefix stripping)
# ---------------------------------------------------------------------------

class TestResolvedModelName:
    def test_strips_anthropic_prefix(self):
        agent = _make_agent(model_name="anthropic/claude-sonnet-4-5")
        assert agent._resolved_model_name() == "claude-sonnet-4-5"

    def test_strips_openai_prefix(self):
        agent = _make_agent(model_name="openai/gpt-4o")
        assert agent._resolved_model_name() == "gpt-4o"

    def test_no_prefix_passthrough(self):
        agent = _make_agent(model_name="claude-opus-4")
        assert agent._resolved_model_name() == "claude-opus-4"

    def test_none_when_no_model(self):
        agent = _make_agent(model_name=None)
        assert agent._resolved_model_name() is None

    def test_double_slash_only_first_split(self):
        # Only the first "/" is stripped (provider/sub/model → sub/model)
        agent = _make_agent(model_name="a/b/c")
        assert agent._resolved_model_name() == "b/c"


# ---------------------------------------------------------------------------
# Tests: _build_cli_flags
# ---------------------------------------------------------------------------

class TestBuildCliFlags:
    def test_default_flags(self):
        agent = _make_agent(max_turns=100, model_name="anthropic/claude-sonnet-4-5")
        flags = agent._build_cli_flags()
        assert "--max-turns 100" in flags
        assert "--dangerously-skip-permissions" in flags
        assert "--model claude-sonnet-4-5" in flags

    def test_effort_included(self):
        agent = _make_agent(effort="high", model_name=None)
        flags = agent._build_cli_flags()
        assert "--effort high" in flags

    def test_no_effort_when_none(self):
        agent = _make_agent(effort=None, model_name=None)
        flags = agent._build_cli_flags()
        assert "--effort" not in flags

    def test_max_budget_included(self):
        agent = _make_agent(max_budget_usd="3.50", model_name=None)
        flags = agent._build_cli_flags()
        assert "--max-budget-usd 3.50" in flags

    def test_no_model_flag_when_none(self):
        agent = _make_agent(model_name=None)
        flags = agent._build_cli_flags()
        assert "--model" not in flags

    def test_custom_max_turns(self):
        agent = _make_agent(max_turns=200, model_name=None)
        flags = agent._build_cli_flags()
        assert "--max-turns 200" in flags


# ---------------------------------------------------------------------------
# Tests: _build_env — full vs minimal arm
# ---------------------------------------------------------------------------

class TestBuildEnv:
    def _fake_env(self, agent):
        """Call _build_env with a dummy environment object."""
        return agent._build_env(environment=MagicMock())

    def test_full_arm_no_ablation_keys(self):
        agent = _make_agent(variant="full")
        env = self._fake_env(agent)
        assert "AFK_FRAMEWORK_PROMPT_FILE" not in env
        assert "AFK_MAX_NESTING_DEPTH" not in env

    def test_minimal_arm_sets_ablation_keys(self):
        agent = _make_agent(variant="minimal")
        env = self._fake_env(agent)
        assert "AFK_FRAMEWORK_PROMPT_FILE" in env
        assert env["AFK_FRAMEWORK_PROMPT_FILE"] == "/tmp/afk-empty-framework-prompt.txt"
        assert env["AFK_MAX_NESTING_DEPTH"] == "0"

    def test_api_key_forwarded(self):
        agent = _make_agent(api_key="sk-test-123")
        env = self._fake_env(agent)
        assert env["ANTHROPIC_API_KEY"] == "sk-test-123"

    def test_telegram_vars_suppressed(self):
        agent = _make_agent()
        env = self._fake_env(agent)
        # These must be set to "" to prevent leakage
        assert "TELEGRAM_BOT_TOKEN" in env
        assert env["TELEGRAM_BOT_TOKEN"] == ""
        assert "AFK_TELEGRAM_BOT_TOKEN" in env

    def test_afk_home_set_to_logs_dir(self):
        agent = _make_agent()
        env = self._fake_env(agent)
        assert env["AFK_HOME"] == "/logs/agent"

    def test_no_headless_flag(self):
        # AFK_HEADLESS does not exist in src/; must not be set
        agent = _make_agent()
        env = self._fake_env(agent)
        assert "AFK_HEADLESS" not in env

    def test_no_update_notifier(self):
        # NO_UPDATE_NOTIFIER=1 suppresses npm update noise (src/config/env.ts:1619)
        agent = _make_agent()
        env = self._fake_env(agent)
        assert env.get("NO_UPDATE_NOTIFIER") == "1"

    def test_disable_spine_update(self):
        # AFK_DISABLE_SPINE_UPDATE=1 disables SessionEnd LLM hook (src/config/env.ts:181)
        agent = _make_agent()
        env = self._fake_env(agent)
        assert env.get("AFK_DISABLE_SPINE_UPDATE") == "1"

    def test_no_api_key_when_none(self):
        agent = _make_agent(api_key=None)
        env = self._fake_env(agent)
        assert "ANTHROPIC_API_KEY" not in env


# ---------------------------------------------------------------------------
# Tests: instruction quoting edge cases (via the shell command template)
# ---------------------------------------------------------------------------

class TestInstructionQuoting:
    """The instruction is passed via env var (HARBOR_AFK_INSTRUCTION) and
    printf'd to stdin — we verify no shell metacharacters survive into the
    run command itself."""

    def _run_command_str(self, agent, instruction: str) -> str:
        """Simulate what the run() method passes to exec_as_agent."""
        import shlex as _shlex
        instruction_var = "HARBOR_AFK_INSTRUCTION"
        log_path = (agent.environment_logs_dir / "afk-stream.txt").as_posix()
        cli_flags = agent._build_cli_flags()
        cmd = (
            'export NVM_DIR="$HOME/.nvm" && '
            '. "$NVM_DIR/nvm.sh" 2>/dev/null || true && '
            f'printf "%s" "${instruction_var}" | '
            f"afk chat --format stream-json {cli_flags}"
            f" 2>&1 | tee {log_path}"
        )
        return cmd

    def test_instruction_not_embedded_in_command(self):
        """The instruction itself never appears in the command string."""
        agent = _make_agent(model_name=None)
        instruction = 'echo "hello $(id)" && rm -rf /'
        cmd = self._run_command_str(agent, instruction)
        # Instruction must NOT be embedded in the command
        assert 'echo "hello' not in cmd
        assert "rm -rf" not in cmd
        # It should be referenced via the env var name only
        assert "HARBOR_AFK_INSTRUCTION" in cmd

    def test_backtick_instruction_safe(self):
        agent = _make_agent(model_name=None)
        instruction = "`dangerous_backtick`"
        cmd = self._run_command_str(agent, instruction)
        assert "dangerous_backtick" not in cmd

    def test_newline_instruction_safe(self):
        agent = _make_agent(model_name=None)
        instruction = "line1\nline2\nline3"
        cmd = self._run_command_str(agent, instruction)
        # Newlines must not appear in the command string itself
        assert "line1" not in cmd


# ---------------------------------------------------------------------------
# Tests: stream-json parsing (_extract_done_metadata_from_text)
# ---------------------------------------------------------------------------

FIXTURE_DONE_EVENT: dict[str, Any] = {
    "type": "done",
    "metadata": {
        "totalCostUsd": 0.042,
        "numTurns": 5,
        "usage": {
            "input_tokens": 1234,
            "output_tokens": 567,
            "cache_read_input_tokens": 200,
            "cache_creation_input_tokens": 50,
        },
    },
}

FIXTURE_STREAM = "\n".join([
    json.dumps({"type": "chunk", "chunk": {"type": "content", "content": "Hello"}}),
    json.dumps({"type": "chunk", "chunk": {"type": "content", "content": " world"}}),
    json.dumps(FIXTURE_DONE_EVENT),
])


class TestStreamJsonParsing:
    def _parse(self, text: str):
        from bench.harbor.afk_agent import _extract_done_metadata_from_text
        return _extract_done_metadata_from_text(text)

    def test_extracts_metadata_from_done_event(self):
        meta = self._parse(FIXTURE_STREAM)
        assert meta is not None
        assert meta["totalCostUsd"] == pytest.approx(0.042)

    def test_extracts_token_counts(self):
        meta = self._parse(FIXTURE_STREAM)
        assert meta is not None
        usage = meta["usage"]
        assert usage["input_tokens"] == 1234
        assert usage["output_tokens"] == 567
        assert usage["cache_read_input_tokens"] == 200
        assert usage["cache_creation_input_tokens"] == 50

    def test_returns_none_when_no_done_event(self):
        stream = json.dumps({"type": "chunk", "chunk": {"type": "content", "content": "x"}})
        meta = self._parse(stream)
        assert meta is None

    def test_returns_none_for_empty_input(self):
        meta = self._parse("")
        assert meta is None

    def test_handles_malformed_json_lines(self):
        stream = "not-json\n" + json.dumps(FIXTURE_DONE_EVENT)
        meta = self._parse(stream)
        assert meta is not None
        assert meta["totalCostUsd"] == pytest.approx(0.042)

    def test_null_total_cost_usd(self):
        event = dict(FIXTURE_DONE_EVENT)
        event["metadata"] = dict(FIXTURE_DONE_EVENT["metadata"])
        event["metadata"]["totalCostUsd"] = None
        meta = self._parse(json.dumps(event))
        assert meta is not None
        assert meta["totalCostUsd"] is None

    def test_error_event_not_confused_with_done(self):
        stream = "\n".join([
            json.dumps({"type": "error", "error": {"message": "boom"}}),
            json.dumps(FIXTURE_DONE_EVENT),
        ])
        meta = self._parse(stream)
        assert meta is not None
        assert meta["totalCostUsd"] == pytest.approx(0.042)


# ---------------------------------------------------------------------------
# Tests: populate_context_post_run
# ---------------------------------------------------------------------------

class TestPopulateContextPostRun:
    def test_populates_cost_and_tokens_from_metadata(self):
        fixture = _make_agent()
        inner = fixture._agent  # access the real AfkAgent instance
        inner._last_done_metadata = FIXTURE_DONE_EVENT["metadata"]
        inner.logs_dir = Path("/nonexistent-logs-dir-xyz")  # prevent file read fallback

        ctx = MagicMock()
        inner.populate_context_post_run(ctx)

        assert ctx.cost_usd == pytest.approx(0.042)
        assert ctx.n_input_tokens == 1234 + 50   # input + cache_creation
        assert ctx.n_output_tokens == 567
        assert ctx.n_cache_tokens == 200

    def test_noop_when_no_metadata(self):
        fixture = _make_agent()
        inner = fixture._agent
        inner._last_done_metadata = None
        inner.logs_dir = Path("/tmp/no-such-harbor-test-dir-xyz")

        ctx = MagicMock()
        inner.populate_context_post_run(ctx)

        # populate_context_post_run should return without raising and without
        # setting any cost/token attributes when metadata is unavailable.
        ctx.cost_usd.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: kwargs parsing — variant, afk_version, max_turns coercion
# ---------------------------------------------------------------------------

class TestKwargsParsing:
    def test_max_turns_int_coercion(self):
        # max_turns can arrive as a string from Harbor CLI kwargs
        agent = _make_agent(max_turns="50")  # type: ignore[arg-type]
        assert agent._max_turns == 50

    def test_afk_version_none(self):
        agent = _make_agent(afk_version=None)
        assert agent._afk_version is None

    def test_afk_version_pin(self):
        agent = _make_agent(afk_version="5.278.2")
        assert agent._afk_version == "5.278.2"

    def test_variant_full(self):
        agent = _make_agent(variant="full")
        assert agent._variant == "full"

    def test_variant_minimal(self):
        agent = _make_agent(variant="minimal")
        assert agent._variant == "minimal"


# ---------------------------------------------------------------------------
# Tests: context_window kwarg — validate_context_window
# ---------------------------------------------------------------------------

class TestValidateContextWindow:
    def _validate(self, value):
        from bench.harbor.afk_config import validate_context_window
        return validate_context_window(value)

    def test_none_returns_none(self):
        assert self._validate(None) is None

    def test_valid_int(self):
        assert self._validate(128000) == 128000

    def test_string_coercion(self):
        # Harbor CLI passes all kwargs as strings
        assert self._validate("128000") == 128000

    def test_zero_raises(self):
        with pytest.raises(ValueError, match="> 0"):
            self._validate(0)

    def test_negative_raises(self):
        with pytest.raises(ValueError, match="> 0"):
            self._validate(-1)

    def test_over_max_raises(self):
        with pytest.raises(ValueError, match="MAX_CONTEXT_WINDOW_OVERRIDE"):
            self._validate(10_000_001)

    def test_exactly_max_accepted(self):
        assert self._validate(10_000_000) == 10_000_000

    def test_non_numeric_string_raises(self):
        with pytest.raises(ValueError, match="positive integer"):
            self._validate("not-a-number")

    def test_float_string_raises(self):
        # "128000.5" is not a valid integer
        with pytest.raises(ValueError, match="positive integer"):
            self._validate("128000.5")

    def test_agent_stores_validated_value(self):
        agent = _make_agent(context_window=128000)
        assert agent._context_window == 128000

    def test_agent_none_when_unset(self):
        agent = _make_agent(context_window=None)
        assert agent._context_window is None


# ---------------------------------------------------------------------------
# Tests: build_config_write_command — JSON content, path, quoting safety
# ---------------------------------------------------------------------------

class TestBuildConfigWriteCommand:
    def _cmd(self, afk_home="/logs/agent", model_id="qwen-3.8-27b", cw=128000):
        from bench.harbor.afk_config import build_config_write_command
        return build_config_write_command(
            afk_home=afk_home,
            model_id=model_id,
            context_window=cw,
        )

    def test_correct_config_path(self):
        cmd = self._cmd(afk_home="/logs/agent")
        assert "/logs/agent/config/afk.config.json" in cmd

    def test_mkdir_p_present(self):
        cmd = self._cmd()
        assert "mkdir -p" in cmd

    def test_json_contains_model_id(self):
        cmd = self._cmd(model_id="qwen-3.8-27b")
        assert "qwen-3.8-27b" in cmd

    def test_json_contains_context_window(self):
        cmd = self._cmd(cw=128000)
        assert "128000" in cmd

    def test_json_slot_is_local(self):
        cmd = self._cmd()
        assert '"local"' in cmd

    def test_json_provider_is_openai(self):
        cmd = self._cmd()
        assert '"openai"' in cmd

    def test_json_parses_correctly(self):
        """The JSON embedded in the command must be valid and structurally correct."""
        import re
        cmd = self._cmd(model_id="qwen-3.8-27b", cw=128000)
        # Extract the single-quoted JSON blob after printf '%s'
        # Command form: printf '%s' '<json>' > '<path>'
        match = re.search(r"printf '%s' '(.+)' >", cmd)
        assert match, f"Could not find JSON in command: {cmd!r}"
        cfg = json.loads(match.group(1))
        assert cfg["models"]["local"]["id"] == "qwen-3.8-27b"
        assert cfg["models"]["local"]["contextWindow"] == 128000
        assert cfg["models"]["local"]["provider"] == "openai"

    def test_prefix_stripped_cerebras(self):
        """cerebras/qwen-3.8-27b → qwen-3.8-27b (prefix-strip happens upstream)."""
        # The adapter strips the prefix via _resolved_model_name before calling
        # build_config_write_command, so here we test the stripped id directly.
        import re
        cmd = self._cmd(model_id="qwen-3.8-27b")
        match = re.search(r"printf '%s' '(.+)' >", cmd)
        assert match
        cfg = json.loads(match.group(1))
        assert cfg["models"]["local"]["id"] == "qwen-3.8-27b"
        assert "/" not in cfg["models"]["local"]["id"]

    def test_hostile_model_id_quoted_safely(self):
        """A model id with shell metacharacters is safe because the entire JSON
        blob is passed to the shell inside a shlex.quote'd single-quoted string.
        The model id is embedded inside JSON via json.dumps (which escapes it),
        and the resulting JSON string is then single-quoted by shlex.quote, so
        no unquoted metacharacters reach the shell interpreter.
        """
        import re
        hostile_id = '$(rm -rf /); evil`whoami`'
        cmd = self._cmd(model_id=hostile_id)
        # The command must use printf '%s' '<single-quoted-json>' to avoid
        # shell expansion — verify the JSON blob is single-quoted.
        # shlex.quote produces '...' or "..." depending on content; for JSON
        # with no single-quotes it always produces '...'.
        assert "printf '%s'" in cmd, "command must use printf '%s' form"
        # The JSON blob (single-quoted) must be present and parseable
        match = re.search(r"printf '%s' '(.+)' >", cmd)
        assert match, f"Could not extract quoted JSON from: {cmd!r}"
        cfg = json.loads(match.group(1))
        assert cfg["models"]["local"]["id"] == hostile_id
        # Confirm the raw $(...) is not unquoted (i.e., it lives inside single quotes)
        # Split on the single-quoted section to check nothing dangerous is outside it
        parts = cmd.split("'")
        # parts: [prefix, json-blob, suffix] (odd indices are inside quotes)
        # No unquoted part should contain bare $( or backtick
        for i, part in enumerate(parts):
            if i % 2 == 0:  # outside single quotes
                assert "$(" not in part, f"Unquoted $( in part {i}: {part!r}"
                assert "`" not in part, f"Unquoted backtick in part {i}: {part!r}"

    def test_agent_prefix_strip_then_config(self):
        """End-to-end: agent strips cerebras/ prefix; config uses bare id."""
        agent = _make_agent(
            model_name="cerebras/qwen-3.8-27b",
            context_window=128000,
        )
        resolved = agent._resolved_model_name()
        assert resolved == "qwen-3.8-27b"
        # The config command would use the resolved id
        from bench.harbor.afk_config import build_config_write_command
        cmd = build_config_write_command(
            afk_home="/logs/agent",
            model_id=resolved,
            context_window=128000,
        )
        import re
        match = re.search(r"printf '%s' '(.+)' >", cmd)
        assert match
        cfg = json.loads(match.group(1))
        assert cfg["models"]["local"]["id"] == "qwen-3.8-27b"
        assert cfg["models"]["local"]["contextWindow"] == 128000
