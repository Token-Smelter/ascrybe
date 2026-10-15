#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import {
  STRUCTURAL_UNCLASSIFIED_SCHEMA,
  validateAnnotation,
  validateStructuralUnclassified,
} from './annotate.mjs';
import { parseArgs } from './lib.mjs';

const HELP = `Usage:
  node tools/estate-map/structural-grouping.mjs <graph.json> <out.jsonl> [options]
Options:
  --unclassified <path>  ledger for nodes no rule covers (default: <out>.structural-unclassified.jsonl)
  --census <path>        write the group census as JSON
  --generated-at <iso>   fixed annotation timestamp for repeatable output
  --json                 print the census to stdout as JSON
Derive one structural group per node from component membership, directory position and node
kind. Emits doc_derived_annotation overlays (annotation_kind structural_group) plus an
explicit unclassified ledger. Deterministic: no model calls, no network.`;

export const STRUCTURAL_PRODUCER = 'deterministic/structural-grouping@1';
export const STRUCTURAL_ANNOTATION_KIND = 'structural_group';
/** The label the VIEW uses for nodes carrying an unclassified record. Not assignable. */
export const UNCLASSIFIED_GROUP = 'unclassified';

// Preserve source witnesses; do not infer authority from naming conventions alone.
export const STRUCTURAL_GROUPS = Object.freeze([
  'client-ui',           // browser-side source
  'server-core',         // the dashboard's own non-client source roots
  'plugins-runtime',     // plugin implementations
  'test-suite',          // test and fixture trees
  'scripts-tooling',     // operational scripts and developer tools
  'docs',                // documentation trees and markdown
  'companions',          // companion agent/MCP assets shipped beside the product
  'infra-declarations',  // terraform / environment / config / sql declaration nodes
  'envelope-contracts',  // envelope kinds declared in plugin manifests
  'capability-contracts',// capability types registered on the capability registry
  'external-packages',   // third-party dependency nodes from manifests
  'component-inventory', // per-component bookkeeping nodes (repo / service / coverage)
  'http-surface',        // route nodes
]);

// KIND RULES run FIRST, and the ordering is a deliberate honesty choice. A non-module node
// (an envelope kind, a package, a terraform resource) has no path of its OWN: the only path
// it carries is the path of the file that DECLARES it. Positioning such a node by its
// declaring file would say "231 envelope kinds live in plugins-runtime", which hides that
// they are contract nodes rather than plugin source. So node kind wins for these, and the
// declaring position is preserved in the `basis` string instead of being thrown away.
const KIND_RULES = Object.freeze([
  { rule: 'S1-envelope-declaration', group: 'envelope-contracts', kinds: ['envelope_kind'] },
  { rule: 'S2-dependency-manifest', group: 'external-packages', kinds: ['package', 'external_internal_package', 'swift_framework'] },
  { rule: 'S3-component-inventory', group: 'component-inventory', kinds: ['repo', 'service', 'coverage'] },
  { rule: 'S4-infra-declaration', group: 'infra-declarations', kinds: ['tf_resource', 'tf_module', 'environment', 'config_key', 'sql_object'] },
  { rule: 'S5-http-surface', group: 'http-surface', kinds: ['route'] },
  // A capability type has no path of its own for the same reason an envelope
  // kind does not: the only path it carries belongs to the file that REGISTERS
  // it. Positioning it by that file would report the estate's inter-plugin
  // contracts as plugin source. Landed with instrument fix J1.
  { rule: 'S10-capability-contract', group: 'capability-contracts', kinds: ['capability'] },
]);
const KIND_RULE_BY_KIND = new Map(KIND_RULES.flatMap(rule => rule.kinds.map(kind => [kind, rule])));

// A path segment or filename that makes a file part of a test tree. Checked BEFORE component
// mapping, because a test tree nested inside a source component (client/e2e, client/src with
// a .test.ts suffix, test/fixtures) is a test tree wherever it sits.
const TEST_SEGMENTS = new Set(['test', 'tests', 'e2e', '__tests__', 'fixtures', 'testdata']);
const TEST_FILENAME = /\.(?:test|spec)\.[A-Za-z0-9]+$/;

// Within-component path rules: a component whose subtrees belong to different groups. Only
// `client` needs one today (client/src is UI source, client/scripts is tooling, client/e2e is
// caught earlier by the test rule), and the table exists so the next such split is data.
const COMPONENT_PATH_RULES = Object.freeze({
  client: [{ segment: 'src', group: 'client-ui' }, { segment: 'scripts', group: 'scripts-tooling' }],
});

// COMPONENT MAPPING — the last positive rule. The EVIDENCE is the component's own directory
// name, which is why every entry below is a name-to-layout mapping and none of them is a
// claim about behaviour. Components absent from this table are NOT swept anywhere: they get
// an explicit unclassified record naming the component that was examined.
const COMPONENT_GROUPS = Object.freeze({
  client: 'client-ui',
  public: 'client-ui',
  src: 'server-core',
  shared: 'server-core',
  schemas: 'server-core',
  config: 'server-core',
  extensions: 'server-core',
  plugins: 'plugins-runtime',
  test: 'test-suite',
  'test-fixtures': 'test-suite',
  scripts: 'scripts-tooling',
  tools: 'scripts-tooling',
  '.githooks': 'scripts-tooling',
  docs: 'docs',
  design: 'docs',
  companions: 'companions',
  mcp: 'companions',
  '.pi': 'companions',
  containers: 'infra-declarations',
});

