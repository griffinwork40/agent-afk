"""Tests for bench/harbor/compare.py.

Covers:
- Replicate aggregation: multiple trials sharing a task_name are all retained.
- p-value is always <= 1.0, including the n10=1, n01=1 edge case.
- Empty job directory returns an empty dict (no crash).
"""

from __future__ import annotations

import json
import math
import sys
import os

import pytest

# Ensure the repo root is on sys.path so the bare module import works.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from bench.harbor.compare import _load_trials, _mcnemar_p, _pass_rate, _task_passed  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_trial(
    job_dir: "os.PathLike[str]",
    trial_name: str,
    task_name: str,
    reward: float | None,
) -> None:
    """Write a minimal result.json under job_dir/trial_name/result.json."""
    from pathlib import Path
    trial_dir = Path(job_dir) / trial_name
    trial_dir.mkdir(parents=True, exist_ok=True)
    payload: dict = {"task_name": task_name}
    if reward is not None:
        payload["verifier_result"] = {"rewards": {"reward": reward}}
    (trial_dir / "result.json").write_text(json.dumps(payload))


# ---------------------------------------------------------------------------
# _load_trials: replicate aggregation
# ---------------------------------------------------------------------------

class TestLoadTrials:
    def test_single_trial_per_task(self, tmp_path):
        _write_trial(tmp_path, "trial-001", "task-a", 1.0)
        _write_trial(tmp_path, "trial-002", "task-b", 0.0)
        result = _load_trials(tmp_path)
        assert result == {"task-a": [1.0], "task-b": [0.0]}

    def test_multiple_replicates_retained(self, tmp_path):
        """Two trials with the same task_name must both be kept (not overwritten)."""
        _write_trial(tmp_path, "trial-001", "math-hard", 1.0)
        _write_trial(tmp_path, "trial-002", "math-hard", 0.0)
        result = _load_trials(tmp_path)
        assert "math-hard" in result
        assert sorted(result["math-hard"]) == [0.0, 1.0], (
            "Both replicates must appear; the second trial must not overwrite the first."
        )

    def test_empty_job_dir(self, tmp_path):
        result = _load_trials(tmp_path)
        assert result == {}

    def test_top_level_result_json_skipped(self, tmp_path):
        """The job-level result.json at the root of job_dir must be ignored."""
        # Top-level file (should be skipped)
        (tmp_path / "result.json").write_text(json.dumps({"task_name": "should-skip"}))
        # Valid trial
        _write_trial(tmp_path, "trial-001", "task-ok", 0.5)
        result = _load_trials(tmp_path)
        assert "should-skip" not in result
        assert "task-ok" in result

    def test_missing_reward_stored_as_none(self, tmp_path):
        _write_trial(tmp_path, "trial-001", "task-x", None)
        result = _load_trials(tmp_path)
        assert result == {"task-x": [None]}

    def test_malformed_json_skipped(self, tmp_path):
        bad_dir = tmp_path / "trial-bad"
        bad_dir.mkdir()
        (bad_dir / "result.json").write_text("{not valid json")
        result = _load_trials(tmp_path)
        assert result == {}


# ---------------------------------------------------------------------------
# _mcnemar_p: p-value always in [0.0, 1.0]
# ---------------------------------------------------------------------------

class TestMcnemarP:
    def _numeric(self, val) -> float:
        """Extract a float from the return value (may be a string for n=0)."""
        if isinstance(val, str):
            pytest.skip(f"non-numeric return: {val!r}")
        return float(val)

    def test_no_discordant_pairs_returns_string(self):
        result = _mcnemar_p(0, 0)
        assert isinstance(result, str)

    def test_p_at_most_one_balanced_small(self):
        """n10=1, n01=1 is the canonical case that the old code returned 1.5."""
        p = self._numeric(_mcnemar_p(1, 1))
        assert p <= 1.0, f"p-value {p} exceeds 1.0"

    def test_p_at_most_one_for_range(self):
        """Exhaustive check over small (n10, n01) pairs."""
        for n10 in range(6):
            for n01 in range(6):
                if n10 == 0 and n01 == 0:
                    continue
                val = _mcnemar_p(n10, n01)
                if isinstance(val, str):
                    continue  # n/a strings are fine
                p = float(val)
                assert 0.0 <= p <= 1.0, f"p={p} out of range for n10={n10}, n01={n01}"

    def test_p_is_one_when_concordant(self):
        """Equal discordant counts -> no evidence of difference -> p should be 1.0."""
        p = self._numeric(_mcnemar_p(5, 5))
        assert p == pytest.approx(1.0, abs=0.01)

    def test_p_decreases_with_imbalance(self):
        p_balanced = self._numeric(_mcnemar_p(5, 5))
        p_skewed = self._numeric(_mcnemar_p(10, 0))
        assert p_skewed < p_balanced


# ---------------------------------------------------------------------------
# _pass_rate: works correctly with list-of-replicates
# ---------------------------------------------------------------------------

class TestPassRate:
    def test_all_pass(self):
        trials = {"task-a": [1.0, 1.0], "task-b": [1.0]}
        rate, n = _pass_rate(trials)
        assert rate == pytest.approx(1.0)
        assert n == 3

    def test_all_fail(self):
        trials = {"task-a": [0.0]}
        rate, n = _pass_rate(trials)
        assert rate == pytest.approx(0.0)
        assert n == 1

    def test_mixed(self):
        trials = {"task-a": [1.0, 0.0]}
        rate, n = _pass_rate(trials)
        assert rate == pytest.approx(0.5)
        assert n == 2

    def test_empty_trials(self):
        rate, n = _pass_rate({})
        assert rate == 0.0
        assert n == 0

    def test_none_rewards_excluded(self):
        trials = {"task-a": [None, 1.0]}
        rate, n = _pass_rate(trials)
        assert rate == pytest.approx(1.0)
        assert n == 1
