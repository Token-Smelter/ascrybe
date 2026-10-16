import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreModel, exploreTriage } from '../tools/ontology/explore-model.mjs';

const concept = (accession, label, semantic_category, summary) => ({ accession, label, semantic_category, standing: { summary }, assertions: [{}], evidence: [{}, {}], blockers: [], currentness: { support_stale: 0 } });
const view = {
  generation_id: 'g-1', counts: {}, findings: [],
  legend: { categories: { policy: { meaning: 'a rule', constitutive: ['subject_to'] } } },
  collections: [{ collection_id: 'shop', schemes: [{ accession: 's1', label: 'Carts', definition: 'd', boundary: 'b', concepts: [
    concept('c:a', 'Cart total rule', 'policy', 'documentary_claim'), concept('c:b', 'Cart expiry', 'practice', 'source_observed')] }],
  relations: [{ from: 'c:a', to: 'c:b', type: 'is-checked-before', definition: 'order matters', evidence: [{}] }],
  gaps: [{ kind: 'source_gap', description: 'no code cited', evidence: [{ path: 'docs/cart.md', start_line: 3, end_line: 4, quote: 'q', standing: 'documentary_claim' }] }], unresolved: [] }],
};
const reconcile = { domains: [{ domain_id: 'd:1', source_id: 'shop', label: 'Checkout', kind: 'process', definition: 'x', members: ['c:a', 'c:b', 'c:missing'] }],
  themes: [{ label: 'Buying', definition: 'y', domains: ['d:1'] }], paths: [], unplaced: [{ accession: 'c:b', disposition: 'unassigned', reason: null }],
  summary: { coverage: {}, clusters: {} }, clusters: [], traces: [] };

test('explore model keeps the exact predicate and drops members it cannot index', () => {
  const m = exploreModel({ view, reconcile });
  assert.equal(m.accepted, false);
  assert.deepEqual(m.relations[0].slice(0, 3), [0, 1, 'is-checked-before']);
  assert.deepEqual(m.domains[0].members, [0, 1]);
  assert.deepEqual(m.themes.reconciled[0].domains, [0]);
  assert.equal(m.concepts[0][3], 2);
});

test('relation passages stay out of the page payload but are served per relation, with pins', () => {
  const estate = { manifest: { sources: [{ id: 'shop', ref: 'abc12345', ref_origin: 'pinned' }] }, coverage: { totals: {}, by_source: {}, units_withheld_by_screen: {} }, domains: { domains: [], themes: { themes: [], paths: [] } } };
  const m = exploreModel({ view, estate, reconcile });
  assert.equal(m.relation_records[0].evidence.length, 1);
  assert.equal(JSON.stringify(m).includes('order matters'), true);
  assert.equal(Object.keys(m).includes('relation_records'), false);
  assert.deepEqual(m.pins.sources, [{ id: 'shop', ref: 'abc12345', ref_origin: 'pinned' }]);
  assert.equal(m.schema, 'estate-map/ontology-explore/v2');
});

test('predicate proposals ride beside the original wording and leave relations untouched', () => {
  const predicates = { schema: 'p/v1', model_config: {}, canonical: [{ canonical_id: 'checks', original_types: 1, uses: 1 }], mappings: [{ original_text: 'is-checked-before', canonical_id: 'checks', direction: 'inverse', reason: 'r' }] };
  const m = exploreModel({ view, reconcile, predicates });
  assert.equal(m.relations[0][2], 'is-checked-before');
  assert.deepEqual(m.predicate_proposals.by_text['is-checked-before'], ['checks', 'inverse', 'r']);
});

test('triage rows carry the first cited passage of a gap', () => {
  const [row] = exploreTriage({ view });
  assert.equal(row.type, 'gap');
  assert.equal(row.path, 'docs/cart.md');
});
