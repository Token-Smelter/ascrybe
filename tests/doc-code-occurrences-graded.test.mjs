import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocTokenIndex, joinDocOccurrences, distinctiveNormalizedKey, normalizedSurfaceKey } from '../tools/doc-code-occurrences.mjs';

test('normalization folds case and separators deterministically and the guard refuses common folds', () => {
  assert.deepEqual({
    camel: normalizedSurfaceKey('MediaEncoder'),
    kebab: normalizedSurfaceKey('orchard-labs'),
    spaced: normalizedSurfaceKey('Orchard Labs'),
    snake: normalizedSurfaceKey('orchard_labs'),
    guard: [distinctiveNormalizedKey('orchardlabs'), distinctiveNormalizedKey('path'), distinctiveNormalizedKey('abc'), distinctiveNormalizedKey('2024')],
  }, {
    camel: 'mediaencoder', kebab: 'orchardlabs', spaced: 'orchardlabs', snake: 'orchardlabs',
    guard: [true, false, false, false],
  });
});

test('prose reaches identifier surfaces through the normalized tier and every edge names its basis', () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'doc-graded-'));
  try {
    writeFileSync(join(root, 'brand.md'), 'Orchard Labs is a sophisticated brand.\nThe media encoder handles audio.\n');
    writeFileSync(join(root, 'exact.md'), 'The `MediaEncoder` symbol is exported.\n');
    const index = buildDocTokenIndex({ docs_root: root });
    const candidates = [
      { fact_kind: 'module', mention: { mention_id: 'm1', surface: 'orchardlabs' } },
      { fact_kind: 'symbol', mention: { mention_id: 'm2', surface: 'MediaEncoder' } },
      { fact_kind: 'symbol', mention: { mention_id: 'm3', surface: 'path' } },
    ];
    const resolutions = [
      { mention_id: 'm1', referent_id: 'referent:ol' },
      { mention_id: 'm2', referent_id: 'referent:encoder' },
      { mention_id: 'm3', referent_id: 'referent:path' },
    ];
    const held = joinDocOccurrences({ index, identity_candidates: candidates, mention_resolutions: resolutions });
    const byReferent = {};
    for (const edge of held.edges) (byReferent[edge.referent_id] ??= []).push([held.documents[edge.doc_index], edge.match_basis]);
    for (const rows of Object.values(byReferent)) rows.sort();
    assert.deepEqual({
      orchardlabs: byReferent['referent:ol'],
      encoder: byReferent['referent:encoder'],
      pathGuarded: byReferent['referent:path'],
      bases: held.report.edges_by_match_basis,
      normalizedOnly: held.report.entities_with_normalized_only_occurrences,
    }, {
      orchardlabs: [['brand.md', 'normalized']],
      encoder: [['brand.md', 'normalized'], ['exact.md', 'exact']],
      pathGuarded: undefined,
      bases: { exact: 1, normalized: 2 },
      normalizedOnly: 2,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
