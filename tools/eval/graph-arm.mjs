import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultExternalBenchmarkPolicy, isExcludedBenchmarkPath, validateBenchmarkPolicy } from './benchmark-policy.mjs';

const exec = promisify(execFile);
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
// The transport cap protects the controller process. It must exceed the model-visible result cap
// so bounded() can return its typed result rather than child_process failing first.
export const TRANSPORT_LIMIT_BYTES = 2 * 1024 * 1024;
export const GRAPH_COMMANDS = Object.freeze(['projection-status', 'stats', 'concepts', 'overview', 'search', 'node', 'neighbors', 'consumers', 'path', 'provenance', 'read-span']);
const INDEX_ONLY_COMMANDS = Object.freeze(GRAPH_COMMANDS.filter(command => command !== 'read-span'));

function positiveInteger(value, fallback, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  return parsed;
}
function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}
function bounded(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= OUTPUT_LIMIT_BYTES) return value;
  // The controller aggregates benchmark exclusions from every tool result, including a result it
  // refused to expose to the model. Losing this receipt on overflow would understate filtering.
  return { error: 'EVAL_TOOL_OUTPUT_LIMIT', bytes, maximum_bytes: OUTPUT_LIMIT_BYTES,
    ...(value?.benchmark_filter ? { benchmark_filter: value.benchmark_filter } : {}) };
}
function commandArguments() {
  return {
    'projection-status': {},
    stats: {},
    concepts: { limit: 'integer? (1..50; default 6)' },
    overview: { limit: 'integer? (1..500; default 12)' },
    search: { term: 'string', limit: 'integer? (1..200)', kinds: 'string[]?' },
    node: { id: 'node ID from search/node', limit: 'integer? (1..1000)', expand: 'structural|all? (default structural: structural and flow neighbours as rows, annotation as counted bundles)' },
    neighbors: { id: 'node ID from search/node', relation: 'exact relation name?', direction: 'in|out|both? (default both)', limit: 'integer? (1..200; default 40)' },
    consumers: { id: 'Envelope node ID from search/node', limit: 'integer? (1..200; default 40)' },
    path: { from: 'node ID', to: 'node ID', depth: 'integer? (1..12)' },
    provenance: { id: 'node ID', depth: 'integer? (1..12)', limit: 'integer? (1..50)' },
    'read-span': { id: 'node ID from search or node', before: 'non-negative integer?', after: 'non-negative integer?' },
  };
}
function schema(commands) {
  const byCommand = commandArguments();
  for (const command of Object.keys(byCommand)) if (!commands.includes(command)) delete byCommand[command];
  return Object.freeze({ version: 'evaluation-graph-arm/v2', allowed_tool_names: ['estate_query'], tools: [{
    name: 'estate_query', description: 'Traverse bounded directed Ascrybe edges first: search/node results return next_queries for neighbors and Envelope consumers. Use keyword search only to obtain an ID, then follow neighbors or consumers. read-span accepts only a returned CodeFact node ID, never a filesystem path.',
    input: { command: { enum: commands }, arguments: { by_command: byCommand } },
  }] });
}
function provenanceValues(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  const values = [];
  for (const key of ['source', 'source_path', 'file', 'path', 'namespace']) {
    const candidate = source[key];
    if (typeof candidate === 'string') values.push(candidate);
    else if (candidate && typeof candidate === 'object') {
      for (const nested of ['source_path', 'file', 'path', 'namespace']) if (typeof candidate[nested] === 'string') values.push(candidate[nested]);
    }
  }
  return values;
}
function parsedDetailsJson(properties) {
  if (typeof properties.details_json !== 'string') return null;
  try { return JSON.parse(properties.details_json); } catch { return null; }
}
function ownProvenanceValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties) ? value.properties : {};
  // source_path is emitted for new Evidence nodes. details_json covers selected projections
  // produced before that canonical field existed without treating labels or quotes as provenance.
  return [value, properties, parsedDetailsJson(properties)].flatMap(provenanceValues);
}
// A benchmark-filtered result cannot keep aggregate counts: the filter removed rows the counts
// still include, and a count the model cannot reconcile with the rows is a leak of how many were
// hidden. Consumer group counts and node bundle counts both become unavailable.
function redactFilteredBundleCounts(value) {
  if (value?.query !== 'node' || !Array.isArray(value.data?.bundles)) return value;
  return { ...value, data: { ...value.data,
    bundles: value.data.bundles.map(bundle => ({ ...bundle, count: null })),
    bundle_counts_available: false,
  } };
}
function redactFilteredConsumerCounts(value) {
  if (value?.query !== 'consumers' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return value;
  const retainedGroups = groups => Array.isArray(groups) ? groups.map(group => ({ ...group,
    count: null,
    returned_count: Array.isArray(group.nodes) ? group.nodes.length : 0,
    distinct_node_count: Array.isArray(group.nodes) ? group.nodes.length : 0,
  })) : groups;
  return { ...value, data: { ...value.data,
    publishers: retainedGroups(value.data.publishers), consumers: retainedGroups(value.data.consumers),
    publisher_count: null, consumer_count: null,
    has_zero_publishers: null, has_zero_consumers: null,
    counts_available: false,
  } };
}

export function removeUnavailableNextQueries(value, commands) {
  if (Array.isArray(value)) return value.map(item => removeUnavailableNextQueries(item, commands));
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeUnavailableNextQueries(item, commands)]));
  if (Array.isArray(value.next_queries)) {
    copy.next_queries = value.next_queries.filter(query => commands.has(query?.command));
  }
  return copy;
}

