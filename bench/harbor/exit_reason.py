"""Closed-vocabulary reasons for non-zero agent exits, safe for the public record.

Contract: every value this module returns comes from a fixed list written in
this file (category names, option names) or is a small integer parsed with a
digits-only regex (the exit code). No byte of agent output, Harbor exception
text, command text or environment is ever copied into the result, so a
credential printed by the agent cannot reach the record. Anything uncertain
falls back to a category that carries no text ("unclassified",
"reason_unavailable"). Nothing here prints or logs.

Sources read on the runner after Harbor finishes, both treated as untrusted:
  * <trial>/result.json exception_info.exception_message. Harbor 0.23.0 builds
    it in BaseInstalledAgent._classify_exec_error as
    "Command failed (exit N): <command>\\nstdout: ...\\nstderr: ...". Only the
    exit code and the text after "stdout: " are used; the command is skipped.
  * <trial>/agent/afk-stream.txt, the tee of `afk chat --format stream-json
    2>&1` written by afk_agent.py. Model text lives inside JSON events, so only
    non-JSON lines (stderr, Commander errors) and the message/name of
    {"type": "error"} events are matched. That keeps the model's own prose
    (which may mention "rate limit" while working a task) out of the match.
"""
from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path

# Ordered most specific first; the first category with a matching pattern wins.
# Each message is cited to the afk source that emits it.
CATEGORIES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE)) for name, pattern in (
        # Commander rejects an unregistered flag before any afk code runs
        # (node_modules/commander/lib/command.js unknownOption; option registry
        # src/cli/commands/shared-command-options.ts, src/cli/commands/chat.ts).
        ("unknown_option", r"error: unknown option '"),
        ("cli_usage", r"error: (?:too many arguments|missing required argument|"
                      r"option '[^'\n]{1,80}' argument missing|unknown command ')"),
        # src/cli/first-run.ts:73 and src/agent/auth/anthropic-credential-check.ts:35
        ("no_credential", r"No Anthropic credential found"),
        # src/cli/errors/classifier.ts:179 and :201, plus raw Anthropic bodies
        # that the stream-json error event carries (chat.action-body.ts:369).
        ("auth_rejected", r"Authentication failed\.|Access denied \(HTTP 403\)|"
                          r"authentication_error|permission_error|invalid x-api-key|"
                          r"OAuth token has expired|\b401\b[^\n]{0,40}Unauthorized"),
        # src/agent/usage/usage-formatter.ts:225 and :229
        ("usage_limit", r"usage limit reached|credit balance is (?:empty|too low)|"
                        r"usage_limit_reached"),
        # src/cli/errors/classifier.ts:120
        ("budget_cap", r"Session stopped: cost ceiling reached"),
        # src/agent/session/turn-stream-runner.ts:182
        ("max_turns", r"Maximum turns \(\d+\) exceeded"),
        # src/cli/errors/classifier.ts:233
        ("rate_limit", r"Rate limit reached|rate_limit_error|HTTP 429|429 Too Many Requests"),
        # src/cli/errors/classifier.ts:247-248
        ("overloaded", r"temporarily overloaded|overloaded_error|HTTP 529"),
        # src/agent/providers/shared/model-rejected-error.ts:38
        ("model_rejected", r"ModelRejectedError|not_found_error|model_not_found"),
        # src/cli/errors/classifier.ts:273
        ("network", r"Network error: unable to reach|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|"
                    r"EAI_AGAIN|Could not resolve host"),
        # src/cli/errors/classifier.ts:153 and :141
        ("timeout", r"The operation timed out after"),
        ("hook_blocked", r"A hook blocked the operation"),
        # The run command sources nvm, then calls afk (bench/harbor/afk_agent.py).
        ("afk_not_installed", r"afk: (?:command )?not found|command not found: afk"),
        ("node_runtime_error", r"ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError: |"
                               r"ERR_REQUIRE_ESM|Unsupported engine"),
    )
)

# Flags afk_agent.py itself passes. Only these exact strings may be reported as
# the rejected option; anything else is reported as the category alone.
KNOWN_OPTIONS = frozenset({
    "--dangerously-skip-permissions", "--effort", "--format", "--max-budget-usd",
    "--max-turns", "--model",
})

