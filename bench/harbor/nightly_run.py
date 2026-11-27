"""Run the pinned nightly protocol, then emit only sanitized results.

No model is contacted until Harbor starts. --prepare-only supports offline validation.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

from bench.harbor.exit_reason import annotate
from bench.harbor.nightly_report import build_record


def harbor_config(spec: dict, package: Path, tasks: Path, output: Path) -> dict:
    return dict(job_name="nightly", jobs_dir=str(output), n_attempts=1,
                n_concurrent_trials=spec['concurrency'], retry={"max_retries": 0},
                # Build timeout is pinned in each task.toml (600s), not a job override.
                environment={"type": "docker"}, environment_build_timeout_multiplier=1.0,
                verifier={"override_timeout_sec": spec['verifier_timeout_sec']},
                datasets=[{"path": str(tasks.resolve()), "task_names": spec['tasks']}],
                agents=[dict(import_path="bench.harbor.afk_agent:AfkAgent", model_name=spec['model'],
                             override_timeout_sec=spec['agent_timeout_sec'],
                             override_setup_timeout_sec=spec['setup_timeout_sec'],
                             env={name: '${' + name + '}' for name in
                                  ('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY') if os.environ.get(name)},
                             kwargs=dict(afk_package=str(package.resolve()), variant=spec['variant'],
                                         max_turns=spec['max_turns'], max_budget_usd=spec['max_budget_usd']))])


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--tasks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    spec_path = Path(__file__).with_name('nightly.json')
    spec = json.loads(spec_path.read_text())
    # Verify exact names before starting paid work. Harbor's task_names uses glob
    # matching; these literal names contain no wildcard characters.
    for name in spec['tasks']:
        manifest = args.tasks / name / 'task.toml'
        if not manifest.is_file():
            raise ValueError(f'Missing pinned task: {name}')
        task = tomllib.loads(manifest.read_text())
        if task['environment']['build_timeout_sec'] != spec['build_timeout_sec']:
            raise ValueError(f'Unexpected environment build timeout: {name}')
    args.output.mkdir(parents=True, exist_ok=True)
    config_path = args.output / 'config.json'
    config_path.write_text(json.dumps(harbor_config(spec, args.package, args.tasks, args.output), indent=2))
    if args.prepare_only:
        return
    if not any(os.environ.get(k) for k in ('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY')):
        raise ValueError('Add repository secret CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY')
    started = datetime.now(timezone.utc).date().isoformat()
    # No credentials in argv or printed config; Harbor expands ${ENV} placeholders.
    completed = subprocess.run(['harbor', 'run', '-c', str(config_path)], check=False)
    metadata = dict(date=started, sha=os.environ['GITHUB_SHA'],
                    afk_version=json.loads(Path('package.json').read_text())['version'],
                    run_id=os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'],
                    run_url=f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
                    event=os.environ['GITHUB_EVENT_NAME'])
    record = build_record(args.output / 'nightly', spec, metadata)
    # Closed-vocabulary reason only; never agent output (bench/harbor/exit_reason.py).
    annotate(record, args.output / 'nightly')
    if completed.returncode:
        record['valid_for_comparison'] = False
        record['harness_error'] = 'HarborNonZeroExit'
    (args.output / 'record.json').write_text(json.dumps(record, indent=2))
    # Record even an infrastructure failure, but never paint it green.
    if completed.returncode or not record['valid_for_comparison']:
        sys.exit('Harbor/infrastructure failure; sanitized record retained for publishing')


if __name__ == '__main__':
    main()
