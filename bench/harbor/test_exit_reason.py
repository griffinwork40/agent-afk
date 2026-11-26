"""Exit-reason classification and leak tests; no Docker, credentials or model calls."""
import base64
import json
import os
import signal
import threading
import time
from pathlib import Path

import pytest

from bench.harbor.compare import _load_trials
from bench.harbor.exit_reason import (VOCABULARY, annotate, classify_trial, describe,
                                      exit_reasons, _safe, _read_result_json)
from bench.harbor.nightly_report import append_history, build_record, load_history, regression, summary

SPEC = {"tasks": [f"task-{i}" for i in range(3)], "model": "fixed-model"}
META = dict(date="2026-01-01", sha="a" * 40, afk_version="6.3.0", run_id="1",
            run_url="https://github.com/test/actions/runs/1", event="schedule")
COMMAND = 'set -o pipefail; printf "%s" "$HARBOR_AFK_INSTRUCTION" | afk chat --format stream-json'


def harbor_message(stdout="", stderr="", code=1, command=COMMAND):
    """Same shape as harbor 0.23.0 BaseInstalledAgent._classify_exec_error."""
    return (f"Command failed (exit {code}): {command}\n"
            f"stdout: {stdout or 'None'}\nstderr: {stderr or 'None'}")


def make_trial(job, name, message=None, stream=None, started=True, error="NonZeroAgentExitCodeError"):
    trial = job / f"{name}__abc"
    (trial / "agent").mkdir(parents=True)
    info = None if message is None else dict(exception_type=error, exception_message=message,
                                             exception_traceback="Traceback: " + message)
    data = dict(task_name=name, verifier_result={"rewards": {"reward": 0}}, exception_info=info)
    if started:
        data["agent_execution"] = {"started_at": "2026-01-01T00:00:00Z"}
    (trial / "result.json").write_text(json.dumps(data))
    if stream is not None:
        (trial / "agent" / "afk-stream.txt").write_text(stream)
    return trial


def classify(tmp_path, stdout="", stream=None, code=1):
    trial = make_trial(tmp_path, "t", harbor_message(stdout, code=code), stream)
    return classify_trial(trial, json.loads((trial / "result.json").read_text())["exception_info"])


def error_event(message, name="Error"):
    return json.dumps({"type": "error", "error": {"message": message, "name": name}}) + "\n"


