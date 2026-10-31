import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRiskDetailed } from './risk-classifier.js';
import { classifyBashCommand } from './tools/readonly-bash.js';
import { createSafeDestructDetect, detectDestructiveCommands } from './safe-destruct-detect.js';
import { createReleaseBoundaryDetect, detectReleaseBoundaryCommands } from './release-boundary-detect.js';

// Contract: captured on d97a3747d BEFORE consumer migration. These are literal
// verdict receipts, not expectations derived from the new classifier's tables.
// Pin known false positives and policy differences as well as real mutations.
const COMMANDS = [
  '', 'ls -la', 'cat file.txt', 'find . -name "*.ts"', 'echo hello',
  'git status', 'git log --oneline -5', 'git diff HEAD', 'pnpm test',
  'cat file.txt | grep foo', 'git log --grep="git push" --oneline',
  'grep -rn "cp " src/', 'git stash list', 'git stash show stash@{0}',
  'git log -S push', 'git help push', 'git log --format=%H\\ x',
  'ls 2>/dev/null', 'cat <(ls)', 'ls # c', 'echo platform retrieval',
  'curl -I https://example.com -X "POST"', 'curl -X POST https://example.com',
  'curl -XPOST https://example.com', 'curl --request=DELETE https://example.com',
  'curl -d "{}" https://example.com', 'curl -I https://example.com',
  'curl --data @body.json https://example.com', 'curl -o out https://example.com',
  'wget --post-file=body.bin https://example.com', 'wget --spider https://example.com',
  'rm -rf dist/', 'rm -r -f dist/', 'rm --recursive --force dist/',
  'rm -rf / --no-preserve-root', 'rm file.txt', 'git reset --hard HEAD',
  'git -C repo reset --hard', 'git clean -fd', 'git clean --force -x',
  'git push --force origin main', 'git push -f', 'git push --force-with-lease',
  'git push origin main', 'git branch -D feature', 'git branch -d feature',
  'git stash', 'git stash push', 'git stash pop', 'git stash create',
  'git stash store', 'git stash branch rescue', 'git --no-pager stash drop',
  'git commit -m "git reset --hard; npm publish"',
  'git commit -m "--dry-run"; npm publish',
  'gh pr create --title "npm publish" --body "terraform destroy"',
  'dd if=image of=/dev/sda', 'dd if=/dev/zero of=/dev/null',
  'mkfs.ext4 /dev/sdb1', 'echo boot > /dev/sda', 'shred -u secret',
  'find . -delete', "find . -exec 'rm' {} +", 'docker system prune -af',
  'docker rm -f app', 'kubectl delete pod app', 'terraform destroy',
  "psql -c 'DROP TABLE users'", "mysql -e 'TRUNCATE TABLE users'",
  "psql -c 'DELETE FROM users'", 'launchctl load service.plist',
  'launchctl bootstrap gui/501 service.plist', 'launchctl submit -l app -- app',
  'launchctl start app', 'launchctl kickstart app', 'launchctl enable app',
  'systemctl --user enable --now app', 'systemctl daemon-reload',
  'systemctl enable-linger user', 'npm publish', 'pnpm publish',
  'yarn publish', 'yarn npm publish', 'cargo publish', 'cargo --locked publish',
  'twine upload dist/*', 'poetry publish', 'gem push app.gem',
  'docker push image', 'docker image push image', 'gh release create v1',
  'terraform apply', 'kubectl apply -f app.yaml', 'git push --mirror',
  'git push --tags', 'git push --follow-tags', 'npm publish --dry-run',
  'cargo --locked publish --dry-run', 'terraform apply -refresh-only',
  'kubectl apply --dry-run=client -f app.yaml',
  'npm publish --dry-run && echo done', 'npm publish --dry-run; pnpm publish',
  'rm -rf x && git reset --hard && npm publish',
  "rg 'npm publish' README.md", "grep 'npm publish' docs/ && git status",
  "echo 'git reset --hard'", "bash -c 'npm publish'",
  "sh -c 'git reset --hard'", "rg 'terraform destroy' .",
  'echo "$(git reset --hard)"', 'echo `git push --force`',
  'env -u X git push', 'g=git; $g push', 'command git reset --hard',
  'printf x | xargs -n 1 git push', 'cat installer | bash',
  'cat data | python3 -m json.tool', 'gh pr view 1 --json title | jq .',
  'python3 -c "open(\'x\',\'w\').write(\'x\')"',
  'python3 -c "open(\'x\').read()"', 'sed -i s/a/b/ file',
  'git config user.name "Foo"', 'git config --global --get user.name',
  'echo x>file', 'echo x >> file', 'echo x &>file',
  "cat > report <<'EOF'\nnpm publish\ngit reset --hard\nEOF",
  'cat > report <<EOF\n$(git reset --hard)\nEOF',
  "git commit -F - <<'EOF'\nnpm publish\ngit reset --hard\nEOF",
];

const cwd = path.join(os.tmpdir(), 'classifier-golden');
const worktreeCwd = path.join(cwd, '.afk-worktrees', 'golden');
const rootDestruct = createSafeDestructDetect(cwd);
const childDestruct = createSafeDestructDetect(worktreeCwd);
const release = createReleaseBoundaryDetect();

describe('pre-migration command verdict golden receipts (#3846)', () => {
  it.each(COMMANDS)('%s', (command) => {
    const context = { event: 'PreToolUse' as const, toolName: 'bash', input: { command } };
    expect({
      risk: classifyRiskDetailed('bash', { command }, { cwd }),
      mutation: classifyBashCommand(command),
      destructiveIds: detectDestructiveCommands(command),
      releaseIds: detectReleaseBoundaryCommands(command),
      rootDestruct: rootDestruct(context),
      childDestruct: childDestruct(context),
      overrideDestruct: rootDestruct({ ...context, cwd: worktreeCwd }),
      release: release(context),
    }).toMatchSnapshot();
  });
});
