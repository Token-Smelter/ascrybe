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
  state: { script: 'tools/artifact-state.mjs', verbs: ['init', 'migrate', 'verify', 'snapshot'],
    describe: 'create or check the external artifact root' },
  extract: { script: 'tools/extract.mjs', describe: 'read an estate into facts' },
  merge: { script: 'tools/merge.mjs', describe: 'reconcile facts into one code graph' },
  remap: { script: 'scripts/remap.mjs', describe: 'resolve the code plane and its referents' },
  claims: { script: 'tools/semantic-map-run.mjs', describe: 'the paid documentary read' },
  project: { script: 'tools/project-estate-map.mjs', config: true, heap: 16384,
    describe: 'build a graph generation and optionally promote it' },
  query: { script: 'tools/estate-graph-query.mjs', config: true, describe: 'the bounded read surface' },
  cypher: { script: 'tools/estate-graph-cypher.mjs', config: true, describe: 'read-only Cypher, projection-scoped' },
  dashboard: { script: 'tools/estate-dashboard-server.mjs', config: true, describe: 'serve the graph' },
  package: { script: 'scripts/projection-package-cli.mjs', config: true, heap: 16384,
    verbs: ['pack', 'verify', 'load'], describe: 'send a graph to another Ascrybe user, or load one' },
  skill: { script: 'scripts/build-skill-bundle.mjs', verbs: ['bundle', 'verify'],
    describe: 'build the installable read-only skill' },
  eval: { script: 'tools/eval/cli.mjs', describe: 'run an evaluation' },
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
  let args = rest;
  if (command.verbs) {
    const [verb, ...tail] = rest;
    if (!command.verbs.includes(verb)) {
      return { error: `ascrybe ${name} requires one of: ${command.verbs.join(', ')}` };
    }
    // `skill bundle` is the module's default action rather than an argument it accepts.
    args = name === 'skill' && verb === 'bundle' ? tail : [verb, ...tail];
  }
  const config = command.config ? resolveRuntimeConfig(args, environment, cwd) : null;
  return {
    execArgv: command.heap ? [`--max-old-space-size=${command.heap}`] : [],
    script: join(root, command.script),
    args: config ? ['--runtime-config', config, ...args] : args,
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