# Real messages, each from the afk source cited in exit_reason.CATEGORIES.
REAL = [
    ("unknown_option", "error: unknown option '--dangerously-skip-permissions'"),
    ("cli_usage", "error: too many arguments for 'chat'. Expected 1 argument but got 2: a b."),
    ("no_credential", "agent-afk: No Anthropic credential found. Run `afk login` to authenticate."),
    ("auth_rejected", "afk: error: Authentication failed. Check that your API key is valid and has not expired."),
    ("auth_rejected", "afk: error: Access denied (HTTP 403). Your account seat may have been removed."),
    ("usage_limit", "afk: error: Claude usage limit reached (max plan), resets at 3:42 PM."),
    ("usage_limit", "afk: error: Anthropic API credit balance is empty."),
    ("budget_cap", "afk: error: Session stopped: cost ceiling reached ($2.0100 of $2.0000 limit)."),
    ("max_turns", "afk: error: Maximum turns (100) exceeded"),
    ("rate_limit", "afk: error: Rate limit reached. The request was rejected (HTTP 429)."),
    ("overloaded", "afk: error: Anthropic API is temporarily overloaded (HTTP 529). All retry attempts were exhausted."),
    ("network", "afk: error: Network error: unable to reach the API endpoint."),
    ("timeout", "afk: error: The operation timed out after 30 seconds."),
    ("hook_blocked", "afk: error: A hook blocked the operation (event: PreToolUse)."),
    ("afk_not_installed", "bash: line 1: afk: command not found"),
    ("node_runtime_error", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x' imported from /y.js"),
]


@pytest.mark.parametrize("category,line", REAL)
def test_category_from_real_stderr(tmp_path, category, line):
    assert classify(tmp_path, stdout=line, stream=line + "\n")["category"] == category


@pytest.mark.parametrize("category,line", REAL)
def test_category_from_stream_log_only(tmp_path, category, line):
    # Harbor's copy may be truncated away; the tee'd log alone must suffice.
    assert classify(tmp_path, stream=line + "\n")["category"] == category


def test_stream_json_error_event(tmp_path):
    stream = '{"type":"chunk","chunk":{"type":"content","content":"hi"}}\n' + error_event(
        '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        "AuthenticationError")
    assert classify(tmp_path, stream=stream)["category"] == "auth_rejected"


def test_model_prose_is_not_matched(tmp_path):
    # The model talking about rate limits inside a content chunk is not a reason.
    chunk = json.dumps({"type": "chunk", "chunk": {"type": "content",
                        "content": "Rate limit reached. error: unknown option '--x'"}})
    assert classify(tmp_path / "a", stdout=chunk[30:], stream=chunk + "\n")["category"] == "agent_started_unclassified"
    assert classify(tmp_path / "b", stream=chunk + "\n" + error_event("boom"))["category"] == "stream_error_unclassified"


def test_command_text_is_ignored(tmp_path):
    # The command Harbor echoes must never drive a category.
    trial = make_trial(tmp_path, "t", harbor_message(command="afk chat No Anthropic credential found"))
    info = json.loads((trial / "result.json").read_text())["exception_info"]
    assert classify_trial(trial, info)["category"] == "no_output"


def test_exit_code_option_phase_and_fallbacks(tmp_path):
    line = "error: unknown option '--dangerously-skip-permissions'\n"
    make_trial(tmp_path, "task-0", harbor_message(line, code=1), line)
    make_trial(tmp_path, "task-1", harbor_message("garbled", code=127), "garbled\n", started=False)
    make_trial(tmp_path, "task-2", "Agent execution timed out", error="AgentTimeoutError")
    reasons = exit_reasons(tmp_path, SPEC["tasks"])
    assert reasons["task-0"] == {"category": "unknown_option", "exit_code": 1, "phase": "run",
                                 "option": "--dangerously-skip-permissions"}
    assert reasons["task-1"] == {"category": "unclassified", "exit_code": 127, "phase": "setup"}
    assert "task-2" not in reasons  # not a non-zero agent command


def test_unknown_option_name_outside_allowlist_is_dropped(tmp_path):
    reason = classify(tmp_path, stream="error: unknown option '--sk-ant-oat01-abcdefghijkl'\n")
    assert reason["category"] == "unknown_option" and "option" not in reason
    assert "option" not in exit_reasons(tmp_path, ["t"])["t"]


def test_letters_only_unknown_option_is_not_echoed(tmp_path):
    # Passes the shape regex, so only the allowlist keeps it out.
    reason = classify(tmp_path, stream="error: unknown option '--abcdefghijklmnopqrstuvwxyz'\n")
    assert reason == {"category": "unknown_option", "exit_code": 1}


def test_classifier_crash_records_reason_unavailable(tmp_path, monkeypatch):
    import bench.harbor.exit_reason as module
    make_trial(tmp_path, "task-0", harbor_message("x"), "x\n")
    monkeypatch.setattr(module, "classify_trial", lambda *a: 1 / 0)
    assert exit_reasons(tmp_path, SPEC["tasks"]) == {
        "task-0": {"category": "reason_unavailable", "exit_code": None}}


def test_broken_trial_fails_closed(tmp_path):
    make_trial(tmp_path, "task-0", harbor_message("x"), "x\n")
    (tmp_path / "task-0__abc" / "agent" / "afk-stream.txt").unlink()
    (tmp_path / "task-0__abc" / "agent" / "afk-stream.txt").mkdir()  # unreadable as a file
    assert exit_reasons(tmp_path, SPEC["tasks"])["task-0"]["category"] == "unclassified"
    (tmp_path / "bad__x").mkdir()
    (tmp_path / "bad__x" / "result.json").write_text("{not json")
    assert exit_reasons(tmp_path, SPEC["tasks"]).keys() == {"task-0"}
    assert exit_reasons(tmp_path / "missing", SPEC["tasks"]) == {}


SECRET = "sk-ant-oat01-" + "Q7x" * 30
JWT = ".".join(base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip("=")
               for p in ({"alg": "HS256"}, {"sub": "nightly"})) + ".c2lnbmF0dXJlLXNpZ25hdHVyZQ"
LEAKS = {
    "env value": f"CLAUDE_CODE_OAUTH_TOKEN={SECRET}\nANTHROPIC_API_KEY={SECRET}",
    "bearer": f"Authorization: Bearer {SECRET}",
    "jwt": f"token {JWT}",
    "split": f"key part one {SECRET[:40]}\n{SECRET[40:]} part two",
    "url": f"https://user:{SECRET}@example.com/v1?key={SECRET}",
    "in option": f"error: unknown option '--{SECRET}'",
    "in json": json.dumps({"type": "error", "error": {"message": f"401 {SECRET}", "name": SECRET}}),
}
FRAGMENTS = [SECRET, SECRET[:40], SECRET[40:], SECRET[13:33], JWT, JWT.split(".")[1], "Q7xQ7xQ7x"]


@pytest.mark.parametrize("shape", sorted(LEAKS))
def test_planted_credential_never_reaches_record(tmp_path, monkeypatch, shape):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", SECRET)
    blob = LEAKS[shape] + "\nNo Anthropic credential found\n" + "\n".join(f"{k}={v}" for k, v in
                                                                       [("PATH", "/x"), ("TOKEN", SECRET)])
    for i, name in enumerate(SPEC["tasks"]):
        make_trial(tmp_path, name, harbor_message(blob, command=f"afk chat --model {SECRET}"),
                   blob + "\n" + error_event(blob, name=SECRET))
    record = annotate(build_record(tmp_path, SPEC, META), tmp_path)
    history = tmp_path / "h.jsonl"
    append_history(history, record)
    outputs = [json.dumps(record), json.dumps(record, indent=2), summary(record, regression([record])),
               history.read_text()]
    for out in outputs:
        for fragment in FRAGMENTS:
            assert fragment not in out
    for task in record["tasks"].values():
        reason = task["exit_reason"]
        assert reason["category"] in VOCABULARY
        assert set(reason) <= {"category", "exit_code", "phase", "option"}


def test_record_validity_unchanged(tmp_path):
    for name in SPEC["tasks"]:
        make_trial(tmp_path, name, harbor_message("No Anthropic credential found"))
    before = build_record(tmp_path, SPEC, META)
    after = annotate(json.loads(json.dumps(before)), tmp_path)
    assert {k: v for k, v in after.items() if k != "tasks"} == {k: v for k, v in before.items() if k != "tasks"}
    for name in SPEC["tasks"]:
        assert after["tasks"][name]["error"] == before["tasks"][name]["error"]
        assert after["tasks"][name]["exit_reason"]["category"] == "no_credential"
    assert not after["valid_for_comparison"]


PUBLIC_OLD = {"complete": True, "mean": 0.0, "schema": 1, "spec_fingerprint": "f" * 64,
              "spec": SPEC, "valid_for_comparison": False,
              "metadata": {**META, "event": "workflow_dispatch", "run_id": "45722015436-1"},
              "tasks": {n: {"reward": 0.0, "error": "NonZeroAgentExitCodeError"} for n in SPEC["tasks"]}}


def test_old_and_new_records_coexist(tmp_path):
    history = tmp_path / "history.jsonl"
    history.write_text(json.dumps(PUBLIC_OLD, sort_keys=True) + "\n")
    new = json.loads(json.dumps({**PUBLIC_OLD, "metadata": {**META, "run_id": "2"}}))
    new["tasks"]["task-0"]["exit_reason"] = {"category": "unknown_option", "exit_code": 1,
                                             "phase": "run", "option": "--dangerously-skip-permissions"}
    rows, appended = append_history(history, new)
    assert appended and len(load_history(history)) == 2
    regression(rows)
    old_text = summary(PUBLIC_OLD, {"alert": False, "reason": "r"})
    assert "| task-0 | 0 | NonZeroAgentExitCodeError |" in old_text
    new_text = summary(new, {"alert": False, "reason": "r"})
    assert ("| task-0 | 0 | NonZeroAgentExitCodeError (unknown_option "
            "--dangerously-skip-permissions, exit 1, run) |") in new_text
    assert describe({"reward": 1.0, "error": None}) == "\u2014"
    # A tampered reason in a record is still reduced to the closed vocabulary.
    assert describe({"error": "E", "exit_reason": {"category": SECRET, "exit_code": SECRET,
                                                     "option": SECRET, "phase": SECRET}}) == "E (unclassified)"


def test_compare_ignores_new_field(tmp_path):
    make_trial(tmp_path, "task-0", harbor_message("No Anthropic credential found"))
    assert _load_trials(tmp_path) == {"task-0": [0.0]}


# ---------------------------------------------------------------------------
# Hardening tests: type guards, symlinks, FIFOs, oversized files, exit codes
# ---------------------------------------------------------------------------

class TestTypeGuards:
    """_safe and describe must never raise on any JSON-shaped value."""

    @pytest.mark.parametrize("bad_category", [
        [], {}, True, False, None, 42, 3.14, ["unclassified"], {"category": "unclassified"},
        "x" * 10_000,
    ])
    def test_safe_bad_category_becomes_unclassified(self, bad_category):
        result = _safe({"category": bad_category, "exit_code": 1})
        assert result["category"] == "unclassified"

    @pytest.mark.parametrize("bad_code", [
        [], {}, True, False, "1", 3.14, -1, 256, 1000, -999, None,
    ])
    def test_safe_bad_exit_code_becomes_none(self, bad_code):
        result = _safe({"category": "unclassified", "exit_code": bad_code})
        assert result["exit_code"] is None

    def test_safe_valid_exit_codes(self):
        for code in (0, 1, 127, 255):
            assert _safe({"category": "unclassified", "exit_code": code})["exit_code"] == code

    @pytest.mark.parametrize("bad_phase", [
        [], {}, True, 1, None, "setup\x00", "RUN", "SETUP", "x" * 1000,
    ])
    def test_safe_bad_phase_is_dropped(self, bad_phase):
        result = _safe({"category": "unclassified", "exit_code": 1, "phase": bad_phase})
        assert "phase" not in result

    @pytest.mark.parametrize("bad_option", [
        [], {}, True, 1, None, "--model\x00", "--unknown-flag", "x" * 1000,
    ])
    def test_safe_bad_option_is_dropped(self, bad_option):
        result = _safe({"category": "unknown_option", "exit_code": 1, "option": bad_option})
        assert "option" not in result

    def test_safe_non_dict_input(self):
        for bad in [None, [], "string", 42, True]:
            result = _safe(bad)
            assert result["category"] == "unclassified"
            assert result["exit_code"] is None

    @pytest.mark.parametrize("bad_exit_reason", [
        [],
        "unclassified",
        42,
        None,
        True,
        {"category": [], "exit_code": {}},
        {"category": None, "exit_code": None},
        {"category": "unclassified", "exit_code": [], "phase": [], "option": []},
    ])
    def test_describe_bad_exit_reason_never_raises(self, bad_exit_reason):
        result = describe({"error": "E", "exit_reason": bad_exit_reason})
        assert isinstance(result, str)
        assert len(result) < 500

    @pytest.mark.parametrize("bad_error", [
        [],
        {},
        42,
        True,
        None,
        ["some", "list"],
    ])
    def test_describe_non_string_error_uses_placeholder(self, bad_error):
        # error field that is not a string -> show em-dash placeholder
        result = describe({"error": bad_error})
        assert result == "\u2014"

    def test_describe_non_dict_task(self):
        for bad in [None, [], "string", 42]:
            assert describe(bad) == "\u2014"

    def test_annotate_bad_record_shape_never_raises(self, tmp_path):
        for bad in [None, [], "string", 42, {"tasks": None}, {"tasks": "bad"}, {"tasks": []}]:
            result = annotate(bad, tmp_path)
            assert result is bad  # returned unchanged


class TestExitCodeRange:
    """Exit codes outside 0-255 must be rejected; exit 0 is not a failure exit."""

    @pytest.mark.parametrize("code,expected", [
        (1, 1),
        (127, 127),
        (255, 255),
        (0, None),     # exit 0 is not a non-zero exit
        (-1, None),    # negative: invalid shell exit
        (256, None),   # out of range
        (999, None),
    ])
    def test_exit_code_range_in_classify(self, tmp_path, code, expected):
        result = classify(tmp_path, stdout="No Anthropic credential found", code=code)
        assert result["exit_code"] == expected

    def test_safe_exit_code_zero_allowed(self):
        # _safe must accept 0 (stored in old records) even though classify won't produce it.
        assert _safe({"category": "unclassified", "exit_code": 0})["exit_code"] == 0

    def test_safe_exit_code_255_boundary(self):
        assert _safe({"category": "unclassified", "exit_code": 255})["exit_code"] == 255

    def test_safe_exit_code_256_rejected(self):
        assert _safe({"category": "unclassified", "exit_code": 256})["exit_code"] is None

    def test_safe_exit_code_negative_rejected(self):
        assert _safe({"category": "unclassified", "exit_code": -1})["exit_code"] is None


class TestSymlinkSafety:
    """Symlinks must not be followed; secrets in the target must not appear in output."""

    def test_stream_symlink_to_secret_file_is_not_read(self, tmp_path):
        # Create a real file containing a secret that would match a stream pattern.
        secret = "sk-ant-oat01-" + "X9z" * 30
        # This file contains a stream pattern that would change the category if read.
        secret_file = tmp_path / "secret.txt"
        secret_file.write_text(f"error: unknown option '--dangerously-skip-permissions'\n{secret}\n")

        # Build a trial with NO Harbor message match (garbled stdout), so the
        # only way to get a real category is by reading the stream file.
        trial = make_trial(tmp_path, "t", harbor_message("garbled output here"), stream="")
        stream_path = trial / "agent" / "afk-stream.txt"
        stream_path.unlink()
        stream_path.symlink_to(secret_file)

        # _is_regular_file must reject the symlink, so _stream_text returns empty.
        from bench.harbor.exit_reason import _is_regular_file
        assert not _is_regular_file(stream_path), "_is_regular_file must reject symlinks"

        result = exit_reasons(tmp_path, ["t"])
        # If the symlink were followed, category would be "unknown_option".
        # Since it must not be followed, the stream returns empty and we fall
        # through to "unclassified" (garbled stdout, no stream match).
        assert result["t"]["category"] != "unknown_option", \
            "symlink was followed: stream file was read through the symlink"
        # The secret must not appear in the output record.
        out = json.dumps(result)
        assert secret not in out
        assert secret[:20] not in out

    def test_result_json_symlink_is_skipped(self, tmp_path):
        # Put a secret in a real file and symlink result.json at it.
        secret = "sk-ant-oat01-" + "Y8w" * 30
        secret_file = tmp_path / "secret_result.json"
        secret_file.write_text(json.dumps({"task_name": "task-0", "secret": secret,
                                           "exception_info": {"exception_message": secret,
                                                              "exception_type": "NonZeroAgentExitCodeError",
                                                              "exception_traceback": ""}}))
        trial_dir = tmp_path / "task-0__abc"
        (trial_dir / "agent").mkdir(parents=True)
        (trial_dir / "result.json").symlink_to(secret_file)

        result = exit_reasons(tmp_path, ["task-0"])
        # Symlinked result.json must be skipped entirely.
        assert "task-0" not in result
        out = json.dumps(result)
        assert secret not in out


class TestFIFOSafety:
    """A FIFO in place of either input must not block; it should degrade gracefully."""

    @pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="os.mkfifo not available")
    def test_stream_fifo_does_not_block(self, tmp_path):
        trial = make_trial(tmp_path, "t", harbor_message("No Anthropic credential found"), stream="")
        stream_path = trial / "agent" / "afk-stream.txt"
        stream_path.unlink()
        os.mkfifo(stream_path)

        result = None
        exc = []

        def run():
            try:
                result_inner = exit_reasons(tmp_path, ["t"])
                nonlocal result
                result = result_inner
            except Exception as e:
                exc.append(e)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(timeout=5)
        assert not t.is_alive(), "exit_reasons blocked on a FIFO afk-stream.txt"
        assert not exc
        # Must still classify from Harbor's message alone.
        assert result is not None
        assert result["t"]["category"] == "no_credential"

    @pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="os.mkfifo not available")
    def test_result_json_fifo_does_not_block(self, tmp_path):
        trial_dir = tmp_path / "task-0__abc"
        (trial_dir / "agent").mkdir(parents=True)
        result_path = trial_dir / "result.json"
        os.mkfifo(result_path)

        result = None

        def run():
            nonlocal result
            result = exit_reasons(tmp_path, ["task-0"])

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(timeout=5)
        assert not t.is_alive(), "exit_reasons blocked on a FIFO result.json"
        # Skipped entirely; no crash.
        assert result == {}


