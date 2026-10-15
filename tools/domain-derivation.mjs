#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';
import { REFUSAL_SCHEMA, readRefusalLedger, validateRefusal } from './annotate.mjs';
import {
  DEFAULT_CANON_RELATIVE,
  DEFAULT_GENERATED_AT,
  DEFAULT_WITNESS,
  DOC_DERIVED_KIND,
  buildDddOverlays,
  parseDddMapping,
} from './ddd-overlays.mjs';

const HELP = `Usage:
  node tools/estate-map/domain-derivation.mjs <estate-graph.json> <out.jsonl> [options]

Options:
  --canon <path>        canon document (default: <repo>/design/canon/ddd-mapping.md)
  --witness-repo <id>   repo name used in canon witnesses (default: design)
  --witness-file <path> file path used in canon witnesses (default: canon/ddd-mapping.md)
  --component <repo>    graph repo/component holding plugin modules (default: plugins)
  --generated-at <iso>  overlay timestamp (default: fixed constant, keeps output byte-stable)
  --census <path>       also write the machine-readable census JSON here
  --refusals <path>     write the refusal ledger here (name it *.refusals.jsonl so
                        "annotate.mjs merge" picks it up into graph.refusals)
  --prior-refusals <p>  previous ledger; refusals whose subject is now DERIVED transition
                        to superseded_by_derivation instead of disappearing

Derives domain membership from graph structure, seeded from the canon DDD
assignments. Emits one service_card overlay per DERIVED assignment (the canon
assignments themselves remain ddd-overlays.mjs's output), one refusal record per
REFUSED node, and prints a census of assignments and refusals grouped by reason.`;

export const PRODUCER_PREFIX = 'deterministic/domain-derivation@1';
export const RULES = Object.freeze({
  // R0 is not a derivation rule; it is the coverage sweep that records the node kinds no
  // rule addresses. Naming it makes "nobody wrote a rule for this" a queryable decision
  // rather than silence.
  R0: 'R0-node-kind-coverage',
  R1: 'R1-manifest-publication',
  R2: 'R2-import-neighbourhood',
});
// One shared neighbour is not evidence of membership. Two distinct documented
// neighbours in the SAME domain, and none in any other, is the bar.
export const MIN_DOMAINED_IMPORTS = 2;

// `<plugin>/plugin.yaml` relative to the `plugins` component root.
const MANIFEST_PATH = /^([A-Za-z0-9._-]+)\/plugin\.ya?ml$/;

