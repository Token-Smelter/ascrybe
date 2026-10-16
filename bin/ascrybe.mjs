#!/usr/bin/env node
// The one command. Everything Ascrybe does is a verb here.
//
// The npm scripts this replaces had three problems worth naming, because they are the reasons this
// file exists rather than taste. They required `--` before any flag; five of them pinned a
// RELATIVE `ascrybe.config.json`, so they only ran with the checkout as the working directory --
// backwards for a tool whose job is to map OTHER repositories; and `extract`, `merge`, `remap` and
// the claims run had no script at all, so the pipeline was invokable but undiscoverable.
//
// This dispatches rather than implements. Each verb spawns the module that already owns it, so
// there is one behaviour per command and no second copy of it here.
//
// WHAT BELONGS HERE. A verb is something done to an ESTATE -- read it, project it, query it, send
// it. Something done to ASCRYBE ITSELF -- install dependencies, run the gate battery, rebind the
// design-authority ledger -- stays an npm script, because it only means anything inside a checkout.
// That is the same line the documentation draws between USAGE and CONTRIBUTING, and it should stay
// the same line: if a command belongs in USAGE it belongs here.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `config` injects --runtime-config when the caller did not give one. `heap` re-execs with a
// larger V8 heap: a corpus projection holds the whole generation in memory before writing any of
// it, and a shebang cannot portably carry the flag.
const COMMANDS = {
  snapshot: { script: 'tools/snapshot-source.mjs', describe: 'import an authorized non-Git folder into private screened snapshot custody' },
  state: { script: 'tools/artifact-state.mjs', verbs: ['init', 'migrate', 'verify', 'snapshot'],
    describe: 'create or check the external artifact root' },
  // The heap is not decoration. Materialization holds one repository's every blob in memory
  // before it writes any of them, so a repository in the tens of thousands of files exhausts the
  // default heap and takes the whole estate with it.
  materialize: { script: 'tools/materialize-estate.mjs', config: true, heap: 16384,
    describe: 'build an estate root from the repositories the config declares' },
  extract: { script: 'tools/extract.mjs', describe: 'read an estate into facts' },
  merge: { script: 'tools/merge.mjs', describe: 'reconcile facts into one code graph' },
  remap: { script: 'scripts/remap.mjs', describe: 'resolve the code plane and its referents' },
  // Binding materializes claims and evidence together; reserve heap headroom before
  // dispatch so the runtime allocator does not abort ahead of the producer's checks.
  claims: { script: 'tools/semantic-map-run.mjs', heap: 49152, describe: 'the paid documentary read' },
  // File-scope delta planning only (docs/delta-file-scope-implementation-status.md): per-unit
  // identity/cache reuse, Estate Build Manifest assembly, and the full-vs-delta equivalence
  // oracle. --promote is always a typed refusal -- this verb never stages, never runs CAS, and
  // never changes what a selected/working generation serves.
  // config:true so the SAME catalog_globs an estate's ascrybe.config.json declares reaches this
  // verb by default too (tools/delta-update-run.mjs reads it leniently: no config file at the
  // resolved default location is not an error -- this verb still needs no live estate to run at
  // all -- but an explicit --runtime-config or --catalog-globs that IS present and invalid still
  // refuses).
  update: { script: 'tools/delta-update-run.mjs', config: true,
    describe: 'plan a delta/full/shadow update build and run the equivalence oracle (never promotes)' },
  project: { script: 'tools/project-estate-map.mjs', config: true, heap: 16384,
    describe: 'build a graph generation and optionally promote it' },
  // Pure: buildUnifiedEstateProjection() over a claim map and code graph already on disk. Never
  // opens a database connection, never stages a working generation, never promotes -- the offline
  // comparison path for a delta candidate's projection (docs/delta-documentary-update-status.md).
  'offline-project': { script: 'tools/delta/build-offline-projection.mjs',
    describe: 'build a projection from a claim map and code graph on disk, without Neo4j or promotion' },
  // The supported update procedure, as one command: extract (full, deterministic), reuse
  // documentary answers from named prior journals, --require-model coverage (always on), bind,
  // project, and optionally stage (never promote) to a named estate. Composes `claims` +
  // `offline-project` + `project`'s own staging step; heap matches `claims`'s own requirement
  // since it calls the same extraction/binding path.
  refresh: { script: 'tools/refresh-estate-graph.mjs', heap: 49152,
    describe: 'extract, reuse prior answers, bind, project, and optionally stage -- one receipt of what was reused vs paid' },
  query: { script: 'tools/estate-graph-query.mjs', config: true, describe: 'the bounded read surface' },
  cypher: { script: 'tools/estate-graph-cypher.mjs', config: true, describe: 'read-only Cypher, projection-scoped' },
  dashboard: { script: 'tools/estate-dashboard-server.mjs', config: true, describe: 'serve the graph' },
  'fork-view': { script: 'tools/fork-planning-view.mjs',
    describe: 'serve a local, read-only planning and observed-graph view' },
  package: { script: 'scripts/projection-package-cli.mjs', config: true, heap: 16384,
    verbs: ['pack', 'verify', 'load'], describe: 'send a graph to another Ascrybe user, or load one' },
  skill: { script: 'scripts/build-skill-bundle.mjs', verbs: ['bundle', 'install', 'verify'],
    describe: 'build, install, or check the read-only skill' },
  eval: { script: 'tools/eval/cli.mjs', describe: 'run an evaluation' },
  ontology: { script: 'tools/ontology/cli.mjs', config: true,
    verbs: ['build', 'stage', 'promote', 'query', 'classify', 'analyze-gap', 'discover', 'resolve-unknown', 'align', 'inventory', 'estate', 'diagnose', 'reconcile', 'predicates', 'coverage', 'loop', 'view'],
    describe: 'the additive interpretation sidecar -- build, stage, query, or propose source-grounded classifications and vocabularies' },
};

