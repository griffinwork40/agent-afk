"""Sanitized nightly records and conservative paired rolling-window alerts (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path


def build_record(job_dir: Path, spec: dict, metadata: dict) -> dict:
    """Never lose failed/missing tasks from the denominator or persist raw logs."""
    expected = spec["tasks"]
    if not expected or len(set(expected)) != len(expected):
        raise ValueError("Expected nonempty unique task list")
    found = {}
    for path in sorted(job_dir.glob("*/result.json")):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        name = data["task_name"]
        if name not in expected or name in found:
            raise ValueError(f"Unexpected or duplicate task: {name}")
        found[name] = data
    tasks = {}
    complete = True
    valid = True
    for name in expected:
        data = found.get(name, {})
        error = (data.get("exception_info") or {}).get("exception_type")
        reward = ((data.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        if reward is None:
            complete = False
            valid = False
            error = error or ("MissingReward" if data else "MissingTrial")
            reward = 0
        if isinstance(reward, bool) or not isinstance(reward, (int, float)):
            raise ValueError(f"Invalid reward for {name}")
        if not math.isfinite(reward) or reward not in (0, 1):
            raise ValueError(f"Nonbinary reward for {name}")
        # Time-limited and budget-capped agent work is behaviour;
        # auth/setup/verifier failures are not.
        _BEHAVIOUR_ERRORS = {"AgentTimeoutError", "AfkBudgetCapError"}
        if error and error not in _BEHAVIOUR_ERRORS:
            valid = False
        tasks[name] = {"reward": float(reward), "error": error}
    safe_meta = {k: metadata[k] for k in
                 ("date", "sha", "afk_version", "run_id", "run_url", "event")}
    fingerprint = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    return dict(schema=1, spec=spec, spec_fingerprint=fingerprint, metadata=safe_meta,
                tasks=tasks, mean=sum(t["reward"] for t in tasks.values()) / len(expected),
                complete=complete, valid_for_comparison=valid)


def load_history(path: Path) -> list[dict]:
    """Corruption must fail closed, not silently change the baseline."""
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def append_history(path: Path, record: dict) -> tuple[list[dict], bool]:
    """Append *record* to the JSONL history file if its run_id is new.

    Returns ``(history, appended)`` where *appended* is ``True`` only when
    the record was actually written.  Callers must gate ``regression()`` on
    *appended* to prevent re-alerting on a duplicate publish run.
    """
    history = load_history(path)
    if any(r["metadata"]["run_id"] == record["metadata"]["run_id"] for r in history):
        return history, False
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(json.dumps(record, sort_keys=True) + "\n")
    return history + [record], True


def _sign_flip_p(deltas: list[float]) -> float:
    observed = sum(deltas)
    return sum(sum(d * s for d, s in zip(deltas, signs)) >= observed - 1e-9
               for signs in itertools.product((-1, 1), repeat=len(deltas))) / 2 ** len(deltas)


def regression(history: list[dict]) -> dict:
    """Latest3 vs prior7 distinct scheduled dates, paired on fixed tasks.

    Nominal one-sided p<=.01 assumes independent symmetric task deltas under H0.
    Correlated tasks and daily overlapping windows invalidate an annual 1% claim.
    """
    result = dict(alert=False, reason="Warmup: need 10 valid scheduled dates",
                  mean_drop=None, p_value=None)
    if not history:
        return result
    current = history[-1]
    if current["metadata"]["event"] != "schedule" or not current["valid_for_comparison"]:
        return {**result, "reason": "Manual or infrastructure-invalid run: not compared"}
    by_date = {}
    for record in history:
        if (record["spec_fingerprint"] == current["spec_fingerprint"]
                and record["valid_for_comparison"] and record["metadata"]["event"] == "schedule"):
            # Append order is execution order; one scheduled observation per UTC date.
            by_date[record["metadata"]["date"]] = record
    dates = sorted(by_date)[-10:]
    if len(dates) < 10:
        return result
    previous = [by_date[d] for d in dates[:7]]
    recent = [by_date[d] for d in dates[7:]]
    deltas = [sum(r["tasks"][t]["reward"] for r in previous) / 7
              - sum(r["tasks"][t]["reward"] for r in recent) / 3 for t in current["tasks"]]
    drop = sum(deltas) / len(deltas)
    p_value = _sign_flip_p(deltas)
    alert = drop >= .20 - 1e-9 and p_value <= .01
    return dict(alert=alert, mean_drop=drop, p_value=p_value,
                reason=f"Latest3 vs prior7: drop {drop:.1%}, paired sign-flip p={p_value:.4f}; "
                       "alert requires drop >=20pp AND p<=0.01",
                prior_dates=dates[:7], recent_dates=dates[7:])


def summary(record: dict, decision: dict) -> str:
    meta = record["metadata"]
    lines = [f"## Nightly Terminal-Bench — {meta['date']}",
             f"[Run]({meta['run_url']}) · `{meta['sha']}` · afk `{meta['afk_version']}`",
             f"Model: `{record['spec']['model']}` · Mean: **{record['mean']:.1%}**",
             f"Complete: {record['complete']} · Comparable: {record['valid_for_comparison']}",
             "", "| Task | Reward | Error class |", "|---|---:|---|"]
    lines += [f"| {name} | {t['reward']:g} | {t['error'] or '—'} |" for name, t in record['tasks'].items()]
    lines += ["", decision["reason"], "", "**REGRESSION**" if decision["alert"] else "No regression alert."]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    for flag in ("job-dir", "spec", "metadata", "output"):
        build.add_argument(f"--{flag}", type=Path, required=True)
    publish = sub.add_parser("publish-local")
    for flag in ("record", "history", "summary", "decision"):
        publish.add_argument(f"--{flag}", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        record = build_record(args.job_dir, json.loads(args.spec.read_text()), json.loads(args.metadata.read_text()))
        args.output.write_text(json.dumps(record, indent=2))
    else:
        record = json.loads(args.record.read_text())
        history, appended = append_history(args.history, record)
        # A rerun of an already-published run must not re-alert stale history.
        decision = regression(history) if appended else dict(alert=False, reason="Already recorded")
        args.summary.write_text(summary(record, decision))
        args.decision.write_text(json.dumps(decision, indent=2))


if __name__ == "__main__":
    main()
