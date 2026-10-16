// Read-only, incremental telemetry over the append-only paid-inference checkpoint. It deliberately
// uses the extractor's real deterministic validator so the live histogram matches the final
// artifact instead of merely counting syntactically parseable model proposals.
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  buildMentionNamespace, buildWindowSubjectOccurrences, prepassDocument, renderMentionMenu,
  renderSubjectOccurrenceMenu,
} from './source-prepass.mjs';
import { createWindowBlockCatalog } from './source-locator.mjs';
import { segmentCorpus } from './wide-context-windows.mjs';
import {
  buildWindowPrompt, buildWindowPromptV8, buildWindowPromptV9, buildWindowPromptV12, buildWindowPromptV13, buildWindowPromptV14, buildWindowPromptV15, buildWindowPromptV16, buildWindowPromptV17, buildWindowPromptV18, buildWindowPromptV19, buildWindowPromptV20, claimBudgetForWindow,
  validateWindowResponse,
} from './wide-context-extractor.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { requireModel } from './neural-model-runner.mjs';

const canonical = value => stableStringify(value).trim();
const roundMoney = value => Number(Number(value || 0).toFixed(6));

export async function loadWideContextTelemetryContext({ manifestPath, boundsPath = null, estateRoot, contract = 'v10' }) {
  if (!['v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14', 'v15', 'v16', 'v17', 'v18', 'v19', 'v20', 'v21', 'v22', 'v23', 'v24', 'v25', 'v26', 'v28'].includes(contract)) throw new Error(`unsupported telemetry extraction contract ${contract}`);
  const contractGeneration = Number(contract.slice(1));
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
  const externalBounds = boundsPath ? JSON.parse(await fs.readFile(path.resolve(boundsPath), 'utf8')) : {};
  const bounds = { ...(manifest.bounds || {}), ...externalBounds };
  const root = await fs.realpath(path.resolve(estateRoot));
  const documents = [];
  for (const spec of manifest.documents || []) {
    documents.push({ path: spec.path, content: await fs.readFile(path.join(root, spec.path), 'utf8') });
  }
  const snapshot = {
    source_sha: manifest.source_sha,
    corpus_digest: sha256(canonical(documents.map(row => ({ path: row.path, digest: sha256(row.content) })))),
  };
  const prepasses = documents.map(row => prepassDocument({ path: row.path, content: row.content, ...snapshot }));
  const namespace = buildMentionNamespace(prepasses);
  const prepassByFile = new Map(prepasses.map(row => [row.file, row]));
  const segmented = segmentCorpus({
    documents, snapshot, window_bytes: bounds.window_bytes, overlap_bytes: bounds.overlap_bytes ?? null,
  });
  const model = requireModel(manifest.models?.extraction, 'manifest.models.extraction');
  const windows = new Map();
  for (const window of segmented.windows) {
    const prepass = prepassByFile.get(window.file);
    const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
    const maxClaims = claimBudgetForWindow(window, bounds);
    const subjectOccurrences = contract !== 'v8' ? buildWindowSubjectOccurrences({
      prepass, catalog, limit: bounds.mention_menu_limit ?? 120,
      prefer_maximal_identifiers: contractGeneration >= 12,
      strip_qualified_line_ranges: contractGeneration >= 13,
      strict_qualified_code_spans: contractGeneration >= 16,
    }) : [];
    const prompt = contract === 'v8'
      ? buildWindowPromptV8({
          window, catalog,
          mentionMenu: renderMentionMenu(prepass, { limit: bounds.mention_menu_limit ?? 120 }),
          max_claims: maxClaims,
        })
      : contract === 'v9' ? buildWindowPromptV9({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v12' ? buildWindowPromptV12({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v13' ? buildWindowPromptV13({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v14' ? buildWindowPromptV14({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v15' ? buildWindowPromptV15({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v16' ? buildWindowPromptV16({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v17' ? buildWindowPromptV17({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v18' ? buildWindowPromptV18({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contract === 'v19' ? buildWindowPromptV19({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : contractGeneration >= 20 ? buildWindowPromptV20({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        }) : buildWindowPrompt({
          window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
        });
    windows.set(window.id, {
      window, catalog, maxClaims,
      mentionByRef: contract === 'v8'
        ? new Map(prepass.mentions.map(mention => [mention.id.slice(0, 22), mention])) : new Map(),
      subjectOccurrenceByRef: new Map(subjectOccurrences.map(occurrence => [occurrence.ref, occurrence])),
      promptDigest: sha256(prompt),
    });
  }
  return Object.freeze({ root, manifest, bounds, snapshot, namespace, model, contract, windows, totals: segmented.totals });
}

function analyzeCompletion({ key, value, started, context }) {
  const tag = started?.value?.tag || null;
  const windowId = String(tag || '').replace(/^extract:/, '').replace(/#attempt=\d+$/, '');
  const result = value?.result;
  const base = { key, tag, window_id: windowId || null, promoted: 0, rejected: 0, repaired: 0, truncated: false, codes: [] };
  if (result?.outcome !== 'ok') {
    return { ...base, rejected: 1, codes: [`OUTCOME_${String(result?.outcome || 'MISSING').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] };
  }
  const held = context?.windows?.get(windowId);
  if (!held) return { ...base, rejected: 1, codes: ['TELEMETRY_WINDOW_NOT_FOUND'] };
  try {
    const contractGeneration = Number(context.contract.slice(1));
    const validation = validateWindowResponse({
      response: result, window: held.window, catalog: held.catalog, namespace: context.namespace,
      mentionByRef: held.mentionByRef, subjectOccurrenceByRef: held.subjectOccurrenceByRef,
      modelIdentifier: started?.value?.model || context.model,
      promptDigest: held.promptDigest, maxClaims: held.maxClaims,
      requireSubjectOccurrence: context.contract !== 'v8',
      recoverColocatedExplicit: contractGeneration >= 10,
      rejectOwnershipCollapse: contractGeneration >= 12,
      ignoreUnknownAdvisoryOccurrence: contractGeneration >= 13,
      preciseOwnershipCollapse: contractGeneration >= 13,
      rejectRoleOwnership: contractGeneration >= 14,
      preciseHeadingOwnership: contractGeneration >= 15,
      recoverExactUniqueLocators: contractGeneration >= 16,
      normalizeCatalogPrimaryRoles: contractGeneration >= 16,
      rejectIncompleteEvidenceFragments: contractGeneration >= 16,
      rejectRecoveredRoleOwnership: contractGeneration >= 17,
      rejectRecoveredSemanticCompleteness: contractGeneration >= 18,
      rejectRecoveredActiveHeadings: contractGeneration >= 19,
      rejectRecoveredCausativeHeadings: contractGeneration >= 20,
      recoverExactImplicitTopicQuotes: contractGeneration >= 22,
      rejectRecoveredImplicitTopicActors: contractGeneration >= 23,
      preserveDottedMemberIdentities: contractGeneration >= 24,
      preserveIndependentCommandWitnesses: contractGeneration >= 24,
      repairWhitespaceEquivalentLocators: context.contract === 'v28',
      preserveAuthoredSubjectSurfaces: context.contract === 'v28',
      useClaimV33: context.contract === 'v28',
      terminalIncompleteOnTruncation: context.contract === 'v28',
      terminalIncompleteOnOverflow: context.contract === 'v28',
    });
    if (!validation.ok) return { ...base, rejected: 1, codes: ['UNPARSEABLE_WINDOW'] };
    const completed = validation.value;
    return {
      ...base,
      promoted: completed.claims.length,
      rejected: completed.rejected.length,
      repaired: completed.wire_repairs?.length || 0,
      truncated: completed.truncated,
      codes: completed.rejected.map(row => row.reason || row.code || 'UNKNOWN'),
    };
  } catch {
    return { ...base, rejected: 1, codes: ['TELEMETRY_VALIDATION_ERROR'] };
  }
}

/** Incrementally follows complete JSONL records. A partial final line is held until the next read. */
export class CheckpointTelemetry {
  constructor({ context = null, maxKnownCostUsd = null } = {}) {
    this.context = context;
    this.maxKnownCostUsd = Number(maxKnownCostUsd ?? context?.bounds?.max_known_cost_usd ?? 0);
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.inode = null;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.header = null;
    this.started = new Map();
    this.completed = new Map();
    this.logicalStarted = new Map();
    this.materializations = new Map();
    this.retrySchedules = new Map();
    this.attemptAnalysis = new Map();
    this.materializedLedger = false;
    this.analysis = new Map();
    this.warnings = [];
  }

  ingestLine(line) {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); }
    catch (error) { this.warnings.push(`invalid complete JSONL record: ${error.message}`); return; }
    if (record.type === 'header') { this.header = record; return; }
    if (record.type !== 'entry' || !record.stage || !record.key) {
      this.warnings.push('checkpoint record missing type/stage/key');
      return;
    }
    const identity = `${record.stage}\u0000${record.key}`;
    if (String(record.stage).endsWith('-started')) {
      if (!this.started.has(record.key)) this.started.set(record.key, { identity, value: record.value });
      if (record.value?.materialization_id) {
        this.materializedLedger = true;
        const logicalKey = record.value.logical_key || record.key;
        if (!this.logicalStarted.has(logicalKey)) this.logicalStarted.set(logicalKey, record.value);
      }
      return;
    }
    if (String(record.stage).endsWith('-retry-scheduled')) {
      this.materializedLedger = true;
      if (!this.retrySchedules.has(record.key)) this.retrySchedules.set(record.key, record.value);
      return;
    }
    if (String(record.stage).endsWith('-materialization')) {
      this.materializedLedger = true;
      if (!this.materializations.has(record.key)) this.materializations.set(record.key, record.value);
      const attemptId = record.value?.selected_attempt_id || record.value?.terminal_attempt_id;
      if (attemptId && this.attemptAnalysis.has(attemptId)) this.analysis.set(record.key, this.attemptAnalysis.get(attemptId));
      return;
    }
    if (!String(record.stage).endsWith('-completion') || this.completed.has(record.key)) return;
    this.completed.set(record.key, { identity, value: record.value });
    const analyzed = analyzeCompletion({
      key: record.key, value: record.value, started: this.started.get(record.key), context: this.context,
    });
    if (record.value?.materialization_id) {
      this.materializedLedger = true;
      this.attemptAnalysis.set(record.key, analyzed);
    } else this.analysis.set(record.key, analyzed);
  }

  async refresh(file) {
    const absolute = path.resolve(file);
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) { if (error.code === 'ENOENT') return this.snapshot(); throw error; }
    if ((this.inode !== null && this.inode !== stat.ino) || stat.size < this.offset) this.reset();
    this.inode = stat.ino;
    if (stat.size === this.offset) return this.snapshot();
    const handle = await fs.open(absolute, 'r');
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (this.offset < stat.size) {
        const length = Math.min(chunk.length, stat.size - this.offset);
        const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.buffer += this.decoder.write(chunk.subarray(0, bytesRead));
        while (true) {
          const newline = this.buffer.indexOf('\n');
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).replace(/\r$/, '');
          this.buffer = this.buffer.slice(newline + 1);
          this.ingestLine(line);
        }
      }
    } finally { await handle.close(); }
    return this.snapshot();
  }

  snapshot({ running = false, plannedUnits = null } = {}) {
    let knownCost = 0, accountedCalls = 0, recordedUnpriced = 0;
    for (const row of this.completed.values()) {
      const stats = row.value?.model_stats || {};
      knownCost += Number(stats.cost || 0);
      accountedCalls += Math.max(1, Number(stats.calls || 0));
      recordedUnpriced += Number(stats.unpriced_attempts || 0);
    }
    const unmatched = [...this.started.keys()].filter(key => !this.completed.has(key));
    const logicalUnfinished = [...this.logicalStarted.keys()].filter(key => !this.materializations.has(key));
    const rejectionCounts = {};
    const claimCounts = {};
    let promoted = 0, rejected = 0, repaired = 0, truncated = 0;
    for (const row of this.analysis.values()) {
      promoted += row.promoted;
      rejected += row.rejected;
      repaired += row.repaired;
      if (row.truncated) truncated += 1;
      if (row.window_id) claimCounts[row.window_id] = row.promoted;
      for (const code of row.codes) rejectionCounts[code] = (rejectionCounts[code] || 0) + 1;
    }
    const cost = roundMoney(knownCost);
    const cap = this.maxKnownCostUsd > 0 ? this.maxKnownCostUsd : null;
    return Object.freeze({
      checkpoint_present: Boolean(this.header),
      fingerprint: this.header?.fingerprint || null,
      units: {
        planned: plannedUnits,
        started: this.materializedLedger ? this.logicalStarted.size : this.started.size,
        completed: this.materializedLedger ? this.materializations.size : this.completed.size,
        in_flight: running ? (this.materializedLedger ? logicalUnfinished.length : unmatched.length) : 0,
        orphaned_started: running ? 0 : unmatched.length,
      },
      attempts: {
        started: this.started.size,
        completed: this.completed.size,
        in_flight: running ? unmatched.length : 0,
        retry_schedules: this.retrySchedules.size,
        recovered: [...this.materializations.values()].filter(row => row.status === 'selected' && Number(row.selected_attempt) > 1).length,
        terminal_incomplete: [...this.materializations.values()].filter(row => row.status === 'terminal_incomplete').length,
      },
      budget: {
        accounted_calls: accountedCalls,
        known_cost_usd: cost,
        unpriced_attempts: recordedUnpriced + (running ? 0 : unmatched.length),
        recorded_unpriced_attempts: recordedUnpriced,
        max_known_cost_usd: cap,
        cap_remaining_usd: cap === null ? null : roundMoney(Math.max(0, cap - cost)),
        cost_status: recordedUnpriced || (!running && unmatched.length) ? 'lower_bound' : 'complete',
      },
      claims: {
        promoted,
        rejected,
        wire_repaired_lines: repaired,
        promotion_rate: promoted + rejected ? Number((promoted / (promoted + rejected)).toFixed(4)) : null,
        truncated_units: truncated,
        by_window: Object.fromEntries(Object.entries(claimCounts).sort((a, b) => a[0].localeCompare(b[0]))),
        rejection_codes: Object.entries(rejectionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      },
      warnings: this.warnings.slice(),
    });
  }
}
