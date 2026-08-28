import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commandNames } from '../bin/ascrybe.mjs';

const root = new URL('..', import.meta.url).pathname;
const docs = ['README.md', 'USAGE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'skills/ascrybe/SKILL.md',
  ...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];

// A CLI shipped while every document still taught `npm run map:query --` is drift that nothing
// catches: both spellings work, so nothing fails and the docs quietly describe the old surface.
// The estate verbs come from the CLI itself, so this cannot fall out of step with the partition.
test('no document teaches an npm spelling for a verb the CLI owns', () => {
  const owned = commandNames();
  const offenders = [];
  for (const doc of docs) {
    const text = readFileSync(join(root, doc), 'utf8');
    for (const match of text.matchAll(/npm run ([a-z]+)(?::([a-z]+))?/gu)) {
      const [whole, group] = match;
      // `npm run state:init` and `npm run map:query` both name work the CLI now owns; `map` is the
      // retired prefix for query, cypher, project and dashboard.
      if (owned.includes(group) || group === 'map') offenders.push(`${doc}: ${whole}`);
    }
  }
  assert.deepEqual(offenders, [], 'these should read `ascrybe <verb>`');
});

test('what stays an npm script is work done to Ascrybe, not to an estate', () => {
  const owned = commandNames();
  // The converse guard: the partition is only meaningful if the platform chores are absent from
  // the CLI. `verify` is the one that keeps wandering across the line.
  for (const chore of ['verify', 'build', 'setup']) {
    assert.ok(!owned.includes(chore), `${chore} acts on Ascrybe itself and belongs to npm`);
  }
});

test('the two doors exist and point at each other', () => {
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /USAGE\.md/u);
  assert.match(agents, /CONTRIBUTING\.md/u);
  assert.match(readFileSync(join(root, 'USAGE.md'), 'utf8'), /CONTRIBUTING\.md/u);
  assert.match(readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8'), /USAGE\.md/u);
});
