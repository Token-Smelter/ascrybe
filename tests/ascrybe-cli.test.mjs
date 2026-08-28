import test from 'node:test';
import assert from 'node:assert/strict';
import { planInvocation, resolveRuntimeConfig, usage } from '../bin/ascrybe.mjs';

const plan = (argv, options) => planInvocation(argv, { environment: {}, cwd: '/work', root: '/app', ...options });

// Five npm scripts pinned a RELATIVE ascrybe.config.json, so every one of them only ran with the
// checkout as the working directory -- for a tool whose job is to map other repositories.
test('the runtime config obeys the flag, then the environment, then the file beside the caller', () => {
  assert.equal(resolveRuntimeConfig(['--runtime-config', '/given.json'], {}, '/work'), null,
    'an explicit flag must be left alone');
  assert.equal(resolveRuntimeConfig([], { ASCRYBE_CONFIG: '/from/env.json' }, '/work'), '/from/env.json');
  assert.equal(resolveRuntimeConfig([], { ASCRYBE_CONFIG: 'relative.json' }, '/work'), '/work/relative.json');
  assert.equal(resolveRuntimeConfig([], {}, '/work'), '/work/ascrybe.config.json',
    'the default must resolve against the caller, not the checkout');
});

test('a config-taking verb is given one, and a verb that takes none is not', () => {
  assert.deepEqual(plan(['query', 'overview']).args,
    ['--runtime-config', '/work/ascrybe.config.json', 'overview']);
  assert.deepEqual(plan(['merge', 'a', 'b']).args, ['a', 'b']);
});

test('a corpus projection is re-execed with a heap it can finish in', () => {
  assert.deepEqual(plan(['project', '--promote']).execArgv, ['--max-old-space-size=16384']);
  assert.deepEqual(plan(['query']).execArgv, []);
});

test('a grouped command requires one of its verbs and passes it through', () => {
  assert.match(plan(['package']).error, /pack, verify, load/u);
  assert.match(plan(['package', 'squash']).error, /pack, verify, load/u);
  // `skill bundle` is the module's default action, not an argument it would understand.
  assert.deepEqual(plan(['skill', 'bundle']).args, []);
  assert.deepEqual(plan(['skill', 'verify']).args, ['verify']);
});

// A grouped module reads its subcommand positionally, so injecting the config ahead of the verb
// put a flag where the subcommand had to be and every `ascrybe package` invocation died on
// `unknown argument: /path/to/ascrybe.config.json`. The first version of this test asserted
// `args.slice(-3)`, which looked only at the tail -- past the end the defect lived at. Assert the
// WHOLE argument vector; a slice cannot catch an ordering bug.
test('a grouped command keeps its verb first, ahead of any injected config', () => {
  assert.deepEqual(plan(['package', 'load', '--bundle', 'x']).args,
    ['load', '--runtime-config', '/work/ascrybe.config.json', '--bundle', 'x']);
  assert.deepEqual(plan(['package', 'pack', '--out', 'y']).args,
    ['pack', '--runtime-config', '/work/ascrybe.config.json', '--out', 'y']);
  // An ungrouped command has no positional head to protect, so config leads as it always did.
  assert.deepEqual(plan(['query', 'overview']).args,
    ['--runtime-config', '/work/ascrybe.config.json', 'overview']);
});

test('the gate battery is not an estate verb', () => {
  // Running Ascrybe's own gates only means anything inside a checkout, which is the line between
  // what belongs on this CLI and what stays an npm script.
  assert.match(plan(['verify']).error, /unknown command/u);
  assert.ok(!usage().includes('the full gate battery'));
});

test('every advertised command resolves to a script under the checkout', () => {
  for (const line of usage().split('\n')) {
    const name = /^ {2}(\S+)/u.exec(line)?.[1];
    if (!name) continue;
    const held = plan([name, ...(/\(([^)]+)\)/u.exec(line)?.[1].split(' | ')[0] ? [/\(([^)]+)\)/u.exec(line)[1].split(' | ')[0]] : [])]);
    assert.equal(held.error, undefined, `${name} is advertised but not dispatchable`);
    assert.ok(held.script.startsWith('/app/'), `${name} must resolve inside the checkout`);
  }
});
