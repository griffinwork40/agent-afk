"""Offline workflow integration: fake trials, real local git remote, mocked model."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import AsyncMock, MagicMock, patch

from bench.harbor.afk_agent import AfkAgent
from bench.harbor.nightly_run import harbor_config
from bench.harbor.nightly_report import build_record
from bench.harbor.nightly_publish import publish, report_issue

SPEC = json.loads(Path(__file__).with_name('nightly.json').read_text())


def test_harbor_config(tmp_path, monkeypatch):
    from harbor.models.job.config import JobConfig
    from harbor.utils.env import resolve_env_vars
    monkeypatch.setenv('CLAUDE_CODE_OAUTH_TOKEN', 'fake-oauth')
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    config = harbor_config(SPEC, tmp_path / 'local.tgz', tmp_path, tmp_path)
    resolved = JobConfig.model_validate(config)
    agent = resolved.agents[0]
    assert agent.override_timeout_sec == 900
    assert agent.override_setup_timeout_sec == 600
    assert resolved.verifier.override_timeout_sec == 180
    assert resolved.n_concurrent_trials == 2
    assert resolved.retry.max_retries == 0
    assert resolved.datasets[0].task_names == SPEC['tasks']
    assert agent.env == {'CLAUDE_CODE_OAUTH_TOKEN': '${CLAUDE_CODE_OAUTH_TOKEN}'}
    assert resolve_env_vars(agent.env)['CLAUDE_CODE_OAUTH_TOKEN'] == 'fake-oauth'
    assert 'fake-oauth' not in json.dumps(config)
    monkeypatch.delenv('CLAUDE_CODE_OAUTH_TOKEN')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'fake-api')
    assert harbor_config(SPEC, tmp_path, tmp_path, tmp_path)['agents'][0]['env'] == {
        'ANTHROPIC_API_KEY': '${ANTHROPIC_API_KEY}'}


def test_local_package_uploaded_in_setup(tmp_path):
    package = tmp_path / 'built.tgz'
    package.write_bytes(b'fake-package')
    # Construct without Harbor/provider startup; exercise the actual install method.
    agent = AfkAgent.__new__(AfkAgent)
    agent._afk_package = package
    agent._afk_version = None
    agent._variant = 'full'
    agent.ensure_system_dependencies = AsyncMock()
    agent.exec_as_agent = AsyncMock()
    environment = MagicMock()
    environment.upload_file = AsyncMock()
    asyncio.run(agent.install(environment))
    environment.upload_file.assert_awaited_once_with(package, '/tmp/afk-under-test.tgz')
    cmd = agent.exec_as_agent.call_args.kwargs['command']
    assert 'npm install -g /tmp/afk-under-test.tgz' in cmd
    assert 'npm install -g agent-afk' not in cmd


def test_run_pipeline_propagates_exit_code(tmp_path):
    # Match the adapter's pipefail construction with fake commands, no afk/model.
    from bench.harbor.test_afk_agent import _make_agent
    fixture = _make_agent(api_key=None)
    agent = fixture._agent
    agent._prompt_template_path = None
    agent._parse_done_metadata = MagicMock(return_value=None)
    agent.exec_as_agent = AsyncMock()
    asyncio.run(agent.run('hello', MagicMock(), MagicMock()))
    cmd = agent.exec_as_agent.call_args.kwargs['command']
    assert 'set -o pipefail;' in cmd
    script = "afk() { return 19; }; " + cmd.replace('/logs/agent/afk-stream.txt', str(tmp_path / 'stream'))
    result = subprocess.run(['bash', '-c', script], env={'PATH': os.environ['PATH'], 'HOME': str(tmp_path)})
    assert result.returncode == 19
    fixture.stop()


def test_publish_real_git_twice(tmp_path):
    remote = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
    job = tmp_path / 'job'
    for name in SPEC['tasks']:
        trial = job / name
        trial.mkdir(parents=True)
        (trial / 'result.json').write_text(json.dumps(dict(task_name=name,
            verifier_result={'rewards': {'reward': 1}})))
    meta = dict(date='2026-11-18', sha='a'*40, afk_version='5.359.0', run_id='123-1',
                run_url='https://github.com/test/actions/runs/123', event='schedule')
    record = build_record(job, SPEC, meta)
    text, decision = publish(record, str(remote), tmp_path / 'first')
    assert '100.0%' in text and not decision['alert']
    publish(record, str(remote), tmp_path / 'second')
    history = subprocess.check_output(['git', '--git-dir', str(remote), 'show', 'harbor-results:history.jsonl'], text=True)
    assert len(history.splitlines()) == 1
    assert json.loads(history)['mean'] == 1
    refs = subprocess.check_output(['git', '--git-dir', str(remote), 'show-ref'], text=True)
    assert 'refs/heads/main' not in refs
    identity = subprocess.check_output(['git', '--git-dir', str(remote), 'log', 'harbor-results', '-1', '--format=%an <%ae>'], text=True)
    assert identity.strip() == 'AFK Agent <agent@agentafk.com>'


def test_actual_baseagent_connection_exists():
    # Guard the inheritance chain; pure mocked fixtures alone could hide API drift.
    from harbor.agents.installed.base import BaseInstalledAgent
    assert hasattr(BaseInstalledAgent, 'model_connection')


def test_tracking_issue_reuses_closed(tmp_path):
    with patch('bench.harbor.nightly_publish.command') as command:
        command.side_effect = ['', '[{"number":42,"state":"CLOSED"}]', '', '']
        report_issue('regression', 'owner/repo', tmp_path / 'issue.md')
        calls = [call.args for call in command.call_args_list]
        assert any('reopen' in call for call in calls)
        assert any('comment' in call for call in calls)
        assert not any(call[:3] == ('gh', 'issue', 'create') for call in calls)


def test_tracking_issue_uses_newest_when_multiple(tmp_path):
    """gh returns newest first; issues[0] must be selected, not issues[-1]."""
    with patch('bench.harbor.nightly_publish.command') as command:
        # Two issues: newest (99, OPEN) first, oldest (1, CLOSED) last
        command.side_effect = [
            '',
            '[{"number":99,"state":"OPEN"},{"number":1,"state":"CLOSED"}]',
            '',
        ]
        report_issue('regression', 'owner/repo', tmp_path / 'issue.md')
        calls = [call.args for call in command.call_args_list]
        # Must comment on issue 99 (newest), not reopen/comment on 1 (oldest)
        assert any('99' in str(call) and 'comment' in call for call in calls)
        assert not any('reopen' in call for call in calls)


def test_publish_duplicate_no_double_alert(tmp_path):
    """Publishing the same record twice must not trigger regression the second time."""
    remote = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
    job = tmp_path / 'job'
    for name in SPEC['tasks']:
        trial = job / name
        trial.mkdir(parents=True)
        (trial / 'result.json').write_text(json.dumps(dict(task_name=name,
            verifier_result={'rewards': {'reward': 1}})))
    meta = dict(date='2026-11-18', sha='a'*40, afk_version='5.359.0', run_id='dup-1',
                run_url='https://github.com/test/actions/runs/1', event='schedule')
    record = build_record(job, SPEC, meta)
    _, decision1 = publish(record, str(remote), tmp_path / 'first')
    # Second publish with the same run_id must not alert
    _, decision2 = publish(record, str(remote), tmp_path / 'second')
    assert decision2['alert'] is False
    assert decision2['reason'] == 'Already recorded'