const cite = witness => `${witness.repo}/${witness.file}:${witness.line}`;
/**
 * The node's OWN position: its first witness in deterministic order. Every witness is a real
 * {repo,file,line} the extractor observed, so the annotation's `grounded_in` is the file that
 * literally exhibits the directory position the rule fired on — never a synthesised citation.
 */
export function positionOf(node) {
  const witnesses = (Array.isArray(node?.witnesses) ? node.witnesses : [])
    .filter(witness => witness && typeof witness.repo === 'string' && typeof witness.file === 'string' && Number.isInteger(witness.line))
    .slice()
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
  return witnesses[0] || null;
}
const segmentsOf = file => String(file || '').split('/').filter(segment => segment && segment !== '.');
function isTestPosition(component, file) {
  const segments = segmentsOf(file);
  if (segments.some(segment => TEST_SEGMENTS.has(segment))) return `path segment in {${[...TEST_SEGMENTS].sort().join(', ')}}`;
  if (TEST_FILENAME.test(segments[segments.length - 1] || '')) return 'filename matches *.test.* / *.spec.*';
  if (COMPONENT_GROUPS[component] === 'test-suite') return `component ${component} is a test root`;
  return null;
}

/**
 * Classify ONE node. Returns `{group, rule, basis}` when a rule fires, or
 * `{reason, reason_detail, rule, examined}` when none does. Pure: no I/O, no clock.
 */
export function classifyNode(node) {
  const kind = String(node?.kind || '');
  const component = String(node?.repo || '');
  const position = positionOf(node);
  const kindRule = KIND_RULE_BY_KIND.get(kind);
  if (kindRule) {
    const where = position ? ` · declared at ${cite(position)}` : '';
    return { group: kindRule.group, rule: kindRule.rule, basis: `node kind ${kind}${where}` };
  }
  if (!position) {
    return {
      reason: 'no_witness_to_position_the_node',
      reason_detail: `node kind ${kind || 'unknown'} carries no witness, so no directory position exists to group it by, and no kind rule covers the kind`,
      rule: 'S9-unclassified',
      examined: [
        { relation: 'node_kind', target: kind || 'unknown', value: 'no kind rule matched' },
        { relation: 'witnesses', target: node?.id || 'unknown', value: 'none' },
      ],
    };
  }
  const testBasis = isTestPosition(component, position.file);
  if (testBasis) return { group: 'test-suite', rule: 'S6-test-position', basis: `component ${component} · ${testBasis} · ${cite(position)}` };
  for (const entry of COMPONENT_PATH_RULES[component] || []) {
    if (segmentsOf(position.file)[0] === entry.segment) return { group: entry.group, rule: 'S7-component-path-position', basis: `component ${component} · path under ${entry.segment}/ · ${cite(position)}` };
  }
  const componentGroup = COMPONENT_GROUPS[component];
  if (componentGroup) return { group: componentGroup, rule: 'S8-component-membership', basis: `component ${component} · ${cite(position)}` };
  return {
    reason: 'no_structural_rule_for_component',
    reason_detail: `component ${component || 'unknown'} is not mapped by S8-component-membership and no kind or path rule covers this node`,
    rule: 'S9-unclassified',
    examined: [
      { relation: 'node_kind', target: kind || 'unknown', value: 'no kind rule matched' },
      { relation: 'component', target: component || 'unknown', value: 'not in COMPONENT_GROUPS' },
      { relation: 'position', target: cite(position), value: 'no test or component-path rule matched' },
    ],
  };
}

function annotationFor(node, decision, generatedAt) {
  const position = positionOf(node);
  return {
    annotation_kind: STRUCTURAL_ANNOTATION_KIND,
    body: { basis: decision.basis, group: decision.group, rule: decision.rule },
    // A rule firing on a directory name is either true or false; there is no middle. Recording
    // anything below 1 would imply a scoring model that does not exist.
    confidence: 1,
    generated_at: generatedAt,
    grounded_in: [{ file: position.file, line: position.line, repo: position.repo }],
    kind: 'doc_derived_annotation',
    model: STRUCTURAL_PRODUCER,
    subject: node.id,
  };
}
function unclassifiedFor(node, decision) {
  const position = positionOf(node);
  return {
    examined: decision.examined,
    id: `structural-unclassified:${node.id}`,
    producer: STRUCTURAL_PRODUCER,
    reason: decision.reason,
    reason_detail: decision.reason_detail,
    rule: decision.rule,
    schema: STRUCTURAL_UNCLASSIFIED_SCHEMA,
    subject: node.id,
    subject_kind: String(node.kind || 'unknown'),
    witness: position ? { file: position.file, line: position.line, repo: position.repo } : null,
  };
}

