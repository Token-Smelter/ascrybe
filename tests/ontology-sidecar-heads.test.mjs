import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { interpretationSlot, readInterpretationHeads, SidecarHeadError } from '../tools/ontology/sidecar-heads.mjs';

function fakeClient() {
  return new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
}

test('interpretationSlot addresses a working/selected view by exact base projection id', () => {
  assert.equal(interpretationSlot('selected', 'estate-projection:abc'), 'estate-projection:abc:selected');
  assert.equal(interpretationSlot('working', 'estate-projection:abc'), 'estate-projection:abc:working');
});

test('interpretationSlot refuses an unknown view or a base_projection_id missing its scheme prefix', () => {
  assert.throws(() => interpretationSlot('current', 'estate-projection:abc'), SidecarHeadError);
  assert.throws(() => interpretationSlot('selected', 'abc'), SidecarHeadError);
  assert.throws(() => interpretationSlot('selected', ''), SidecarHeadError);
});

test('readInterpretationHeads requires an explicit Neo4jHttpClient instance', async () => {
  await assert.rejects(() => readInterpretationHeads({}, { base_projection_id: 'estate-projection:x' }), SidecarHeadError);
});

test('readInterpretationHeads reports both views, defaulting an absent head to nulls', async () => {
  const client = fakeClient();
  const seen = [];
  client.query = async (statement, parameters) => {
    seen.push({ statement, parameters });
    return [
      ['estate-projection:x:selected', 'estate-interpretation:abc', 'selected', 'estate-projection:x',
        'evidence-context:abc', 'digest-policy', 'digest-content', 40, 40],
      ['estate-projection:x:working', null, null, null, null, null, null, null, null],
    ];
  };
  const heads = await readInterpretationHeads(client, { base_projection_id: 'estate-projection:x' });
  assert.deepEqual(heads, {
    selected: {
      interpretation_id: 'estate-interpretation:abc', status: 'selected', base_projection_id: 'estate-projection:x',
      evidence_context_id: 'evidence-context:abc', policy_digest: 'digest-policy', generation_content_digest: 'digest-content',
      processed_memberships: 40, total_memberships: 40,
    },
    working: {
      interpretation_id: null, status: null, base_projection_id: null, evidence_context_id: null,
      policy_digest: null, generation_content_digest: null, processed_memberships: 0, total_memberships: 0,
    },
  });
  assert.equal(seen[0].parameters.selected_slot, 'estate-projection:x:selected');
  assert.equal(seen[0].parameters.working_slot, 'estate-projection:x:working');
});
