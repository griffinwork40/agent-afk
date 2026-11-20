"""Publish sanitized history to harbor-results (never main) and one tracking issue."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from bench.harbor.nightly_report import append_history, regression, summary

BRANCH = 'harbor-results'
LABEL = 'nightly-eval-regression'
TITLE = 'ci: nightly Terminal-Bench regression'


def command(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()


def publish(record: dict, remote: str, work: Path) -> tuple[str, dict]:
    """Use a separate repository; no checkout, merge or push to main is possible."""
    command('git', 'init', '--initial-branch', BRANCH, str(work))
    command('git', 'remote', 'add', 'origin', remote, cwd=work)
    exists = command('git', 'ls-remote', '--heads', 'origin', f'refs/heads/{BRANCH}', cwd=work)
    if exists:
        command('git', 'fetch', '--depth=1', 'origin', f'refs/heads/{BRANCH}', cwd=work)
        command('git', 'checkout', '--detach', 'FETCH_HEAD', cwd=work)
    history, appended = append_history(work / 'history.jsonl', record)
    decision = regression(history) if appended else dict(alert=False, reason='Already recorded')
    text = summary(record, decision)
    command('git', 'config', 'user.name', 'AFK Agent', cwd=work)
    command('git', 'config', 'user.email', 'agent@agentafk.com', cwd=work)
    command('git', 'add', 'history.jsonl', cwd=work)
    changed = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=work).returncode
    if changed:
        subprocess.run(['git', 'commit', '-F', '-'], cwd=work, input=f"eval: {record['metadata']['date']} {record['metadata']['run_id']}\n", text=True, check=True)
        # Fast-forward only. Any concurrent writer fails visibly, never overwrites history.
        command('git', 'push', 'origin', f'HEAD:refs/heads/{BRANCH}', cwd=work)
    return text, decision


def report_issue(text: str, repo: str, body: Path):
    command('gh', 'label', 'create', LABEL, '--repo', repo, '--description',
            'Meaningful rolling nightly behaviour regression', '--color', 'B60205', '--force')
    issues = json.loads(command('gh', 'issue', 'list', '--repo', repo, '--label', LABEL,
                                '--state', 'all', '--limit', '100', '--json', 'number,state'))
    body.write_text(text)
    if issues:
        issue = issues[0]  # gh returns newest first; reuse even if a human closed it
        if issue['state'] == 'CLOSED':
            command('gh', 'issue', 'reopen', str(issue['number']), '--repo', repo)
        command('gh', 'issue', 'comment', str(issue['number']), '--repo', repo, '--body-file', str(body))
    else:
        command('gh', 'issue', 'create', '--repo', repo, '--title', TITLE,
                '--label', LABEL, '--body-file', str(body))


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--record', type=Path, required=True)
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    repo = os.environ['GITHUB_REPOSITORY']
    remote = f"https://github.com/{repo}.git"
    # gh configures git authentication from GH_TOKEN; no secret in URL/argv/history.
    command('gh', 'auth', 'setup-git')
    with tempfile.TemporaryDirectory() as directory:
        text, decision = publish(record, remote, Path(directory) / 'results')
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as stream:
            stream.write(text)
        if decision['alert']:
            report_issue(text, repo, Path(directory) / 'issue.md')
            raise SystemExit('Nightly behaviour regression: tracking issue updated')


if __name__ == '__main__':
    main()