FALLBACKS = ("stream_error_unclassified", "agent_started_unclassified", "no_output",
             "unclassified", "reason_unavailable")
VOCABULARY = frozenset(name for name, _ in CATEGORIES) | frozenset(FALLBACKS)

_EXIT_RE = re.compile(r"\ACommand failed \(exit (-?\d{1,3})\)")
_OPTION_RE = re.compile(r"error: unknown option '(--[a-z][a-z-]{0,40})'")
_STREAM_CAP = 4 * 1024 * 1024   # read at most the last 4 MiB of the stream log
_RESULT_CAP = 8 * 1024 * 1024   # read at most 8 MiB of result.json

# Valid shell exit status: 0-255.  0 is not a non-zero exit so it is never
# produced by _EXIT_RE (which only appears in exception messages from failed
# commands), but _safe must accept exactly this range when re-validating
# a stored value from an old record.
_EXIT_MIN, _EXIT_MAX = 0, 255


def _is_regular_file(path: Path) -> bool:
    """True only when path exists, is a regular file, and is NOT a symlink."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode)


def _plain_lines(text: str) -> list[str]:
    """Lines that cannot be (part of) a stream-json event, which may hold model text.

    Harbor keeps only the head and tail of stdout, so an event can be cut
    mid-line; every NDJSON line, whole or cut, contains a double quote.
    """
    return [line.strip() for line in text.splitlines()
            if line.strip() and '"' not in line and not line.lstrip().startswith("{")]


def _harbor_output(message: str) -> str:
    """Plain lines after the command in Harbor's message; never the command."""
    marker = message.find("\nstdout: ")
    return "\n".join(_plain_lines(message[marker:])) if marker >= 0 else ""


def _stream_text(path: Path) -> tuple[str, bool, bool]:
    """(matchable text, saw any JSON event, saw an error event) from the tee'd log.

    If the path is not a regular non-symlink file, returns empty results rather
    than blocking on a FIFO or following a symlink.
    """
    if not _is_regular_file(path):
        return "", False, False
    try:
        # O_NONBLOCK prevents blocking on a FIFO that somehow passes lstat
        # (a race).  On platforms that do not support it the flag is 0.
        flags = getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, os.O_RDONLY | flags)
        try:
            with os.fdopen(fd, "rb") as stream:
                stream.seek(0, 2)
                start = max(0, stream.tell() - _STREAM_CAP)
                stream.seek(start)
                raw = stream.read(_STREAM_CAP).decode("utf-8", errors="replace")
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
    except OSError:
        return "", False, False
    if start:
        raw = raw.partition("\n")[2]  # drop the line the seek cut in half
    parts, events, errored = [], False, False
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            parts += _plain_lines(stripped)
            continue
        try:
            event = json.loads(stripped)
        except ValueError:
            continue  # a truncated event line; may hold model text, so skip it
        if not isinstance(event, dict):
            continue
        events = True
        if event.get("type") == "error":
            errored = True
            error = event.get("error")
            if isinstance(error, dict):
                parts += [str(error.get("name", "")), str(error.get("message", ""))]
    return "\n".join(parts), events, errored


def classify_trial(trial_dir: Path, exception_info: dict) -> dict:
    """Return {"category", "exit_code"[, "option"]} using only closed values."""
    message = exception_info.get("exception_message")
    message = message if isinstance(message, str) else ""
    match = _EXIT_RE.match(message)
    raw_code = int(match.group(1)) if match else None
    # Accept only valid shell exit status range; exit 0 is not a failure exit.
    exit_code = (raw_code if (raw_code is not None
                              and _EXIT_MIN < raw_code <= _EXIT_MAX) else None)
    stream_text, events, errored = _stream_text(trial_dir / "agent" / "afk-stream.txt")
    text = _harbor_output(message) + "\n" + stream_text
    reason: dict = {"category": None, "exit_code": exit_code}
    for name, pattern in CATEGORIES:
        if pattern.search(text):
            reason["category"] = name
            break
    if reason["category"] == "unknown_option":
        option = _OPTION_RE.search(text)
        if option and option.group(1) in KNOWN_OPTIONS:
            reason["option"] = option.group(1)
    if reason["category"] is None:
        if errored:
            reason["category"] = "stream_error_unclassified"
        elif events:
            reason["category"] = "agent_started_unclassified"
        elif not [line for line in text.splitlines()
                  if line.strip() and line.strip() not in ("stdout: None", "stderr: None")]:
            reason["category"] = "no_output"
        else:
            reason["category"] = "unclassified"
    return reason