const witnessKey = witness => `${witness.repo}\0${witness.file}\0${witness.line}`;
const sortWitnesses = witnesses => {
  const seen = new Map();
  for (const witness of witnesses) if (!seen.has(witnessKey(witness))) seen.set(witnessKey(witness), witness);
  return [...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
};

/**
 * Recover the plugin that DECLARES this manifest envelope-flow edge.
 * merge.mjs attaches manifest edges to the `repo:` node, so `edge.from` is
 * useless here; the witness path is the only thing that names the plugin, and
 * it is also the line a reader opens to check the claim.
 */
export function declaringPlugin(edge, component) {
  for (const witness of edge.witnesses || []) {
    if (witness.repo !== component) continue;
    const match = MANIFEST_PATH.exec(witness.file);
    if (match) return { plugin: match[1], witness };
  }
  return null;
}

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/**
 * The refusal's identity. A subject can be refused by more than one rule for more than one
 * reason, so the key is the triple, not the node. Stable and human-readable on purpose: the
 * id is what a later adjudication process cites, and DESIGN.md §2.5 requires it to survive
 * regeneration unchanged.
 */
export const refusalId = (rule, reason, subject) => `refusal:${rule}:${reason}:${subject}`;

/**
 * Reconcile a previous refusal ledger against this run's refusals — the §2.5 state machine.
 *
 *   still refused        -> state `refused`, `first_observed_at` carried over from the prior
 *                           record so the age of the standing question is not reset
 *   gone, now derived    -> state `superseded_by_derivation` + `resolution.kind: 'derived'`
 *                           naming the rule and domain that resolved it. The record STAYS.
 *   gone, refused under  -> state `withdrawn` + `resolution.kind: 'refused_for_different_reason'`.
 *   another reason          The RULE moved, not the subject; a fresh record carries the new reason.
 *   gone entirely        -> state `withdrawn` + `resolution.kind: 'no_longer_refused'` (canon now
 *                           seeds the subject, or the subject left the corpus). Also kept: a
 *                           dropped row records nothing, which is the failure §2.5 forbids.
 *
 * Idempotent by construction: every output field is a function of (prior, current, derived)
 * alone — no wall clock, no counters — so feeding a run's own output back in as `prior`
 * reproduces it byte-for-byte.
 */
export function reconcileRefusals(priorRecords, currentRecords, derivedBySubject, generatedAt) {
  const prior = new Map((priorRecords || []).map(record => [record.id, record]));
  const refusedNow = new Map();
  for (const record of currentRecords) {
    const list = refusedNow.get(record.subject) || [];
    list.push(record.reason_detail ? `${record.reason}:${record.reason_detail}` : record.reason);
    refusedNow.set(record.subject, list);
  }
  const out = new Map();
  for (const record of currentRecords) {
    const previous = prior.get(record.id);
    out.set(record.id, {
      ...record,
      first_observed_at: previous ? previous.first_observed_at : generatedAt,
      last_observed_at: generatedAt,
      state: 'refused',
      resolution: null,
    });
  }
  for (const [id, record] of prior) {
    if (out.has(id)) continue;
    const derived = derivedBySubject.get(record.subject);
    if (derived) {
      out.set(id, {
        ...record,
        state: 'superseded_by_derivation',
        resolution: {
          kind: 'derived',
          rule: derived.rule,
          domain: derived.domain,
          note: `Refused by ${record.rule} as ${record.reason}; later derived into "${derived.domain}" by ${derived.rule}. The refusal is retained: DESIGN.md §2.5 reconciliation transitions records, it does not delete them.`,
        },
      });
      continue;
    }
    const otherReasons = refusedNow.get(record.subject);
    out.set(id, otherReasons
      ? {
        ...record,
        state: 'withdrawn',
        resolution: {
          kind: 'refused_for_different_reason',
          rule: record.rule,
          domain: null,
          note: `No longer refused as ${record.reason}; this subject is now refused as ${otherReasons.sort().join(', ')}. The rule's verdict moved, not the subject — both records are kept so the change of reason is itself visible.`,
        },
      }
      : {
        ...record,
        state: 'withdrawn',
        resolution: {
          kind: 'no_longer_refused',
          rule: null,
          domain: null,
          note: `Neither refused nor derived on this graph: canon now assigns this subject a domain directly (it became a seed), or the subject left the corpus. Retained rather than dropped so the record of the refusal survives.`,
        },
      });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Census over a refusal ledger. Same shape whether the ledger came from memory or a file. */
export function summarizeRefusals(records) {
  const byReason = new Map(), byState = new Map(), byRule = new Map(), byShape = new Map(), examples = new Map();
  for (const record of records) {
    bump(byState, record.state);
    bump(byRule, record.rule);
    if (record.state !== 'refused') continue; // the census is of STANDING refusals
    const key = record.reason_detail && record.reason === 'no_applicable_rule_for_node_kind' ? `${record.reason}:${record.reason_detail}` : record.reason;
    bump(byReason, key);
    bump(byShape, record.evidence.shape);
    const list = examples.get(key) || [];
    if (list.length < 5) { list.push(record.subject); examples.set(key, list); }
  }
  const rows = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    total_records: records.length,
    standing_refusals: [...byState].filter(([state]) => state === 'refused').reduce((sum, [, count]) => sum + count, 0),
    by_reason: rows(byReason).map(([reason, count]) => ({ reason, count, examples: examples.get(reason) || [] })),
    by_state: rows(byState).map(([state, count]) => ({ state, count })),
    by_rule: rows(byRule).map(([rule, count]) => ({ rule, count })),
    by_evidence_shape: rows(byShape).map(([shape, count]) => ({ shape, count })),
  };
}

/**
 * Derive domain assignments. Pure, deterministic, order-independent: the result
 * depends only on the graph contents and the parsed canon, never on iteration
 * order or wall-clock time.
 */
export function deriveDomains(graph, seedResult, parsed, options = {}) {
  const component = options.component || 'plugins';
  const witnessRepo = options.witnessRepo || DEFAULT_WITNESS.repo;
  const witnessFile = options.witnessFile || DEFAULT_WITNESS.file;
  const generatedAt = options.generatedAt || DEFAULT_GENERATED_AT;
  const minImports = options.minDomainedImports ?? MIN_DOMAINED_IMPORTS;

  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const nodeById = new Map(nodes.map(node => [node.id, node]));

  // Seeds: the canon assignments, exactly as ddd-overlays.mjs emits them. Only
  // DOCUMENTED domains ever propagate, so no new cluster label is invented.
  const seedDomain = new Map(seedResult.records.map(record => [record.subject, record.body.domain]));
  const canonDomains = new Set(parsed.contexts.map(context => context.domain));
  // Only DOCUMENTED domains may propagate. A seed carrying a label canon does not
  // contain would be laundered into a derived assignment and shown as if it were a
  // canon domain, which is exactly the failure AC-SEEDED forbids.
  const seedInvented = [...new Set(seedDomain.values())].filter(domain => !canonDomains.has(domain)).sort();
  if (seedInvented.length) {
    throw new Error(`domain derivation invented ${seedInvented.length} non-canon domain label(s): ${seedInvented.join(', ')}. Only documented domains may propagate.`);
  }
  const canonWitness = new Map(parsed.contexts.map(context => [context.domain, { repo: witnessRepo, file: witnessFile, line: context.line }]));
  const pluginDomain = new Map(parsed.contexts.map(context => [context.plugin, context.domain]));

  const records = [];
  const refusalRecords = [];
  const refusals = new Map(); // census reason string -> count
  const refusalExamples = new Map(); // census reason string -> [subject]
  /**
   * Record a refusal. `evidence.witnesses` carries ONLY witnesses the rule really examined;
   * `evidence.not_found` carries the absence-shaped part in its own field with an explicit
   * limitation, so no `file:line` is ever fabricated for a claim about absence.
   */
  const refuse = (rule, reason, node, { detail = null, witnesses = [], examined = [], notFound = null } = {}) => {
    const censusReason = reason === 'no_applicable_rule_for_node_kind' ? `${reason}:${detail}` : reason;
    bump(refusals, censusReason);
    const list = refusalExamples.get(censusReason) || [];
    if (list.length < 5) { list.push(node.id); refusalExamples.set(censusReason, list); }
    const sorted = sortWitnesses(witnesses);
    refusalRecords.push({
      schema: REFUSAL_SCHEMA,
      id: refusalId(rule, reason, node.id),
      subject: node.id,
      subject_kind: node.kind || 'evidence',
      producer: PRODUCER_PREFIX,
      rule,
      reason,
      reason_detail: detail,
      state: 'refused',
      evidence: {
        shape: sorted.length && notFound ? 'mixed' : sorted.length ? 'witnessed' : 'absence',
        witnesses: sorted,
        examined,
        not_found: notFound,
      },
      first_observed_at: generatedAt,
      last_observed_at: generatedAt,
      resolution: null,
    });
  };
  const ABSENCE_LIMITATION = 'Absence-shaped claim: no single {repo,file,line} can exhibit the non-existence of a relation, so this refusal carries NO witness rather than a fabricated one. Per DESIGN.md §2.5.1 an extractor may only say "I did not find it", never "it is not there".';
  const CANON_GAP_LIMITATION = 'The manifest witnesses below are real and demonstrative; the MISSING canon row is not witnessable, because a row that does not exist has no line number. Stated here rather than fabricated.';

  const emit = (subject, domain, rule, groundedIn, keyFlows, risks, summary) => {
    records.push({
      annotation_kind: 'service_card',
      subject,
      kind: DOC_DERIVED_KIND,
      model: `${PRODUCER_PREFIX}:${rule}`,
      confidence: 1,
      generated_at: generatedAt,
      grounded_in: sortWitnesses(groundedIn),
      body: { domain, key_flows: keyFlows, risks, summary },
    });
  };

  // ---- R1: envelope kinds owned by the plugin whose manifest declares them ----
  const manifestEmits = new Map(); // envelope kind node id -> [{plugin, witness}]
  for (const edge of edges) {
    if (edge.kind !== 'emits' || edge.idiom !== 'manifest_publishes') continue;
    const found = declaringPlugin(edge, component);
    if (!found) continue;
    if (!manifestEmits.has(edge.to)) manifestEmits.set(edge.to, []);
    manifestEmits.get(edge.to).push(found);
  }

  for (const node of nodes) {
    if (node.kind !== 'envelope_kind' || seedDomain.has(node.id)) continue;
    const declarations = (manifestEmits.get(node.id) || []).slice().sort(
      (a, b) => a.plugin.localeCompare(b.plugin) || a.witness.file.localeCompare(b.witness.file) || a.witness.line - b.witness.line,
    );
    const declarationWitness = entry => ({ repo: component, file: entry.witness.file, line: entry.witness.line });
    const declarationExamined = entry => ({
      relation: 'manifest_publishes',
      target: `plugin:${entry.plugin}`,
      value: pluginDomain.get(entry.plugin) || '(no documented bounded context)',
      witness: declarationWitness(entry),
    });
    if (!declarations.length) {
      refuse(RULES.R1, 'no_manifest_publisher', node, {
        notFound: {
          sought: 'a `publishes_envelopes:` declaration naming this envelope kind in any <plugin>/plugin.yaml manifest',
          over: `all ${manifestEmits.size} envelope kind(s) reached by a manifest_publishes edge in this graph`,
          limitation: ABSENCE_LIMITATION,
        },
      });
      continue;
    }
    const documented = declarations.filter(entry => pluginDomain.has(entry.plugin));
    const canonGap = plugins => ({
      sought: `a row assigning a bounded context to plugin(s) ${plugins.join(', ')} in the canon §1.1 table`,
      over: `the ${parsed.contexts.length} bounded context row(s) parsed from ${witnessFile}`,
      limitation: CANON_GAP_LIMITATION,
    });
    if (!documented.length) {
      refuse(RULES.R1, 'declaring_plugin_has_no_documented_domain', node, {
        detail: [...new Set(declarations.map(entry => entry.plugin))].sort().join(', '),
        witnesses: declarations.map(declarationWitness),
        examined: declarations.map(declarationExamined),
        notFound: canonGap([...new Set(declarations.map(entry => entry.plugin))].sort()),
      });
      continue;
    }
    if (documented.length !== declarations.length) {
      const undocumented = [...new Set(declarations.filter(entry => !pluginDomain.has(entry.plugin)).map(entry => entry.plugin))].sort();
      refuse(RULES.R1, 'publisher_set_mixes_documented_and_undocumented_plugins', node, {
        detail: `documented: ${[...new Set(documented.map(entry => entry.plugin))].sort().join(', ')}; undocumented: ${undocumented.join(', ')}`,
        witnesses: declarations.map(declarationWitness),
        examined: declarations.map(declarationExamined),
        notFound: canonGap(undocumented),
      });
      continue;
    }
    const domains = new Set(documented.map(entry => pluginDomain.get(entry.plugin)));
    if (domains.size !== 1) {
      refuse(RULES.R1, 'publisher_domain_conflict', node, {
        detail: [...domains].sort().join(' | '),
        witnesses: documented.map(declarationWitness),
        examined: documented.map(declarationExamined),
      });
      continue;
    }
    const domain = [...domains][0];
    emit(
      node.id,
      domain,
      RULES.R1,
      [canonWitness.get(domain), ...documented.map(entry => ({ repo: component, file: entry.witness.file, line: entry.witness.line }))],
      documented.map(entry => `declared under publishes_envelopes: in ${component}/${entry.witness.file}:${entry.witness.line} (plugin ${entry.plugin})`),
      [
        'Derived, not documented: canon assigns the PLUGIN a bounded context; canon does not name this envelope kind.',
        'Positive declarations only. This is not an exclusivity claim: other emitters may exist that the extractor does not witness.',
      ],
      `${RULES.R1}: envelope kind "${node.name}" is DECLARED in the publishes_envelopes: block of ${documented.map(entry => entry.plugin).join(', ')}, whose documented bounded context is "${domain}".`,
    );
  }

  // ---- R2: modules whose documented import neighbourhood is unanimous ----
  const importTargets = new Map(); // module id -> Map(target id -> witness)
  const resolvedImportCount = new Map(); // module id -> resolved imports edges out of it (documented or not)
  for (const edge of edges) {
    if (edge.kind !== 'imports' || edge.status !== 'resolved') continue;
    bump(resolvedImportCount, edge.from);
    if (!seedDomain.has(edge.to)) continue;
    if (!importTargets.has(edge.from)) importTargets.set(edge.from, new Map());
    const targets = importTargets.get(edge.from);
    const witness = (edge.witnesses || []).find(entry => entry.file && Number.isInteger(entry.line));
    if (!witness) continue;
    const existing = targets.get(edge.to);
    // Deterministic pick: the earliest witness for that target.
    if (!existing || witness.file < existing.file || (witness.file === existing.file && witness.line < existing.line)) targets.set(edge.to, witness);
  }

  for (const node of nodes) {
    if (node.kind !== 'module' || seedDomain.has(node.id)) continue;
    const targets = [...(importTargets.get(node.id) || new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const importExamined = ([id, witness]) => ({
      relation: 'imports',
      target: id,
      value: seedDomain.get(id),
      witness: { repo: witness.repo, file: witness.file, line: witness.line },
    });
    if (!targets.length) {
      refuse(RULES.R2, 'no_documented_import_neighbour', node, {
        notFound: {
          sought: 'a resolved `imports` edge from this module to a module carrying a documented domain',
          over: `the ${resolvedImportCount.get(node.id) || 0} resolved imports edge(s) out of this module`,
          limitation: ABSENCE_LIMITATION,
        },
      });
      continue;
    }
    const domains = new Set(targets.map(([id]) => seedDomain.get(id)));
    if (domains.size !== 1) {
      refuse(RULES.R2, 'import_neighbourhood_domain_conflict', node, {
        detail: [...domains].sort().join(' | '),
        witnesses: targets.map(([, witness]) => ({ repo: witness.repo, file: witness.file, line: witness.line })),
        examined: targets.map(importExamined),
      });
      continue;
    }
    if (targets.length < minImports) {
      refuse(RULES.R2, 'single_documented_import_neighbour_below_threshold', node, {
        detail: [...domains][0],
        witnesses: targets.map(([, witness]) => ({ repo: witness.repo, file: witness.file, line: witness.line })),
        examined: targets.map(importExamined),
        notFound: {
          sought: `a ${minImports}${minImports === 2 ? 'nd' : 'th'} DISTINCT documented import neighbour (any domain) — the threshold that separates membership from a single shared dependency`,
          over: `the ${resolvedImportCount.get(node.id) || 0} resolved imports edge(s) out of this module, of which ${targets.length} reach a documented module`,
          limitation: 'Partly absence-shaped: the neighbour(s) below are real and witnessed; the neighbour that would have met the threshold does not exist and therefore has no line.',
        },
      });
      continue;
    }
    const domain = [...domains][0];
    emit(
      node.id,
      domain,
      RULES.R2,
      [canonWitness.get(domain), ...targets.map(([, witness]) => ({ repo: witness.repo, file: witness.file, line: witness.line }))],
      targets.map(([id, witness]) => `imports ${nodeById.get(id)?.name ?? id} at ${witness.repo}/${witness.file}:${witness.line}`),
      [
        'Derived, not documented: canon does not assign this module; the assignment is a projection over its import neighbourhood.',
        `Structural, not demonstrative: no single line exhibits membership. Evidence is ${targets.length} distinct documented import target(s), all in "${domain}", and none in any other documented domain.`,
      ],
      `${RULES.R2}: every documented module this module imports (${targets.length} distinct, threshold ${minImports}) belongs to "${domain}".`,
    );
  }

  // ---- Node kinds no rule addresses ----
  for (const node of nodes) {
    if (node.kind === 'module' || node.kind === 'envelope_kind' || seedDomain.has(node.id)) continue;
    refuse(RULES.R0, 'no_applicable_rule_for_node_kind', node, {
      detail: String(node.kind || 'evidence'),
      notFound: {
        sought: `a derivation rule addressing node kind "${node.kind}"`,
        over: `the shipped rule set (${RULES.R1}, ${RULES.R2})`,
        limitation: 'This absence is in the TOOL, not in the corpus: no rule was written for this node kind. Recorded so the gap is queryable rather than invisible; it carries no witness because there is nothing in the estate to point at.',
      },
    });
  }

  records.sort((a, b) => a.subject.localeCompare(b.subject) || a.model.localeCompare(b.model));

  const derivedDomains = new Set(records.map(record => record.body.domain));
  const invented = [...derivedDomains].filter(domain => !canonDomains.has(domain));
  if (invented.length) {
    // Structurally unreachable (only seed domains propagate); a guard, not a branch
    // we expect to take. Inventing a label would be exactly the failure this tool
    // is built to avoid, so it fails loudly rather than shipping the label.
    throw new Error(`domain derivation invented ${invented.length} non-canon domain label(s): ${invented.join(', ')}. Only documented domains may propagate.`);
  }

  const byRule = new Map();
  const byDomain = new Map();
  for (const record of records) { bump(byRule, record.model.split(':').pop()); bump(byDomain, record.body.domain); }

  refusalRecords.sort((a, b) => a.id.localeCompare(b.id));
  const derivedBySubject = new Map(records.map(record => [record.subject, { rule: record.model.split(':').pop(), domain: record.body.domain }]));
  const ledger = reconcileRefusals(options.priorRefusals || [], refusalRecords, derivedBySubject, generatedAt);
  for (const record of ledger) validateRefusal(record, `refusal ${record.id}`);

  const totalNodes = nodes.length;
  const seeded = seedDomain.size;
  const census = {
    total_nodes: totalNodes,
    documented_assignments: seeded,
    derived_assignments: records.length,
    undomained_before: totalNodes - seeded,
    undomained_after: totalNodes - seeded - records.length,
    derived_by_rule: [...byRule].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => ({ rule, count })),
    derived_by_domain: [...byDomain].sort((a, b) => a[0].localeCompare(b[0])).map(([domain, count]) => ({ domain, count })),
    refusals: [...refusals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, count]) => ({ reason, count, examples: refusalExamples.get(reason) || [] })),
    refused_total: [...refusals.values()].reduce((sum, count) => sum + count, 0),
    invented_domain_labels: invented,
    refusal_ledger: summarizeRefusals(ledger),
  };
  return { records, census, refusals: ledger };
}

const writeJsonl = async (file, records) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
};

