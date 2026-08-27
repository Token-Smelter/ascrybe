import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { documentaryScope } from '../tools/documentary-scope.mjs';

function corpus(files) {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'scope-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SPEC = '# Design\n\nThe runner MUST verify the digest before promoting.\n';
const LOG = '## 2026-04-24 transcript\n\nuser: what happened\nassistant: the run stopped\n';

test('a document nothing can refute is withheld from the paid read, and said so', () => {
  const root = corpus({ 'design/DESIGN.md': SPEC, '_transcripts/HANDOFF.md': LOG });
  try {
    const held = documentaryScope({ paths: ['design/DESIGN.md', '_transcripts/HANDOFF.md'], materialized_root: root });
    assert.deepEqual({
      reading: held.included,
      withheld: held.excluded.map(row => [row.path, row.category, row.basis]),
      counts: held.counts.excluded_by_category,
    }, {
      reading: ['design/DESIGN.md'],
      withheld: [['_transcripts/HANDOFF.md', 'no_adjudication_frame', 'derived']],
      counts: { no_adjudication_frame: 1 },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a declared rule withholds by path and is attributed to its category', () => {
  const root = corpus({ 'design/DESIGN.md': SPEC, 'tools/retired/NOTES.md': SPEC });
  try {
    const held = documentaryScope({
      paths: ['design/DESIGN.md', 'tools/retired/NOTES.md'],
      materialized_root: root,
      exclusions: [{ category: 'retired_subsystem', description: 'a subsystem already decided against',
        path_prefixes: ['tools/retired/'] }],
    });
    assert.deepEqual({
      reading: held.included,
      withheld: held.excluded.map(row => [row.path, row.category, row.basis]),
      declaredRules: held.rules.declared.map(row => row.category),
    }, {
      reading: ['design/DESIGN.md'],
      withheld: [['tools/retired/NOTES.md', 'retired_subsystem', 'declared']],
      declaredRules: ['retired_subsystem'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the derived rule can be turned off without disabling declared rules', () => {
  const root = corpus({ '_transcripts/HANDOFF.md': LOG });
  try {
    const held = documentaryScope({ paths: ['_transcripts/HANDOFF.md'], materialized_root: root,
      skip_unadjudicable: false });
    assert.deepEqual({ reading: held.included, derivedRules: held.rules.derived.length },
      { reading: ['_transcripts/HANDOFF.md'], derivedRules: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable document is read rather than silently withheld', () => {
  const root = corpus({ 'design/DESIGN.md': SPEC });
  try {
    // Absent from the tree: withholding it here would be a silent exclusion nobody declared, and
    // the extractor refusing it loudly is better than this module dropping it quietly.
    const held = documentaryScope({ paths: ['design/DESIGN.md', 'design/ABSENT.md'], materialized_root: root });
    assert.deepEqual(held.included, ['design/DESIGN.md', 'design/ABSENT.md']);
    assert.equal(held.counts.excluded, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