export function filterBenchmarkRows(value, policy) {
  let filtered = 0;
  const removedNodeIds = new Set();
  const visit = input => {
    if (Array.isArray(input)) return input.map(visit).filter(item => item !== undefined);
    if (!input || typeof input !== 'object') return input;
    if (ownProvenanceValues(input).some(path => isExcludedBenchmarkPath(path, policy))) {
      filtered += 1;
      if (typeof input.id === 'string') removedNodeIds.add(input.id);
      return undefined;
    }
    const result = {};
    let filteredPrimaryNode = false;
    for (const [key, child] of Object.entries(input)) {
      const filteredChild = visit(child);
      if (filteredChild !== undefined) result[key] = filteredChild;
      else if (['node', 'target', 'focal_node', 'envelope'].includes(key)) filteredPrimaryNode = true;
    }
    return filteredPrimaryNode ? undefined : result;
  };
  const pruneEdges = input => {
    if (Array.isArray(input)) return input.map(pruneEdges).filter(item => item !== undefined);
    if (!input || typeof input !== 'object') return input;
    if ((typeof input.from === 'string' && removedNodeIds.has(input.from)) || (typeof input.to === 'string' && removedNodeIds.has(input.to))) return undefined;
    const copy = {};
    for (const [key, child] of Object.entries(input)) {
      const pruned = pruneEdges(child);
      if (pruned !== undefined) copy[key] = pruned;
    }
    return copy;
  };
  const visible = pruneEdges(visit(value));
  return { value: filtered ? redactFilteredBundleCounts(redactFilteredConsumerCounts(visible)) : visible, filtered };
}
function argumentsFor(command, input) {
  const args = input && typeof input === 'object' ? input : {};
  const integer = (name, fallback, maximum) => positiveInteger(args[name], fallback, maximum, name);
  if (command === 'projection-status' || command === 'stats') return [];
  if (command === 'concepts' || command === 'overview') return ['--limit', String(integer('limit', command === 'concepts' ? 6 : 12, command === 'concepts' ? 50 : 500))];
  if (command === 'search') {
    if (typeof args.term !== 'string') throw new Error('search term required');
    const output = ['--term', args.term];
    if (args.limit != null) output.push('--limit', String(integer('limit', 40, 200)));
    if (args.kinds != null) {
      if (!Array.isArray(args.kinds) || args.kinds.some(kind => typeof kind !== 'string' || !kind)) throw new Error('search kinds must be a string array');
      output.push('--kinds', args.kinds.join(','));
    }
    return output;
  }
  if (command === 'node') {
    if (typeof args.id !== 'string' || !args.id) throw new Error('node id required');
    if (args.expand != null && !['structural', 'all'].includes(args.expand)) throw new Error('node expand must be structural or all');
    return ['--id', args.id, ...(args.limit == null ? [] : ['--limit', String(integer('limit', 120, 1000))]),
      ...(args.expand == null ? [] : ['--expand', args.expand])];
  }
  if (command === 'neighbors') {
    if (typeof args.id !== 'string' || !args.id) throw new Error('neighbors id required');
    const output = ['--id', args.id];
    if (args.relation != null) {
      if (typeof args.relation !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(args.relation)) throw new Error('neighbors relation must be an exact relation name');
      output.push('--relation', args.relation);
    }
    if (args.direction != null) {
      if (!['in', 'out', 'both'].includes(args.direction)) throw new Error('neighbors direction must be in, out, or both');
      output.push('--direction', args.direction);
    }
    if (args.limit != null) output.push('--limit', String(integer('limit', 40, 200)));
    return output;
  }
  if (command === 'consumers') {
    if (typeof args.id !== 'string' || !args.id) throw new Error('consumers Envelope id required');
    return ['--id', args.id, ...(args.limit == null ? [] : ['--limit', String(integer('limit', 40, 200))])];
  }
  if (command === 'path') {
    if (typeof args.from !== 'string' || typeof args.to !== 'string' || !args.from || !args.to) throw new Error('path endpoints required');
    return ['--from', args.from, '--to', args.to, ...(args.depth == null ? [] : ['--depth', String(integer('depth', 6, 12))])];
  }
  if (command === 'provenance') {
    if (typeof args.id !== 'string' || !args.id) throw new Error('provenance id required');
    const output = ['--id', args.id];
    if (args.depth != null) output.push('--depth', String(integer('depth', 6, 12)));
    if (args.limit != null) output.push('--limit', String(integer('limit', 12, 50)));
    return output;
  }
  if (command === 'read-span') {
    if (typeof args.id !== 'string' || !args.id) throw new Error('read-span node id required');
    const output = ['--id', args.id];
    if (args.before != null) output.push('--before', String(nonNegativeInteger(args.before, 'before')));
    if (args.after != null) output.push('--after', String(nonNegativeInteger(args.after, 'after')));
    return output;
  }
  throw new Error('unsupported graph command');
}
export function createGraphArm({ runtime_config_path, query_script, environment = process.env, execute = exec,
  benchmark_policy = defaultExternalBenchmarkPolicy(), graph_mode = 'as-deployed', transport_limit_bytes = TRANSPORT_LIMIT_BYTES }) {
  if (typeof runtime_config_path !== 'string' || !runtime_config_path) throw new Error('graph runtime config path required');
  if (typeof query_script !== 'string' || !query_script) throw new Error('graph query script required');
  if (!['index-only', 'as-deployed'].includes(graph_mode)) throw new Error('graph_mode must be index-only or as-deployed');
  if (!Number.isInteger(transport_limit_bytes) || transport_limit_bytes <= OUTPUT_LIMIT_BYTES) {
    throw new Error(`transport_limit_bytes must exceed ${OUTPUT_LIMIT_BYTES}`);
  }
  const policy = validateBenchmarkPolicy(benchmark_policy);
  const visibleCommands = graph_mode === 'index-only' ? INDEX_ONLY_COMMANDS : GRAPH_COMMANDS;
  const commands = new Set(visibleCommands);
  return Object.freeze({ schema: schema(visibleCommands), tools: Object.freeze({
    async estate_query({ command, arguments: input = {}, ...rest } = {}) {
      if (!commands.has(command)) throw new Error('unsupported graph command');
      // Models emit the documented nested form most of the time and occasionally flatten it to
      // {command, term, limit}. The intent is unambiguous either way, and rejecting the flat form
      // spends a paid turn to teach syntax: in one 20-question run it produced 34 failed calls and
      // 34 abstentions, which measured this convention rather than the map. Accept both shapes and
      // validate identically afterwards; genuinely missing arguments still fail in argumentsFor.
      const supplied = Object.keys(rest).length && !Object.keys(input).length ? rest : input;
      const argv = [query_script, '--runtime-config', runtime_config_path, '--view', 'selected', command, ...argumentsFor(command, supplied)];
      const result = await execute(process.execPath, argv, { encoding: 'utf8', env: environment, maxBuffer: transport_limit_bytes });
      const filtered = filterBenchmarkRows(JSON.parse(result.stdout), policy);
      const benchmark_filter = { filtered_count: filtered.filtered,
        excluded_path_prefixes: policy.excluded_path_prefixes,
        ...(command === 'consumers' ? { consumer_counts: filtered.filtered ? 'unavailable-after-benchmark-filter' : 'available' } : {}) };
      // A benchmark-filtered span is a typed refusal result, not an exception: the model cannot see
      // the bytes, while the controller can still count the exclusion in the final disclosure.
      if (command === 'read-span' && filtered.filtered) {
        return bounded({ error: 'EVAL_BENCHMARK_PATH_EXCLUDED', benchmark_filter });
      }
      const visible = removeUnavailableNextQueries(filtered.value, commands);
      return bounded({ ...visible, benchmark_filter });
    },
  }) });
}