def _safe(reason: dict) -> dict:
    """Final gate: drop anything not from the closed vocabulary.

    Never raises regardless of the shape of the input dict values.
    """
    if not isinstance(reason, dict):
        return {"category": "unclassified", "exit_code": None}
    category = reason.get("category")
    # Guard against list/dict/bool/None/int being passed as category.
    out = {"category": (category if isinstance(category, str) and category in VOCABULARY
                        else "unclassified")}
    code = reason.get("exit_code")
    # Accept only plain int in the valid shell exit-status range (0-255).
    out["exit_code"] = (code if type(code) is int and _EXIT_MIN <= code <= _EXIT_MAX
                        else None)
    phase = reason.get("phase")
    if isinstance(phase, str) and phase in ("setup", "run"):
        out["phase"] = phase
    option = reason.get("option")
    if isinstance(option, str) and option in KNOWN_OPTIONS:
        out["option"] = option
    return out


def _read_result_json(path: Path) -> dict | None:
    """Read and parse a result.json safely: regular-file-only, size-capped.

    Returns None on any error or if the path is not a safe regular file.
    """
    if not _is_regular_file(path):
        return None
    try:
        flags = getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, os.O_RDONLY | flags)
        try:
            with os.fdopen(fd, "rb") as f:
                raw = f.read(_RESULT_CAP)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
    except OSError:
        return None
    if len(raw) >= _RESULT_CAP:
        # File is at or over cap: may be truncated mid-JSON or intentionally oversized.
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def exit_reasons(job_dir: Path, expected: list[str]) -> dict:
    """{task: reason} for every expected task whose agent command exited non-zero.

    Never raises: a failure for one trial records "reason_unavailable" for it,
    and a failure listing the job directory returns {}.
    """
    reasons: dict = {}
    try:
        paths = sorted(Path(job_dir).glob("*/result.json"))
    except OSError:
        return {}
    for path in paths:
        name = None
        try:
            data = _read_result_json(path)
            if data is None:
                continue
            name = data.get("task_name")
            info = data.get("exception_info")
            if name not in expected or name in reasons or not isinstance(info, dict):
                continue
            message = info.get("exception_message")
            if not (isinstance(message, str) and _EXIT_RE.match(message)):
                continue  # not a non-zero agent command (timeouts, setup, verifier)
            reason = classify_trial(path.parent, info)
            # Harbor only stamps agent_execution once the run phase starts; an
            # install command that exits non-zero raises the same error class.
            reason["phase"] = "run" if data.get("agent_execution") else "setup"
            reasons[name] = _safe(reason)
        except Exception:  # noqa: BLE001 - fail closed, never break the record
            if isinstance(name, str) and name in expected:
                reasons.setdefault(name, {"category": "reason_unavailable", "exit_code": None})
    return reasons


def annotate(record: dict, job_dir: Path) -> dict:
    """Add tasks[name]["exit_reason"] in place; additive, never touches validity.

    Never raises: on any unexpected record shape it leaves the record unchanged.
    """
    try:
        tasks = record["tasks"]
        if not isinstance(tasks, dict):
            return record
        for name, reason in exit_reasons(job_dir, list(tasks)).items():
            tasks[name]["exit_reason"] = reason
    except Exception:  # noqa: BLE001
        pass
    return record


def describe(task: dict) -> str:
    """Summary-table text for one task; old records without the field still work.

    Never raises regardless of the shape of `task` or its nested values.
    """
    if not isinstance(task, dict):
        return "\u2014"
    raw_error = task.get("error")
    error = raw_error if isinstance(raw_error, str) and raw_error else "\u2014"
    reason = task.get("exit_reason")
    if not isinstance(reason, dict):
        return error
    reason = _safe(reason)
    detail = " ".join(x for x in (reason["category"], reason.get("option")) if x)
    if reason["exit_code"] is not None:
        detail += f", exit {reason['exit_code']}"
    if reason.get("phase"):
        detail += f", {reason['phase']}"
    return f"{error} ({detail})"
