import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function invalid(message) {
  const error = new Error(`entity_analysis: ${message}`);
  error.code = 'ENTITY_ANALYSIS_CONFIG_INVALID';
  throw error;
}

function closed(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  if (Object.keys(value).some(key => !fields.includes(key))) invalid(`${label} has unknown fields`);
}

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/u.test(value);
function aliases(value, label) {
  const result = value ?? {};
  closed(result, Object.keys(result), label);
  if (Object.entries(result).some(([key, target]) => !identifier(key) || !identifier(target))) invalid(`${label} must map identifiers to identifiers`);
  return Object.freeze({ ...result });
}

export function validateEntityAnalysisConfig(value) {
  if (value == null) return null;
  closed(value, ['model_path', 'model_entity_export', 'model_edge_export', 'read_model_prefixes', 'id_aliases', 'abbreviations', 'expected_findings', 'subject_exclusions', 'legacy_exclusion_aliases'], 'config');
  if (value.model_path != null && (typeof value.model_path !== 'string' || !value.model_path || isAbsolute(value.model_path) || value.model_path.split(/[\\/]/u).includes('..'))) invalid('model_path must be a nonempty estate-relative path without traversal');
  const prefixes = value.read_model_prefixes ?? [];
  if (!Array.isArray(prefixes) || prefixes.some(prefix => !identifier(prefix))) invalid('read_model_prefixes must be an identifier array');
  const expected = value.expected_findings ?? [];
  if (!Array.isArray(expected)) invalid('expected_findings must be an array');
  for (const row of expected) {
    closed(row, ['entity', 'expected', 'aliases', 'min_signature_classes'], 'expected finding');
    if (!identifier(row.entity) || !['matched', 'discovered_undocumented', 'documented_unwitnessed'].includes(row.expected)) invalid('expected finding has invalid entity or disposition');
    if (row.aliases !== undefined && (!Array.isArray(row.aliases) || row.aliases.some(alias => !identifier(alias)))) invalid('expected finding aliases must be identifiers');
    if (row.min_signature_classes !== undefined && (!Number.isInteger(row.min_signature_classes) || row.min_signature_classes < 1 || row.min_signature_classes > 4)) invalid('min_signature_classes must be 1 through 4');
  }
  const exclusions = value.subject_exclusions ?? [];
  if (!Array.isArray(exclusions)) invalid('subject_exclusions must be an array');
  for (const row of exclusions) {
    closed(row, ['component', 'path', 'path_prefix', 'basename', 'basename_prefix', 'reason'], 'subject exclusion');
    if (typeof row.component !== 'string' || !row.component || !identifier(row.reason)) invalid('subject exclusion requires component and reason');
    const selectors = ['path', 'path_prefix', 'basename', 'basename_prefix'].filter(key => row[key] !== undefined);
    if (selectors.length !== 1 || typeof row[selectors[0]] !== 'string' || !row[selectors[0]]) invalid('subject exclusion requires exactly one nonempty selector');
  }
  const exports = [value.model_entity_export ?? 'ENTITY_KINDS', value.model_edge_export ?? 'EDGE_KINDS'];
  if (exports.some(name => typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name))) invalid('model exports must be JavaScript identifiers');
  return Object.freeze({ model_path: value.model_path ?? null, model_entity_export: exports[0], model_edge_export: exports[1],
    read_model_prefixes: Object.freeze([...prefixes]), id_aliases: aliases(value.id_aliases, 'id_aliases'),
    abbreviations: aliases(value.abbreviations, 'abbreviations'), expected_findings: Object.freeze(expected.map(row => Object.freeze({ ...row }))),
    subject_exclusions: Object.freeze(exclusions.map(row => Object.freeze({ ...row }))),
    legacy_exclusion_aliases: aliases(value.legacy_exclusion_aliases, 'legacy_exclusion_aliases') });
}

export function loadEntityAnalysisConfig(configPath) {
  const selected = configPath || process.env.ASCRYBE_CONFIG;
  if (selected) return validateEntityAnalysisConfig(JSON.parse(readFileSync(selected, 'utf8')).entity_analysis);
  return existsSync('ascrybe.config.json') ? validateEntityAnalysisConfig(JSON.parse(readFileSync('ascrybe.config.json', 'utf8')).entity_analysis) : null;
}

// Normalize only in memory; historical receipt files remain immutable.
export function normalizeDomainExclusionReceipt(record, entityConfig) {
  const config = validateEntityAnalysisConfig(entityConfig);
  const aliases = config?.legacy_exclusion_aliases ?? {};
  const oldReason = record.exclusion_reason;
  if (!Object.hasOwn(aliases, oldReason)) return record;
  const reason = aliases[oldReason];
  return { ...record, schema: 'estate-map/domain-prepass-receipt/v2', exclusion_reason: reason,
    reason: typeof record.reason === 'string' ? record.reason.split(oldReason).join(reason) : record.reason };
}

export function unconfiguredEntityAnalysis(features) {
  return features.map(feature => ({ disposition: 'skipped', reason: 'entity_analysis_unconfigured', feature, count: 1 }));
}