/**
 * The runtime config, in the order a caller expects to be obeyed: what they said, what their
 * environment says, then the conventional file beside them. Resolved to an absolute path so a verb
 * run from inside a mapped repository still finds it.
 */
export function resolveRuntimeConfig(argv, environment = process.env, cwd = process.cwd()) {
  if (argv.includes('--runtime-config')) return null;
  const held = String(environment.ASCRYBE_CONFIG ?? '').trim() || 'ascrybe.config.json';
  return isAbsolute(held) ? held : resolve(cwd, held);
}

export function planInvocation(argv, { environment = process.env, cwd = process.cwd(), root = repository } = {}) {
  const [name, ...rest] = argv;
  const command = COMMANDS[name];
  if (!command) return { error: name ? `unknown command: ${name}` : null };
  let verb = null;
  let args = rest;
  if (command.verbs) {
    const [held, ...tail] = rest;
    if (!command.verbs.includes(held)) {
      return { error: `ascrybe ${name} requires one of: ${command.verbs.join(', ')}` };
    }
    // `skill bundle` is the module's default action rather than an argument it accepts.
    verb = name === 'skill' && held === 'bundle' ? null : held;
    args = tail;
  }
  const config = command.config ? resolveRuntimeConfig(rest, environment, cwd) : null;
  // The verb stays FIRST. A grouped module reads its subcommand positionally, so injecting the
  // config ahead of it puts a flag where the subcommand has to be and the module rejects the path
  // as an unknown argument. Flags follow the verb; only ungrouped commands take config at the head.
  return {
    execArgv: command.heap ? [`--max-old-space-size=${command.heap}`] : [],
    script: join(root, command.script),
    args: [...(verb ? [verb] : []), ...(config ? ['--runtime-config', config] : []), ...args],
  };
}

/** The estate verbs, so a drift check can derive the partition instead of restating it. */
export const commandNames = () => Object.keys(COMMANDS).sort();

export function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length));
  return ['ascrybe <command> [options]', '', ...Object.entries(COMMANDS).map(([name, command]) =>
    `  ${name.padEnd(width)}  ${command.describe}${command.verbs ? `  (${command.verbs.join(' | ')})` : ''}`),
  '', 'Configuration: --runtime-config, else $ASCRYBE_CONFIG, else ./ascrybe.config.json'].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(join('bin', 'ascrybe.mjs'))) {
  const argv = process.argv.slice(2);
  const asked = argv[0] === '--help' || argv[0] === 'help';
  if (asked || !argv.length) {
    // Asking for help is not an error; being given nothing is.
    (asked ? console.log : console.error)(usage());
    process.exit(asked ? 0 : 1);
  }
  const plan = planInvocation(argv);
  if (plan.error) {
    console.error(`FAIL ${plan.error}\n\n${usage()}`);
    process.exit(1);
  }
  if (!existsSync(plan.script)) {
    console.error(`FAIL ascrybe is missing ${plan.script}; this checkout is incomplete`);
    process.exit(1);
  }
  const held = spawnSync(process.execPath, [...plan.execArgv, plan.script, ...plan.args], { stdio: 'inherit' });
  process.exit(held.status ?? 1);
}
