// Deterministic fresh-population selection and source-first evidence freezing for the @8/@9 gate.
// No model output is accepted here: this module operates only on source inventories and windows.
import path from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const PAIRED_POPULATION_SCHEMA = 'estate-map/paired-extraction-population/v1';
const canonical = value => stableStringify(value).trim();
const DEFAULT_FORMAT_QUOTAS = Object.freeze({ md: 10, yaml: 4, json: 2, mjs: 2, html: 2 });

export class PairedPopulationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PairedPopulationError';
    this.code = code;
    this.detail = detail;
  }
}

const formatOf = file => {
  const extension = path.extname(file).toLowerCase().replace(/^\./, '');
  return extension === 'yml' ? 'yaml' : (extension || 'none');
};
const areaOf = file => {
  const parts = String(file).split('/');
  if (parts[0] !== 'design') return parts[0].includes('.') ? 'root' : parts[0];
  return parts.length > 1 ? `design/${parts[1]}` : 'design';
};
const sizeOf = bytes => bytes <= 8 * 1024 ? 'small' : bytes <= 32 * 1024 ? 'medium' : 'large';
const structureOf = types => {
  if (types.has('code')) return 'code';
  if (types.has('table')) return 'table';
  if (types.has('list')) return 'list';
  return 'prose';
};

function annotateWindow(window, inventory) {
  if (!inventory) throw new PairedPopulationError('WINDOW_INVENTORY_MISSING', window.file);
  const primary = new Set(window.primary_block_addresses || []);
  const blocks = inventory.blocks.filter(block => primary.has(block.address));
  if (blocks.length !== primary.size) {
    throw new PairedPopulationError('WINDOW_BLOCK_MISSING', window.id, {
      declared: primary.size, resolved: blocks.length,
    });
  }
  const types = new Set(blocks.map(block => block.type));
  return Object.freeze({
    id: window.id,
    file: window.file,
    kind: window.kind,
    primary_bytes: window.primary_bytes,
    primary_blocks: blocks.length,
    format: formatOf(window.file),
    area: areaOf(window.file),
    size: sizeOf(window.primary_bytes),
    structure: structureOf(types),
    primary_block_addresses: [...primary].sort(),
    source_digest: inventory.source_digest,
  });
}

const rank = (seed, row) => sha256(canonical({ seed, id: row.id }));

/**
 * Select a format-quota population while greedily increasing area, size, and structure coverage.
 * One window per file prevents a single long dossier from dominating the 20 paired observations.
 */
