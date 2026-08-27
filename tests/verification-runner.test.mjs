import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('verification falsifiers preserve prior behavior and prove cross-worktree identity scope', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-falsifiers.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.match(output, /PASS verification falsifiers: 22\/22 fail-closed scratch-copy probes produced literal evidence; all prior 18 remain green/u);
});