/**
 * Derive structural groups for a whole graph. Returns validated records plus a census. Every
 * annotation is passed through the SHIPPED validateAnnotation and every unclassified record
 * through the SHIPPED validateStructuralUnclassified before it is returned, so a schema
 * violation fails here rather than at merge time.
 */
export function deriveStructuralGroups(graph, { now = new Date().toISOString() } = {}) {
  const nodes = (graph?.nodes || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const annotations = [], unclassified = [];
  const byGroup = new Map(), byRule = new Map(), byReason = new Map(), examples = new Map();
  for (const node of nodes) {
    const decision = classifyNode(node);
    if (decision.group) {
      if (!STRUCTURAL_GROUPS.includes(decision.group)) throw new Error(`${decision.rule} produced group '${decision.group}' outside STRUCTURAL_GROUPS`);
      annotations.push(validateAnnotation(annotationFor(node, decision, now), `structural_group ${node.id}`));
      byGroup.set(decision.group, (byGroup.get(decision.group) || 0) + 1);
      byRule.set(decision.rule, (byRule.get(decision.rule) || 0) + 1);
    } else {
      unclassified.push(validateStructuralUnclassified(unclassifiedFor(node, decision), `structural_unclassified ${node.id}`));
      byReason.set(decision.reason, (byReason.get(decision.reason) || 0) + 1);
      const list = examples.get(decision.reason) || [];
      if (list.length < 5) { list.push(node.id); examples.set(decision.reason, list); }
    }
  }
  const rows = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const census = {
    producer: STRUCTURAL_PRODUCER,
    nodes: nodes.length,
    grouped: annotations.length,
    unclassified: unclassified.length,
    // The coverage invariant, computed rather than asserted: every node is on exactly one side.
    coverage_complete: annotations.length + unclassified.length === nodes.length,
    by_group: rows(byGroup).map(([group, count]) => ({ group, count })),
    by_rule: rows(byRule).map(([rule, count]) => ({ rule, count })),
    unclassified_by_reason: rows(byReason).map(([reason, count]) => ({ reason, count, examples: examples.get(reason) || [] })),
    vocabulary: [...STRUCTURAL_GROUPS],
    unused_vocabulary: STRUCTURAL_GROUPS.filter(group => !byGroup.has(group)),
  };
  return { annotations, unclassified, census };
}

// One record per line, keys emitted in the alphabetical order the record literals above are
// written in, matching domain-derivation.mjs#writeJsonl byte for byte in shape. `stableStringify`
// is NOT used here: it pretty-prints, which would break the one-record-per-line contract that
// annotate.mjs#readJsonl parses.
const writeJsonl = async (file, records) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
};

export async function produceStructuralGrouping(graphPath, outPath, options = {}) {
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const { annotations, unclassified, census } = deriveStructuralGroups(graph, options);
  annotations.sort((a, b) => a.subject.localeCompare(b.subject));
  unclassified.sort((a, b) => a.id.localeCompare(b.id));
  const unclassifiedPath = options.unclassifiedPath || outPath.replace(/\.jsonl$/, '') + '.structural-unclassified.jsonl';
  await writeJsonl(outPath, annotations);
  await writeJsonl(unclassifiedPath, unclassified);
  if (options.censusPath) {
    await fs.mkdir(path.dirname(options.censusPath), { recursive: true });
    await fs.writeFile(options.censusPath, JSON.stringify(census, null, 2) + '\n', 'utf8');
  }
  return { out: outPath, unclassifiedPath, census };
}

function summarize(census) {
  const lines = [`STRUCTURAL GROUPING — ${census.grouped} grouped, ${census.unclassified} unclassified over ${census.nodes} node(s)`];
  lines.push(`coverage_complete=${census.coverage_complete}  (grouped + unclassified === nodes)`);
  lines.push('', 'GROUP                  count   share');
  for (const row of census.by_group) lines.push(`  ${row.group.padEnd(20)} ${String(row.count).padStart(5)}  ${(row.count / census.nodes * 100).toFixed(1)}%`);
  if (census.unclassified) {
    lines.push('', 'UNCLASSIFIED (a large count here is a FINDING, not a bucket)');
    for (const row of census.unclassified_by_reason) lines.push(`  ${row.reason} ${row.count} · e.g. ${row.examples.slice(0, 3).join(', ')}`);
  }
  lines.push('', 'RULE');
  for (const row of census.by_rule) lines.push(`  ${row.rule.padEnd(28)} ${String(row.count).padStart(5)}`);
  if (census.unused_vocabulary.length) lines.push('', `UNUSED VOCABULARY  ${census.unused_vocabulary.join(', ')} — declared but with zero members on this corpus`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length < 2) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await produceStructuralGrouping(path.resolve(positional[0]), path.resolve(positional[1]), {
      ...(options.unclassified ? { unclassifiedPath: path.resolve(options.unclassified) } : {}),
      ...(options.census ? { censusPath: path.resolve(options.census) } : {}),
      ...(options['generated-at'] ? { now: options['generated-at'] } : {}),
    });
    console.log(options.json ? JSON.stringify(result.census, null, 2) : summarize(result.census));
  } catch (error) { console.error(error.message); process.exit(1); }
}
