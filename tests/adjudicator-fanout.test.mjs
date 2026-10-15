import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAdjudicatorFanout } from '../tools/adjudicator-fanout.mjs';
import { createExtractionArtifact } from '../tools/extraction-artifact.mjs';
import { buildNeuralClaimRecord } from '../tools/neural-claim-extractor.mjs';
import { produceCorpus } from '../tools/neural-census.mjs';
import { sha256 } from '../tools/lib.mjs';

const estate = new URL('./fixtures/c4-mini-corpus/estate/', import.meta.url).pathname;

function claim({ snapshot, file, source, object, polarity = 'affirmed' }) {
  const built = buildNeuralClaimRecord({
    proposed: {
      subject: 'server', subject_kind: 'component', predicate_family: 'binds_port', object_or_value: object,
      polarity, modality: 'descriptive', quantifier: 'unspecified',
      scope: { repository: null, component: 'server', environment: 'test', version_or_branch: null, actor: null },
      valid_time: { from: null, until: null }, source_lines: { start: 1, end: 1 },
    },
    file, content: source, section: 'server', snapshot, model: 'mock-extract',
    promptDigest: sha256(file), generatorDigest: sha256('generator'),
  });
  assert.equal(built.ok, true);
  return built.record;
}

function mockFactory(observed, callCounter) {
  return ({ model }) => {
    const per_call = [];
    return {
      model,
      async complete({ prompt, tag }) {
        observed.set(model, [...(observed.get(model) || []), prompt]);
        callCounter.count += 1;
        per_call.push({ tag, model, cost: 0, input_tokens: 1, output_tokens: 1 });
        const ids = [...prompt.matchAll(/SIDE \d+ \(claim ([^,]+),/g)].map(match => match[1]);
        const conflict = model === 'mock/opus';
        return {
          json: {
            resolution: conflict ? 'inconsistent' : 'supported',
            rationale: 'The cited source says "Server binds port".',
            pair_conflict: conflict ? 'conflict' : 'no_conflict',
            side_grounding: ids.map(id => ({ claim_id: id, state: 'supported', rationale: 'Source says "port 1".', quoted_spans: ['port 1'] })),
            context_relation: { scope: 'same', time: 'same', modality: 'same', referent: 'same' },
            context_note: 'Same context.', quoted_spans: ['port 1'],
          },
          text: '', outcome: 'ok', model, usage: { cost: 0, input_tokens: 1, output_tokens: 1 },
        };
      },
      stats: () => ({ kind: 'mock', calls: per_call.length, cost: 0, models: [model], per_call: per_call.slice() }),
      shutdown: async () => {},
    };
  };
}

test('fanout sends identical full-semantic prompts and resumes without repeat calls', async t => {
  const corpus = await produceCorpus(estate);
  const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
  const claims = [
    claim({ snapshot, file: 'a.md', source: 'Server binds port 1.', object: 'port 1' }),
    claim({ snapshot, file: 'b.md', source: 'Server does not bind port 1.', object: 'port 1', polarity: 'negated' }),
  ];
  const artifact = createExtractionArtifact({ snapshot, extraction: { claims, artifacts_examined: 2, model: 'mock-extract', skipped: [], attempts: [], chunk_counts: [], model_stats: { model: 'mock-extract', calls: 2, cost: 0, per_call: [] } }, selection: { max_artifacts: null } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-fanout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const observed = new Map(), firstCalls = { count: 0 };
  const configs = [{ model: 'mock/opus', thinking: null }, { model: 'mock/primary', thinking: 'xhigh' }];
  const report = await runAdjudicatorFanout({ artifact, modelConfigs: configs, sampleSize: 1, concurrency: 1, checkpointDir: dir, runnerFactory: mockFactory(observed, firstCalls) });
  assert.equal(firstCalls.count, 2);
  assert.equal(observed.get('mock/opus')[0], observed.get('mock/primary')[0]);
  assert.equal(report.prompt_identity.byte_identical_across_models, true);
  assert.equal(report.pairwise[0].disagreement_case_ids.length, 1);
  assert.equal(report.human_review_queue.length, 1);
  assert.equal(report.human_review_packets[0].sides.length, 2);
  assert.match(report.human_review_packets[0].sides[0].excerpts[0].text, /port 1/);
  assert.equal(report.models.every(model => model.valid === 1), true);

  const resumedCalls = { count: 0 };
  const resumed = await runAdjudicatorFanout({ artifact, modelConfigs: configs, sampleSize: 1, concurrency: 1, checkpointDir: dir, runnerFactory: mockFactory(new Map(), resumedCalls) });
  assert.equal(resumedCalls.count, 0);
  assert.deepEqual(resumed.sample.case_ids, report.sample.case_ids);
  assert.deepEqual(resumed.pairwise, report.pairwise);
});

test('fanout resume suppresses ambiguous in-flight adjudication replay', async t => {
  const corpus = await produceCorpus(estate);
  const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
  const claims = [
    claim({ snapshot, file: 'a.md', source: 'Server binds port 1.', object: 'port 1' }),
    claim({ snapshot, file: 'b.md', source: 'Server does not bind port 1.', object: 'port 1', polarity: 'negated' }),
  ];
  const artifact = createExtractionArtifact({ snapshot, extraction: { claims, artifacts_examined: 2, model: 'mock-extract', skipped: [], attempts: [], chunk_counts: [], model_stats: { model: 'mock-extract', calls: 2, cost: 0, per_call: [] } }, selection: { max_artifacts: null } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-fanout-interrupted-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configs = [{ model: 'mock/a', thinking: null }, { model: 'mock/b', thinking: null }];
  const firstCalls = { count: 0 };
  await assert.rejects(
    runAdjudicatorFanout({
      artifact, modelConfigs: configs, sampleSize: 1, concurrency: 1, checkpointDir: dir,
      runnerFactory: ({ model }) => ({
        model, kind: 'mock',
        async complete() { firstCalls.count += 1; throw new Error('simulated adjudicator process death'); },
        stats: () => ({ kind: 'mock', calls: firstCalls.count, cost: 0, models: [model], per_call: [] }),
        shutdown: async () => {},
      }),
    }),
    /simulated adjudicator process death/,
  );
  assert.equal(firstCalls.count, 1);

  const resumedCalls = { count: 0 };
  await assert.rejects(
    runAdjudicatorFanout({
      artifact, modelConfigs: configs, sampleSize: 1, concurrency: 1, checkpointDir: dir,
      runnerFactory: mockFactory(new Map(), resumedCalls),
    }),
    error => error?.code === 'INFERENCE_CIRCUIT_OPEN' && error?.detail?.result?.billing_status === 'acceptance_unknown',
  );
  assert.equal(resumedCalls.count, 0, 'circuit opens before repurchasing first model or starting second model');
  const firstJournal = path.join(dir, 'mock__a.jsonl');
  assert.match(await fs.readFile(firstJournal, 'utf8'), /acceptance_unknown/);
});
