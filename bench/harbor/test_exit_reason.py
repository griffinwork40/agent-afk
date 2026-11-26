"""Exit-reason classification and leak tests; no Docker, credentials or model calls."""
import base64
import json
from pathlib import Path

import pytest

from bench.harbor.compare import _load_trials
from bench.harbor.exit_reason import (VOCABULARY, annotate, classify_trial, describe,
                                      exit_reasons)
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
