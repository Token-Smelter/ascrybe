import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yamlRecords from './key-adapters/yaml-records.mjs';
import * as syntaxRecords from './key-adapters/syntax-records.mjs';
import * as treePaths from './key-adapters/tree-paths.mjs';

const exec = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const adapters = Object.freeze({ 'yaml-records': yamlRecords, 'syntax-records': syntaxRecords, 'tree-paths': treePaths });

export function gitRepository({ directory, commit }) {
  const command = async args => (await exec('git', ['-C', directory, ...args], { encoding: 'utf8' })).stdout;
  return {
    listFiles: async prefix => (await command(['ls-tree', '-r', '--name-only', commit, '--', prefix || '.'])).split('\n').filter(Boolean),
    readFile: async path => command(['show', `${commit}:${path}`]),
    blobId: async path => (await command(['rev-parse', `${commit}:${path}`])).trim(),
  };
}

export async function deriveKey({ question, config, repository, target_commit, parser }) {
  const adapterName = question.derivation?.adapter;
  const adapter = adapters[adapterName];
  if (!adapter) throw new Error('unknown key adapter');
  // Key derivation has no graph dependency: adapters receive only a commit repository and declarative specification.
  const derived = await adapter.derive({ repository, specification: question.derivation.specification ?? {}, parser });
  if (!derived.answer_units.length) throw new Error('empty derived key is refused');
  const inputs = await Promise.all([...new Set(derived.witnesses.map(witness => witness.path))].sort().map(async path => {
    const bytes = await repository.readFile(path);
    return { path, blob_id: await repository.blobId(path), sha256: sha256(bytes.replace(/\r\n?/g, '\n')) };
  }));
  const normalized = [...new Set(derived.answer_units.map(value => String(value).replace(/\r\n?/g, '\n').normalize('NFC').trim()))].sort();
  const receipt = {
    schema: 'evaluation-key-derivation-receipt/v1', adapter: adapterName, adapter_version: adapter.version,
    target_commit, config_digest: sha256(JSON.stringify(config)), inputs,
    normalized_answer: normalized,
    accepted_witnesses: derived.witnesses.map(witness => ({ ...witness, quote_sha256: sha256(witness.quote ?? '') })),
  };
  receipt.output_digest = sha256(JSON.stringify(receipt));
  return { key: { key_id: question.key_id, answer_kind: question.answer_kind, answer_units: normalized,
    accepted_witnesses: receipt.accepted_witnesses }, receipt };
}
