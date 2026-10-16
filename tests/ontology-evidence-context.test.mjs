import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceContext, validateEvidenceContext, assertSameContext } from '../tools/ontology/evidence-context.mjs';
import { OntologyError } from '../tools/ontology/schemas.mjs';

function context(overrides = {}) {
  return buildEvidenceContext({
    estate: 'example-estate',
    source_identity: { kind: 'single_repository_commit', digest: 'a'.repeat(40) },
    base_projection: { projection_id: 'estate-projection:deadbeef', content_digest: 'b'.repeat(64) },
    coverage: { documentary_documents_included: 1, documentary_documents_eligible: 1 },
    ...overrides,
  });
}

test('buildEvidenceContext seals a self-verifying, content-addressed record', () => {
  const built = context();
  assert.match(built.context_id, /^evidence-context:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => validateEvidenceContext(built));
});

test('buildEvidenceContext fails closed on an incomplete source identity or a malformed digest length', () => {
  assert.throws(() => context({ source_identity: { kind: 'single_repository_commit', digest: '' } }), OntologyError);
  assert.throws(() => context({ source_identity: { kind: 'single_repository_commit', digest: 'zz'.repeat(20) } }), OntologyError);
  assert.throws(() => context({ base_projection: { projection_id: 'not-a-projection-id', content_digest: 'x' } }), OntologyError);
});

test('two evidence contexts built from different source digests never resolve to the same context_id', () => {
  const baseline = context({ source_identity: { kind: 'single_repository_commit', digest: 'a'.repeat(40) } });
  const target = context({ source_identity: { kind: 'single_repository_commit', digest: 'c'.repeat(40) } });
  assert.notEqual(baseline.context_id, target.context_id);
  assert.throws(() => assertSameContext(baseline, target, 'membership build'), OntologyError);
  assert.doesNotThrow(() => assertSameContext(baseline, context(), 'membership build'));
});