export async function produceDomainDerivation(graphPath, outPath, options = {}) {
  const canonPath = options.canonPath || path.resolve(fileURLToPath(new URL('../../', import.meta.url)), DEFAULT_CANON_RELATIVE);
  const parsed = parseDddMapping(await fs.readFile(canonPath, 'utf8'));
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const seedResult = buildDddOverlays(graph, parsed, options);
  // A prior ledger is what makes regeneration non-destructive: without it every run starts
  // from nothing and a refusal that became a derivation would simply vanish.
  let priorRefusals = options.priorRefusals || [];
  if (options.priorRefusalsPath) {
    try { priorRefusals = await readRefusalLedger(options.priorRefusalsPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const result = deriveDomains(graph, seedResult, parsed, { ...options, priorRefusals });
  await writeJsonl(outPath, result.records);
  if (options.refusalsPath) await writeJsonl(options.refusalsPath, result.refusals);
  if (options.censusPath) {
    await fs.mkdir(path.dirname(options.censusPath), { recursive: true });
    await fs.writeFile(options.censusPath, JSON.stringify(result.census, null, 2) + '\n', 'utf8');
  }
  return { ...result, canonPath, outPath, parsed, seedResult, priorRefusals };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length < 2) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await produceDomainDerivation(path.resolve(positional[0]), path.resolve(positional[1]), {
      canonPath: options.canon ? path.resolve(options.canon) : undefined,
      witnessRepo: options['witness-repo'],
      witnessFile: options['witness-file'],
      component: options.component,
      generatedAt: options['generated-at'],
      censusPath: options.census ? path.resolve(options.census) : undefined,
      refusalsPath: options.refusals ? path.resolve(options.refusals) : undefined,
      priorRefusalsPath: options['prior-refusals'] ? path.resolve(options['prior-refusals']) : undefined,
    });
    const census = result.census;
    console.log(`Seeded from ${census.documented_assignments} documented assignment(s) in ${result.canonPath}`);
    console.log(`Wrote ${result.records.length} derived overlay record(s) to ${result.outPath}`);
    console.log(`Undomained: ${census.undomained_before} -> ${census.undomained_after} of ${census.total_nodes} node(s)`);
    console.log('Derived by rule:');
    for (const entry of census.derived_by_rule) console.log(`  ${String(entry.count).padStart(5)}\t${entry.rule}`);
    console.log('Derived by domain:');
    for (const entry of census.derived_by_domain) console.log(`  ${String(entry.count).padStart(5)}\t${entry.domain}`);
    console.log(`Refused (left undomained on purpose), ${census.refused_total} node(s):`);
    for (const entry of census.refusals) console.log(`  ${String(entry.count).padStart(5)}\t${entry.reason}`);
    console.log(`Refusal ledger: ${census.refusal_ledger.total_records} durable record(s)${result.outPath && options.refusals ? ` written to ${path.resolve(options.refusals)}` : ' (not written; pass --refusals <path>)'}`);
    for (const entry of census.refusal_ledger.by_state) console.log(`  ${String(entry.count).padStart(5)}\t${entry.state}`);
    console.log('Refusal evidence shape:');
    for (const entry of census.refusal_ledger.by_evidence_shape) console.log(`  ${String(entry.count).padStart(5)}\t${entry.shape}`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
