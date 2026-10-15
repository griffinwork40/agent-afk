#!/usr/bin/env python3
"""compare.py — read two or more Harbor job dirs and print a paired per-task
table, pass rates, and a McNemar or paired bootstrap test.

Harbor stores trial results in per-trial result.json files (not trial.json).
The reward is nested at verifier_result.rewards.reward.

Usage:
    python bench/harbor/compare.py jobs/arm-a jobs/arm-b [jobs/arm-c ...]

Requires: scipy (optional, for McNemar p-value); pure stdlib otherwise.
"""

from __future__ import annotations

import json
import sys
import math
from pathlib import Path


def _load_trials(job_dir: Path) -> dict[str, list[float | None]]:
    """Return {task_name: [reward, ...]} aggregating every replicate trial.

    Harbor writes per-trial result.json files under <job>/<trial_name>/result.json.
    The job-level result.json is skipped (no task_name field at that level).
    Reward is nested at verifier_result.rewards.reward (float, 0.0-1.0).

    Multiple trials that share a task_name (e.g. a 20-task x 2-trial run) are
    aggregated into a list so pass-rate and McNemar computations see every
    replicate rather than only the last one.
    """
    results: dict[str, list[float | None]] = {}
    for result_path in sorted(job_dir.glob("*/result.json")):
        # Skip the top-level job result.json (parent is the job dir itself)
        if result_path.parent == job_dir:
            continue
        try:
            data = json.loads(result_path.read_text())
        except Exception:
            continue
        # task_name is the canonical key; fall back to trial_name
        task_id = data.get("task_name") or data.get("trial_name") or result_path.parent.name
        verifier_result = data.get("verifier_result") or {}
        rewards = verifier_result.get("rewards") or {}
        reward = rewards.get("reward")
        value: float | None = float(reward) if reward is not None else None
        results.setdefault(task_id, []).append(value)
    return results


def _pass_rate(trials: dict[str, list[float | None]]) -> tuple[float, int]:
    """Return (pass_rate, n_trials) treating reward >= 1.0 as pass."""
    values = [v for replicates in trials.values() for v in replicates if v is not None]
    if not values:
        return 0.0, 0
    passed = sum(1 for v in values if v >= 1.0)
    return passed / len(values), len(values)


def _mcnemar_p(n10: int, n01: int) -> float | str:
    """McNemar test p-value (two-sided) on discordant pairs.

    Contract: returned float is always in [0.0, 1.0].
    """
    try:
        from scipy.stats import binomtest
        n = n10 + n01
        if n == 0:
            return "n/a (no discordant pairs)"
        result = binomtest(min(n10, n01), n, 0.5, alternative="two-sided")
        return round(float(result.pvalue), 4)
    except ImportError:
        pass
    try:
        from scipy.stats import binom
        n = n10 + n01
        if n == 0:
            return "n/a (no discordant pairs)"
        p = min(
            1.0,
            2 * min(
                binom.cdf(min(n10, n01), n, 0.5),
                1 - binom.cdf(min(n10, n01) - 1, n, 0.5),
            ),
        )
        return round(float(p), 4)
    except ImportError:
        # Fallback: normal approximation (valid for n10+n01 >= 25)
        n = n10 + n01
        if n == 0:
            return "n/a"
        z = (abs(n10 - n01) - 1) / math.sqrt(n)
        # Two-tailed p from standard normal CDF approximation
        p = 2 * (1 - _norm_cdf(abs(z)))
        return f"~{round(p, 4)} (approx, install scipy for exact)"


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _task_passed(replicates: list[float | None]) -> bool | None:
    """Majority-pass vote across replicates; None if all rewards are missing."""
    values = [v for v in replicates if v is not None]
    if not values:
        return None
    passed = sum(1 for v in values if v >= 1.0)
    return passed > len(values) / 2


def main(job_dirs: list[Path]) -> None:
    arm_names = [d.name for d in job_dirs]
    arm_data: list[dict[str, list[float | None]]] = [_load_trials(d) for d in job_dirs]

    # Union of task IDs
    all_tasks = sorted({t for arm in arm_data for t in arm})

    if not all_tasks:
        print("No trials found in any of the supplied job directories.")
        sys.exit(1)

    # Header
    col_w = 40
    arm_w = 12
    header = f"{'task':<{col_w}}" + "".join(f"{n:>{arm_w}}" for n in arm_names)
    print(header)
    print("-" * len(header))

    # Per-task table
    for task in all_tasks:
        row = f"{task[:col_w - 1]:<{col_w}}"
        for arm in arm_data:
            replicates = arm.get(task)
            if replicates is None:
                row += f"{'--':>{arm_w}}"
            else:
                result = _task_passed(replicates)
                if result is None:
                    row += f"{'--':>{arm_w}}"
                else:
                    row += f"{'PASS' if result else 'FAIL':>{arm_w}}"
        print(row)

    print()

    # Pass rates
    print("Pass rates:")
    for name, arm in zip(arm_names, arm_data):
        pr, n = _pass_rate(arm)
        print(f"  {name}: {pr:.1%}  ({int(pr * n)}/{n})")

    # Pairwise McNemar on first two arms
    if len(arm_data) >= 2:
        print()
        print(f"McNemar test: {arm_names[0]} vs {arm_names[1]}")
        a, b = arm_data[0], arm_data[1]
        # One vote per task (majority across replicates) for the paired test
        paired = [
            (_task_passed(a[t]), _task_passed(b[t]))
            for t in all_tasks
            if t in a and t in b
            and _task_passed(a[t]) is not None
            and _task_passed(b[t]) is not None
        ]
        n10 = sum(1 for ra, rb in paired if ra and not rb)
        n01 = sum(1 for ra, rb in paired if not ra and rb)
        p = _mcnemar_p(n10, n01)
        print(f"  Discordant pairs: {arm_names[0]} wins={n10}, {arm_names[1]} wins={n01}")
        print(f"  p-value: {p}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    dirs = [Path(a) for a in sys.argv[1:]]
    for d in dirs:
        if not d.is_dir():
            print(f"Error: not a directory: {d}", file=sys.stderr)
            sys.exit(1)
    main(dirs)
