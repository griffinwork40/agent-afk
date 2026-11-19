"""Nightly record, regression and CLI tests; no Docker or credentials."""
import copy
import json
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest
from bench.harbor.nightly_report import build_record, append_history, regression, _sign_flip_p

SPEC = {"tasks": [f"task-{i}" for i in range(10)], "model": "fixed-model"}
META = dict(date="2026-01-01", sha="a" * 40, afk_version="5.359.0", run_id="1",
            run_url="https://github.com/test/actions/runs/1", event="schedule")


def trials(path, rewards=None, error=None):
    rewards = [1] * 10 if rewards is None else rewards
    for name, reward in zip(SPEC['tasks'], rewards):
        trial = path / name
        trial.mkdir(parents=True)
        (trial / 'result.json').write_text(json.dumps(dict(task_name=name,
            verifier_result={"rewards": {"reward": reward}},
            exception_info={"exception_type": error, "exception_message": "SECRET"} if error else None)))


def history(tmp_path, outcomes):
    records = []
    for i, rewards in enumerate(outcomes):
        path = tmp_path / str(i)
        trials(path, rewards)
        meta = {**META, 'date': str(date(2026, 1, 1) + timedelta(days=i)), 'run_id': str(i)}
        records.append(build_record(path, SPEC, meta))
    return records


def test_record(tmp_path):
    trials(tmp_path, [1] * 6 + [0] * 4, 'AgentTimeoutError')
    record = build_record(tmp_path, SPEC, META)
    assert record['mean'] == .6
    assert record['valid_for_comparison']
    assert record['tasks']['task-0'] == {'reward': 1., 'error': 'AgentTimeoutError'}
    assert 'SECRET' not in json.dumps(record)
    assert record['metadata']['sha'] == META['sha']
    assert record['spec']['model'] == SPEC['model']


@pytest.mark.parametrize('error', ['AgentSetupTimeoutError', 'AgentAuthenticationError',
    'NonZeroAgentExitCodeError', 'VerifierTimeoutError'])
def test_infra_not_comparable(tmp_path, error):
    trials(tmp_path, error=error)
    assert not build_record(tmp_path, SPEC, META)['valid_for_comparison']


def test_missing_trial_keeps_denominator(tmp_path):
    trials(tmp_path, [1] * 9)
    record = build_record(tmp_path, SPEC, META)
    assert record['mean'] == .9
    assert record['tasks']['task-9']['error'] == 'MissingTrial'
    assert not record['complete'] and not record['valid_for_comparison']


def test_missing_reward(tmp_path):
    trials(tmp_path, [None] + [1] * 9)
    record = build_record(tmp_path, SPEC, META)
    assert record['mean'] == .9
    assert record['tasks']['task-0']['error'] == 'MissingReward'
    assert not record['valid_for_comparison']


def test_malformed_result(tmp_path):
    trials(tmp_path)
    (tmp_path / 'task-0/result.json').write_text('{')
    assert build_record(tmp_path, SPEC, META)['tasks']['task-0']['error'] == 'MissingTrial'


@pytest.mark.parametrize('name', ['task-0', 'unexpected'])
def test_duplicate_unexpected_rejected(tmp_path, name):
    trials(tmp_path)
    other = tmp_path / 'other'
    other.mkdir()
    (other / 'result.json').write_text(json.dumps({'task_name': name}))
    with pytest.raises(ValueError):
        build_record(tmp_path, SPEC, META)


@pytest.mark.parametrize('reward', [float('nan'), float('inf'), .5, '1', True])
def test_invalid_reward(tmp_path, reward):
    trials(tmp_path, [reward] + [1] * 9)
    with pytest.raises(ValueError):
        build_record(tmp_path, SPEC, META)


def test_empty_warmup(tmp_path):
    assert not regression([])['alert']
    assert not regression(history(tmp_path, [[1] * 10] * 9))['alert']


def test_stable(tmp_path):
    assert not regression(history(tmp_path, [[1] * 6 + [0] * 4] * 10))['alert']


def test_sustained_drop(tmp_path):
    decision = regression(history(tmp_path, [[1] * 10] * 7 + [[0] * 10] * 3))
    assert decision['alert']
    assert decision['mean_drop'] == 1
    assert decision['p_value'] == 1 / 1024


def test_single_bad_night_not_enough(tmp_path):
    # Three task failures, one night: 10pp rolling drop, no alert.
    assert not regression(history(tmp_path, [[1] * 10] * 9 + [[0] * 3 + [1] * 7]))['alert']


def test_large_drop_on_few_tasks_not_significant(tmp_path):
    assert not regression(history(tmp_path, [[1] * 10] * 7 + [[0] * 4 + [1] * 6] * 3))['alert']


def test_protocol_dispatch_invalid_excluded(tmp_path):
    records = history(tmp_path, [[1] * 10] * 7 + [[0] * 10] * 3)
    for change in ({'spec_fingerprint': 'new'}, {'metadata': {**records[-1]['metadata'], 'event': 'workflow_dispatch'}},
                   {'valid_for_comparison': False}):
        modified = copy.deepcopy(records)
        modified[-1].update(change)
        assert not regression(modified)['alert']


def test_duplicate_date_not_extra_observation(tmp_path):
    records = history(tmp_path, [[1] * 10] * 9)
    duplicate = copy.deepcopy(records[-1])
    duplicate['metadata']['run_id'] = '99'
    assert not regression(records + [duplicate])['alert']


def test_append_idempotent_corrupt_fails(tmp_path):
    records = history(tmp_path / 'trials', [[1] * 10])
    path = tmp_path / 'history.jsonl'
    append_history(path, records[0])
    append_history(path, records[0])
    assert len(path.read_text().splitlines()) == 1
    with path.open('a') as stream:
        stream.write('{invalid\n')
    with pytest.raises(ValueError):
        append_history(path, records[0])


def test_sign_flip():
    assert _sign_flip_p([1] * 10) == 1 / 1024
    assert _sign_flip_p([0] * 10) == 1
    assert _sign_flip_p([-1] * 10) == 1


def test_cli(tmp_path):
    job = tmp_path / 'job'
    trials(job)
    spec, meta, record, hist, summary, decision = [tmp_path / x for x in
        ('spec.json', 'meta.json', 'record.json', 'history.jsonl', 'summary.md', 'decision.json')]
    spec.write_text(json.dumps(SPEC))
    meta.write_text(json.dumps(META))
    script = Path(__file__).with_name('nightly_report.py')
    subprocess.run([sys.executable, str(script), 'build', '--job-dir', str(job), '--spec', str(spec),
                    '--metadata', str(meta), '--output', str(record)], check=True)
    subprocess.run([sys.executable, str(script), 'publish-local', '--record', str(record), '--history', str(hist),
                    '--summary', str(summary), '--decision', str(decision)], check=True)
    assert '| task-0 | 1 |' in summary.read_text()
    assert '100.0%' in summary.read_text()
    assert not json.loads(decision.read_text())['alert']