class TestOversizedResultJson:
    """An oversized result.json (>= cap) must be skipped, not cause an OOM."""

    def test_oversized_result_json_is_skipped(self, tmp_path, monkeypatch):
        import bench.harbor.exit_reason as m
        # Use a tiny cap so we don't need to write 8 MiB in a test.
        # The cap check is len(raw) >= _RESULT_CAP, so a file of exactly cap
        # bytes must cause _read_result_json to return None.
        tiny_cap = 256
        monkeypatch.setattr(m, "_RESULT_CAP", tiny_cap)
        # Build valid JSON that is exactly tiny_cap bytes.
        prefix = b'{"task_name":"task-0","p":"'
        suffix = b'"}'
        fill = b"a" * (tiny_cap - len(prefix) - len(suffix))
        exact = prefix + fill + suffix
        assert len(exact) == tiny_cap
        assert json.loads(exact)  # confirm valid JSON
        f = tmp_path / "result.json"
        f.write_bytes(exact)
        # _read_result_json must return None when len(raw) == cap (the >= guard).
        result = m._read_result_json(f)
        assert result is None, \
            "result.json at exactly the cap must be rejected (len >= cap check)"

    def test_just_under_cap_is_read(self, tmp_path):
        from bench.harbor.exit_reason import _RESULT_CAP
        trial_dir = tmp_path / "task-0__abc"
        (trial_dir / "agent").mkdir(parents=True)
        data = {"task_name": "task-0",
                "exception_info": {
                    "exception_type": "NonZeroAgentExitCodeError",
                    "exception_message": harbor_message("No Anthropic credential found"),
                    "exception_traceback": ""},
                "agent_execution": {"started_at": "2026-01-01T00:00:00Z"},
                "verifier_result": {"rewards": {"reward": 0}}}
        raw = json.dumps(data).encode()
        # Pad to just under the cap with a large string key (keeps JSON valid).
        padded_data = dict(data, _pad=" " * (_RESULT_CAP - len(raw) - 20))
        padded_raw = json.dumps(padded_data).encode()
        assert len(padded_raw) < _RESULT_CAP
        (trial_dir / "result.json").write_bytes(padded_raw)
        result = exit_reasons(tmp_path, ["task-0"])
        assert "task-0" in result
        assert result["task-0"]["category"] == "no_credential"

    def test_stream_read_cap_is_enforced(self, tmp_path, monkeypatch):
        """Content before the stream-cap window must be ignored."""
        import bench.harbor.exit_reason as m
        # Use a tiny cap (32 bytes) so the test file stays small.
        tiny_cap = 32
        monkeypatch.setattr(m, "_STREAM_CAP", tiny_cap)
        trial_dir = tmp_path / "t__abc"
        (trial_dir / "agent").mkdir(parents=True)
        # Place a matching pattern ONLY in the first (pre-cap) region, nothing after.
        # With cap enforced: only the last 32 bytes are read -> no match -> unclassified.
        # Without cap: the whole file is read -> pattern found -> wrong category.
        head = b"No Anthropic credential found\n"  # would match no_credential
        tail = b"garbled output here\n"
        # Ensure head is well outside the cap window.
        padding = b"\n" * (tiny_cap * 4)
        stream_content = head + padding + tail
        assert len(stream_content) > tiny_cap * 2
        (trial_dir / "agent" / "afk-stream.txt").write_bytes(stream_content)
        # No Harbor message match either (garbled).
        info = {"exception_message": harbor_message("garbled output here"),
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_traceback": ""}
        result = m.classify_trial(trial_dir, info)
        # With cap: head is outside window, tail has no pattern -> unclassified.
        assert result["category"] != "no_credential", \
            "stream cap not enforced: pre-cap content was read"