export function selectFreshPairedPopulation({
  windows, inventories, excluded_window_ids = [], excluded_files = [], seed = 'v9-paired-gate-20260804',
  format_quotas = DEFAULT_FORMAT_QUOTAS,
} = {}) {
  const inventoryByFile = inventories instanceof Map ? inventories : new Map(inventories.map(row => [row.path, row]));
  const excludedIds = new Set(excluded_window_ids);
  const excludedPaths = new Set(excluded_files);
  const annotated = windows
    .filter(window => !excludedIds.has(window.id) && !excludedPaths.has(window.file))
    .map(window => annotateWindow(window, inventoryByFile.get(window.file)));
  const selected = [], usedFiles = new Set(), seenAreas = new Set(), seenSizes = new Set(), seenStructures = new Set();
  for (const [format, wanted] of Object.entries(format_quotas)) {
    for (let ordinal = 0; ordinal < wanted; ordinal += 1) {
      const candidates = annotated.filter(row => row.format === format && !usedFiles.has(row.file));
      if (!candidates.length) {
        throw new PairedPopulationError('FORMAT_QUOTA_UNSATISFIED', `${format} requires ${wanted}`, {
          format, wanted, selected: ordinal,
        });
      }
      candidates.sort((left, right) => {
        const score = row => Number(!seenAreas.has(row.area)) * 8
          + Number(!seenSizes.has(row.size)) * 4 + Number(!seenStructures.has(row.structure)) * 2;
        return score(right) - score(left) || rank(seed, left).localeCompare(rank(seed, right));
      });
      const chosen = candidates[0];
      selected.push(chosen);
      usedFiles.add(chosen.file);
      seenAreas.add(chosen.area); seenSizes.add(chosen.size); seenStructures.add(chosen.structure);
    }
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

function chooseAuditBlocks(row, inventory, maximum = 4) {
  const allowed = new Set(row.primary_block_addresses);
  const blocks = inventory.blocks.filter(block => allowed.has(block.address) && block.type !== 'separator');
  const priority = ['heading', 'code', 'table', 'list', 'paragraph', 'front_matter'];
  const chosen = [];
  for (const type of priority) {
    const held = blocks.filter(block => block.type === type)
      .sort((a, b) => b.bytes - a.bytes || a.address.localeCompare(b.address));
    if (held.length) chosen.push(held[0]);
    if (chosen.length >= maximum) break;
  }
  for (const block of blocks) {
    if (chosen.length >= maximum) break;
    if (!chosen.some(rowBlock => rowBlock.address === block.address)) chosen.push(block);
  }
  return chosen.slice(0, maximum).sort((a, b) => a.index - b.index);
}

/** Freeze exact source blocks before inference. Human gold labels are layered onto these bytes. */
export function freezeSourceFirstFrames({ population, inventories, blocks_per_window = 4 }) {
  const inventoryByFile = inventories instanceof Map ? inventories : new Map(inventories.map(row => [row.path, row]));
  return population.map(row => {
    const inventory = inventoryByFile.get(row.file);
    const blocks = chooseAuditBlocks(row, inventory, blocks_per_window).map(block => Object.freeze({
      address: block.address,
      id: block.id,
      digest: block.digest,
      type: block.type,
      file: block.file,
      start: block.start,
      end: block.end,
      text: block.text,
    }));
    if (!blocks.length) throw new PairedPopulationError('EMPTY_SOURCE_FIRST_FRAME', row.id);
    return Object.freeze({ window_id: row.id, file: row.file, blocks });
  });
}

export function buildPairedPopulationArtifact({
  snapshot, population, source_frames, exclusions, seed, format_quotas = DEFAULT_FORMAT_QUOTAS,
  disclosure_scan = null,
}) {
  const strata = dimension => Object.fromEntries([...new Set(population.map(row => row[dimension]))].sort()
    .map(value => [value, population.filter(row => row[dimension] === value).length]));
  const body = {
    schema: PAIRED_POPULATION_SCHEMA,
    purpose: 'fresh paired @8-control/@9-treatment semantic gate; source frames frozen before inference',
    snapshot,
    selection: {
      seed,
      one_window_per_file: true,
      requested_windows: Object.values(format_quotas).reduce((sum, value) => sum + value, 0),
      format_quotas,
      strata: {
        format: strata('format'), area: strata('area'), size: strata('size'),
        structure: strata('structure'), kind: strata('kind'),
      },
    },
    exclusions,
    disclosure_scan,
    window_ids: population.map(row => row.id).sort(),
    windows: population,
    source_frames,
    gold_status: 'pending_human_source_review',
    gold_opportunities: [],
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyPairedPopulationArtifact(artifact) {
  const { digest, ...body } = artifact || {};
  const actual = sha256(canonical(body));
  if (!digest || digest !== actual) throw new PairedPopulationError('POPULATION_DIGEST_MISMATCH', `expected ${digest}, got ${actual}`);
  if (new Set(artifact.window_ids || []).size !== 20) throw new PairedPopulationError('POPULATION_NOT_20_WINDOWS', 'paired gate requires exactly 20 unique windows');
  if (artifact.source_frames?.length !== 20) throw new PairedPopulationError('SOURCE_FRAMES_INCOMPLETE', 'each paired window requires a source-first frame');
  if (artifact.disclosure_scan && artifact.disclosure_scan.pass !== true) {
    throw new PairedPopulationError('DISCLOSURE_SCAN_FAILED', 'selected inference bytes contain credential signatures');
  }
  return true;
}

const SECRET_SIGNATURES = Object.freeze([
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['AWS_ACCESS_KEY', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GITHUB_TOKEN', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ['GITHUB_FINE_GRAINED_TOKEN', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['OPENAI_KEY', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['ANTHROPIC_KEY', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['SLACK_TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
]);

/** Scan only source bytes that would enter selected prompts; never echo a matched secret. */
export function scanPairedPopulationDisclosure({ population, inventories }) {
  const inventoryByFile = inventories instanceof Map ? inventories : new Map(inventories.map(row => [row.path, row]));
  const findings = [];
  for (const window of population) {
    const inventory = inventoryByFile.get(window.file);
    const allowed = new Set(window.primary_block_addresses);
    for (const block of inventory?.blocks || []) {
      if (!allowed.has(block.address)) continue;
      for (const [code, signature] of SECRET_SIGNATURES) {
        signature.lastIndex = 0;
        for (const match of block.text.matchAll(signature)) findings.push(Object.freeze({
          code, window_id: window.id, file: window.file, block_address: block.address,
          matched_bytes: Buffer.byteLength(match[0]), matched_digest: sha256(match[0]),
        }));
      }
    }
  }
  return Object.freeze({
    schema: 'estate-map/paired-disclosure-scan/v1',
    scanned_windows: population.length,
    pass: findings.length === 0,
    findings,
  });
}
