import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultExternalBenchmarkPolicy, validateBenchmarkPolicy } from './benchmark-policy.mjs';
import { createGraphArm, filterBenchmarkRows, OUTPUT_LIMIT_BYTES, TRANSPORT_LIMIT_BYTES } from './graph-arm.mjs';

const exec = promisify(execFile);

// The Cypher arm swaps the closed command set for one validated read-only query surface plus the
// pinned read-span, so an experiment can measure whether a general query language beats the
// curated verbs on the same sealed questions. The gateway supplies projection scoping, the row
// cap, and typed refusals; this wrapper adds the same byte ceiling and benchmark filtering the
// command surface has, so the two graph surfaces differ in expressiveness only.
const SCHEMA_TEXT = `Ascrybe serving projection, one generation, scoped by the gateway-supplied $projection_id.
Node label EstateNode: {projection_id, node_id, kind, label, search_text (lowercase), plane, degree, structural_degree, structural_children, structural_descendants, properties_json (JSON string)}.
Node kinds include Plugin, Capability, Envelope, Module, Symbol, Route, Table, CodeFact, Claim, Evidence, Document, AdjudicationReceipt.
Relationship type ESTATE_EDGE: {projection_id, edge_id, relation, role (structural|flow|annotation), parent_end, properties_json (JSON string)}.
Relations include contains, declares_symbol, provides_capability, publishes_envelope, exposes_route, registers_route (structural); emits, consumes, imports, requires_capability, calls_capability (flow); documented_in, about, identifies, supported_by, adjudicated_by (annotation).
Flow-edge properties_json carries witnesses: [{repo, file, line}]. CodeFact properties_json carries {file, line, repository}. Filter inside properties_json with CONTAINS on the string.
Every EstateNode pattern MUST include {projection_id: $projection_id} — the gateway supplies the parameter and refuses unscoped queries. Edges between scoped nodes are scoped automatically.
Read-only: no CREATE/MERGE/SET/DELETE, no CALL procedures (CALL { } subqueries allowed), one statement, must RETURN. Results are capped at 200 rows with a disclosed truncated flag; narrow with WHERE or aggregate server-side (count, collect, DISTINCT) instead of paging.`;

function bounded(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= OUTPUT_LIMIT_BYTES) return value;
  return { error: 'EVAL_TOOL_OUTPUT_LIMIT', bytes, maximum_bytes: OUTPUT_LIMIT_BYTES,
    ...(value?.benchmark_filter ? { benchmark_filter: value.benchmark_filter } : {}) };
}

export function createCypherArm({ runtime_config_path, cypher_script, query_script, environment = process.env,
  execute = exec, benchmark_policy = defaultExternalBenchmarkPolicy(), graph_mode = 'as-deployed',
  transport_limit_bytes = TRANSPORT_LIMIT_BYTES }) {
  if (typeof runtime_config_path !== 'string' || !runtime_config_path) throw new Error('cypher runtime config path required');
  if (typeof cypher_script !== 'string' || !cypher_script) throw new Error('cypher gateway script required');
  const policy = validateBenchmarkPolicy(benchmark_policy);
  // read-span (and only read-span) rides the existing command wrapper so pinned source reads keep
  // their benchmark filtering and index-only unavailability exactly as the command surface has.
  const commandSurface = createGraphArm({ runtime_config_path, query_script, environment, execute,
    benchmark_policy, graph_mode, transport_limit_bytes });
  const readSpanVisible = commandSurface.schema.tools[0].input.command.enum.includes('read-span');
  const tools = {
    async estate_cypher({ query, parameters } = {}) {
      const argv = [cypher_script, '--runtime-config', runtime_config_path, '--view', 'selected',
        '--query', String(query ?? ''),
        ...(parameters === undefined ? [] : ['--parameters', JSON.stringify(parameters)])];
      let result;
      try {
        result = await execute(process.execPath, argv, { encoding: 'utf8', env: environment, maxBuffer: transport_limit_bytes });
      } catch (error) {
        // The gateway prints a typed refusal to stderr and exits non-zero; surface that refusal to
        // the model as a result it can adapt to rather than an opaque invocation failure.
        const line = String(error?.stderr ?? '').trim().split('\n').at(-1);
        try {
          const refusal = JSON.parse(line);
          if (refusal?.error) return refusal;
        } catch { /* not a typed refusal: rethrow below */ }
        throw error;
      }
      const filtered = filterBenchmarkRows(JSON.parse(result.stdout), policy);
      return bounded({ ...filtered.value,
        benchmark_filter: { filtered_count: filtered.filtered, excluded_path_prefixes: policy.excluded_path_prefixes } });
    },
    ...(readSpanVisible ? {
      async estate_query(request = {}) {
        const command = request?.command;
        if (command !== 'read-span') throw new Error('this arm exposes estate_query only for read-span; use estate_cypher for graph queries');
        return commandSurface.tools.estate_query(request);
      },
    } : {}),
  };
  return Object.freeze({
    schema: Object.freeze({
      version: 'evaluation-cypher-arm/v1',
      allowed_tool_names: Object.keys(tools),
      tools: [
        { name: 'estate_cypher', description: 'One bounded read-only Cypher query over the Ascrybe projection.',
          arguments: { query: 'Cypher string (single statement, must RETURN)', parameters: 'object? (Cypher parameters; $projection_id is supplied for you)' },
          data_model: SCHEMA_TEXT },
        ...(readSpanVisible ? [{ name: 'estate_query', description: 'read-span only: exact pinned source bytes for a returned CodeFact node ID.',
          commands: { 'read-span': { id: 'CodeFact node ID', before: 'non-negative integer?', after: 'non-negative integer?' } } }] : []),
      ],
    }),
    tools: Object.freeze(tools),
  });
}
