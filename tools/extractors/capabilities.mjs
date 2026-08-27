// CAPABILITY CONTRACT / CALL extractor.
//
// WHY THIS EXISTS (instrument defect J1, acceptance-test-round2.md §5.1). The
// round-2 map arm reported its own central failure in its MAP ASSESSMENT:
//
//   "The generated graph has no capability-call node/edge or signature layer;
//    it could not answer this claim. This was an explicit map failure."
//
// The claim it could not answer was the RFC's main mechanism claim — which
// capabilities exist, who provides them, and who calls them. Envelope flow and
// HTTP routes were already first-class in the graph; the OTHER inter-plugin
// coupling mechanism this estate actually uses was not in the map at all.
//
// THE REAL IDIOMS, read off this branch before any pattern below was written:
//
//   registration (code)
//     `context.capabilities.provide(type, versionStr, handler)` — the plugin
//     context surface, src/substrate/pluginContext.mjs:357-360, which forwards
//     to src/substrate/capabilityRegistry.mjs:37 `provide(type, version,
//     handler, pluginName)`. Real sites e.g.
//     plugins/episodic-memory/server/index.mjs:860,
//     plugins/legitimacy-escrow/server/index.mjs:35,
//     plugins/task-orchestration/server/workTypes.mjs:1012.
//
//   binding (code)
//     `context.capabilities.require(type, versionRange)` —
//     src/substrate/pluginContext.mjs:361-363 forwarding to
//     capabilityRegistry.mjs:45. Real sites e.g.
//     plugins/task-intents/server/index.mjs:176-178,
//     plugins/project-registry/server/index.mjs:114,:126,
//     plugins/task-orchestration/server/index.mjs:2500.
//
//   invocation (code)
//     the handle returned by `require()` exposes exactly ONE method —
//     `async request(input)` (capabilityRegistry.mjs:50-77), which hard-requires
//     `input.idempotency_key`. So a capability CALL is a `<handle>.request(`
//     site, e.g. plugins/task-intents/server/index.mjs:182,
//     plugins/recipe-engine/server/index.mjs:4271.
//
//   declaration (manifest)
//     `provides_capabilities:` / `requires_capabilities:` lists of
//     `{ type, version, optional? }` — the shape src/substrate/pluginManifest.mjs:46
//     shape-checks as a list and src/plugin-runtime/schemas/index.mjs:114-115
//     types as `capabilityDeclaration`. Real declarations e.g.
//     plugins/task-intents/plugin.yaml:82-91.
//     `http_routes:` lists of `{ method, path, auth }` are extracted here too —
//     not because they are capabilities, but because they are the third family
//     of MANIFEST DECLARATION whose wiring reality K3 has to assess, and the
//     manifest is one file with one parser.
//
// A NOTE ON `capabilities.call()`. The round-2 RFC claimed a `capabilities.call()`
// API. There is no such method: `pluginContext.mjs` exposes `provide` and
// `require` only, and the handle exposes `request`. This extractor recognises
// the idioms that EXIST; an estate map that invented a `call` idiom to match a
// document would be the stale-citation trap, inverted.
//
// REFUSALS, NOT GUESSES — the established route-extractor discipline
// (extractors/http.mjs). Four undeterminable cases are each recorded as a
// `capability_refusal` fact naming exactly what was examined:
//   * a `provide(`/`require(` whose TYPE argument is not a string literal
//     (a constant, a variable) — real: plugins/task-orchestration/server/
//     workOrderManagementCapability.mjs:11-15 passes
//     `WORK_ORDER_MANAGEMENT_CAPABILITY`, and plugins/work-explorer/server/
//     index.mjs:71 + plugins/scoped-dispatch/server/index.mjs:27 pass a
//     parameter;
//   * a `.request(` whose receiver is not bound IN THIS FILE to a literal
//     `require(` result — real: `cap`, `escrow`, `provider` are returned by
//     memoising helper functions;
//   * a `.request(` at the head of a line whose receiver sits on the previous
//     line (`\n  .request({`) — real: plugins/recipe-engine/server/index.mjs:2637;
//   * a site under no `plugins/<owner>/` directory, whose owning plugin — the
//     `pluginName` capabilityRegistry.mjs:37 records as the provider — is not
//     derivable from the path.
//
// DETERMINISM. Line-oriented, byte-derived, no model calls; every fact carries
// the file:line that produced it.

import { pluginOwnerFromPath } from './http.mjs';

/**
 * The plugin DIRECTORY that owns a site. `pluginOwnerFromPath` answers "the
 * segment after the last `plugins` segment", which is right for a route under
 * `plugins/<owner>/server/index.mjs` and WRONG for a file sitting directly
 * under one: `test/plugins/recipeEngineSingleTask.test.mjs` would name the test
 * FILE as the owning plugin, and the map would then report a test file among a
 * capability's consuming plugins. A plugin owner is a directory, so the owner
 * segment can never be the last one.
 */
export function pluginDirectoryOwner(estatePath) {
  const owner = pluginOwnerFromPath(estatePath);
  if (!owner) return null;
  const segments = String(estatePath || '').split('/').filter(Boolean);
  return segments[segments.length - 1] === owner ? null : owner;
}

// The receiver is deliberately loose (`context.capabilities`, `ctx.capabilities`,
// a destructured `capabilities`, and the optional-chained `capabilities?.require?.(`
// that plugins/work-explorer/server/index.mjs:71 really writes); what makes it a
// capability site is the `.provide(` / `.require(` call on a `capabilities` member.
const CAPABILITY_CALL = /\bcapabilities\s*\??\.\s*(provide|require)\s*(?:\?\.)?\s*\(/;
const CAPABILITY_LITERAL = /\bcapabilities\s*\??\.\s*(provide|require)\s*(?:\?\.)?\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*(?:,\s*(["'])([^"']*)\4)?/;
// A `provide(` whose arguments start on the NEXT line, which
// plugins/task-orchestration/server/index.mjs:5908-5912 really writes. The
// window is 2 lines — measured: the longest real gap between `provide(` and its
// type argument in this estate is 1 line.
const ARGUMENT_CONTINUATION = /^\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s*,/;
const ARGUMENT_WINDOW = 2;
// `const woMgmt = ctx.capabilities.require("work_order_management", "^1.0")` and
// the bare `brewCap = context.capabilities.require("brew", "^1.0")` inside a
// try/catch that plugins/task-intents/server/index.mjs:176-178 writes.
const CAPABILITY_BINDING = /(?:^|[^\w$.])(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$?.]*capabilities\s*\??\.\s*require\s*(?:\?\.)?\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2/;
// The ONE method a capability handle exposes (capabilityRegistry.mjs:50).
const REQUEST_CALL = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\??\.\s*request\s*\(/;
// `\n  .request({` — a continuation whose receiver is on an earlier line.
const ORPHAN_REQUEST = /^\s*\??\.\s*request\s*\(/;
// N1's mechanism, made visible: `try { x = …require(…); } catch { x = null; }`
// swallows an absent provider into an indistinguishable null. Detected only in
// its single-line form, which is the form this estate writes; a multi-line
// try/catch is NOT claimed either way (the field says `unguarded`, and §K3's
// wiring record carries the limitation).
const SINGLE_LINE_NULL_GUARD = /\btry\s*\{[^]*\bcatch\b[^{]*\{[^}]*\bnull\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

// Manifest blocks. `capabilityDeclaration` (src/plugin-runtime/schemas/index.mjs:35)
// keys on `type`; the HTTP declaration (schemas/index.mjs:57-65) keys on
// `method` + `path` + `auth`.
const YAML_BLOCKS = {
  provides_capabilities: { direction: 'provide', idiom: 'manifest_provides_capability', manifest_key: 'provides_capabilities' },
  requires_capabilities: { direction: 'require', idiom: 'manifest_requires_capability', manifest_key: 'requires_capabilities' },
};
const YAML_BLOCK_START = /^([a-z_]+):\s*(?:#.*)?$/;
const YAML_TOP_LEVEL = /^[^\s#-]/;
const YAML_TYPE_ITEM = /^\s*-\s*type:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:#.*)?$/;
const YAML_VERSION = /^\s*version:\s*["']?([~^]?[0-9][A-Za-z0-9_.*-]*)["']?\s*(?:#.*)?$/;
const YAML_OPTIONAL = /^\s*optional:\s*(true|false)\s*(?:#.*)?$/;
const YAML_ROUTE_ITEM = /^\s*-\s*method:\s*["']?([A-Za-z]+)["']?\s*(?:#.*)?$/;
const YAML_ROUTE_PATH = /^\s*path:\s*["']?(\/[^\s"'#]*)["']?\s*(?:#.*)?$/;
const YAML_ROUTE_AUTH = /^\s*auth:\s*["']?([A-Za-z_]+)["']?\s*(?:#.*)?$/;

/** True when the file is a plugin manifest, whose declaration blocks this extractor reads. */
export const isPluginManifest = file => /(?:^|\/)plugin\.ya?ml$/i.test(String(file || ''));

function scanManifest(lines, ctx) {
  const facts = [];
  // A manifest declaration names its plugin the same way a code site does: the
  // `plugins/<owner>/` segment. Carrying it here is what lets the merged graph
  // answer "which plugins DECLARE this capability, and which ones really
  // register it" as two separate questions.
  const owner = pluginDirectoryOwner(`${ctx.repo}/${ctx.file}`);
  let block = null;
  let pending = null;
  const flush = () => { if (pending) facts.push(pending); pending = null; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = line.match(YAML_BLOCK_START);
    if (start) {
      flush();
      block = YAML_BLOCKS[start[1]] ? { ...YAML_BLOCKS[start[1]], family: 'capability' } : start[1] === 'http_routes' ? { family: 'http_route' } : null;
      continue;
    }
    if (!block) continue;
    if (YAML_TOP_LEVEL.test(line)) { flush(); block = null; continue; }
    if (block.family === 'capability') {
      const item = line.match(YAML_TYPE_ITEM);
      if (item) {
        flush();
        pending = ctx.fact('capability_flow', index + 1, {
          capability_type: item[1], direction: block.direction, idiom: block.idiom,
          source: 'manifest', manifest_key: block.manifest_key, version: null, optional: false, owner,
        });
        continue;
      }
      if (!pending) continue;
      const version = line.match(YAML_VERSION);
      if (version) { pending.version = version[1]; continue; }
      const optional = line.match(YAML_OPTIONAL);
      if (optional) pending.optional = optional[1] === 'true';
      continue;
    }
    const route = line.match(YAML_ROUTE_ITEM);
    if (route) {
      flush();
      pending = ctx.fact('manifest_route_declaration', index + 1, { method: route[1].toUpperCase(), path: null, auth: null, owner });
      continue;
    }
    if (!pending) continue;
    const routePath = line.match(YAML_ROUTE_PATH);
    if (routePath) { pending.path = routePath[1]; continue; }
    const auth = line.match(YAML_ROUTE_AUTH);
    if (auth) pending.auth = auth[1];
  }
  flush();
  // A declaration whose `path` never appeared names no route; it is refused
  // rather than emitted with a null path a consumer would have to guess about.
  return facts.filter(fact => fact.kind !== 'manifest_route_declaration' || fact.path);
}

// PORTABILITY (semantic-portability-report-2026-07-27.md §F3). `.request(` is a
// method name the whole world uses — `axios.request(`, `http.request(`,
// `session.request(`, `client.request(`. It is a CAPABILITY call only because THIS
// substrate's `capabilities.require()` handle exposes exactly one method
// (src/substrate/capabilityRegistry.mjs:50). On an estate with no capability
// registry at all, refusing every `.request(` for "receiver not bound to a required
// capability" names no capability, cites no registry, and is simply false: measured
// 181 such refusals on one mapped estate, which has ZERO
// `capability_flow` facts.
//
// A refusal has to be ABOUT something. This gate keeps the refusal exactly where it
// is informative — a file that demonstrably reaches the capability surface, so an
// unresolvable receiver in it really might be a capability handle — and drops it
// where the file gives no evidence the surface exists. FILE scope, not estate scope,
// because file scope is already this extractor's honest ceiling for receiver
// binding: it never attributes a handle passed across a module boundary either.
const mentionsCapabilitySurface = lines => lines.some(line => !COMMENT_LINE.test(line) && CAPABILITY_CALL.test(line));

function scanCode(lines, ctx) {
  const facts = [];
  const estatePath = `${ctx.repo}/${ctx.file}`;
  const owner = pluginDirectoryOwner(estatePath);
  const capabilitySurfaceInFile = mentionsCapabilitySurface(lines);
  // File-scoped handle bindings: receiver name -> the capability type its
  // `require(` names. File scope is the honest ceiling for a line-oriented
  // reader; a handle passed across module boundaries is not bound here and its
  // call site is refused rather than attributed to a guess.
  const bindings = new Map();
  const refuse = (line, direction, reason, detail, examined) => facts.push(ctx.fact('capability_refusal', line, {
    direction, reason, reason_detail: detail, examined,
  }));

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (COMMENT_LINE.test(line)) continue;

    if (CAPABILITY_CALL.test(line)) {
      const match = line.match(CAPABILITY_LITERAL);
      const member = line.match(CAPABILITY_CALL)[1];
      const direction = member === 'provide' ? 'provide' : 'require';
      let type = match ? match[3] : null;
      let version = match ? match[5] || null : null;
      let span = 'single_line';
      if (!type) {
        // The arguments may start on the next line — the real multi-line form at
        // plugins/task-orchestration/server/index.mjs:5908.
        for (let ahead = 1; ahead <= ARGUMENT_WINDOW && index + ahead < lines.length; ahead++) {
          const continuation = lines[index + ahead].match(ARGUMENT_CONTINUATION);
          if (continuation) { type = continuation[2]; span = 'multiline'; break; }
          if (!/^\s*$/.test(lines[index + ahead]) && !/^\s*["'`A-Za-z_$]/.test(lines[index + ahead])) break;
        }
      }
      if (!type) {
        refuse(index + 1, direction,
          'capability_type_argument_not_literal',
          `a \`capabilities.${member}(\` call whose TYPE argument is not a string literal names no groundable capability; the value is decided at run time (a constant or a parameter) and is not derivable from bytes on disk`,
          'capability_type_argument');
      } else if (!owner) {
        refuse(index + 1, direction,
          'owning_plugin_not_derivable_from_path',
          `src/substrate/capabilityRegistry.mjs:37 records the PROVIDING plugin as \`pluginName\`, and '${estatePath}' has no 'plugins/<owner>/' segment, so the plugin this ${direction} belongs to is not derivable`,
          'estate_relative_path');
      } else {
        const guarded = SINGLE_LINE_NULL_GUARD.test(line);
        facts.push(ctx.fact('capability_flow', index + 1, {
          capability_type: type, direction, idiom: direction === 'provide' ? 'capabilities_provide' : 'capabilities_require',
          source: 'code', owner, version, arguments_span: span,
          ...(direction === 'require' ? { binding: guarded ? 'try_catch_null' : 'unguarded' } : {}),
        }));
      }
      const binding = line.match(CAPABILITY_BINDING);
      if (binding) bindings.set(binding[1], { type: binding[3], line: index + 1 });
      continue;
    }

    if (ORPHAN_REQUEST.test(line)) {
      if (!capabilitySurfaceInFile) continue;
      refuse(index + 1, 'call',
        'capability_call_receiver_not_on_this_line',
        'a `.request(` continuation whose receiver sits on an earlier line names no receiver this line-oriented reader can bind to a capability type',
        'request_call_receiver');
      continue;
    }
    const call = line.match(REQUEST_CALL);
    if (!call) continue;
    const receiver = call[1];
    const bound = bindings.get(receiver);
    if (!bound) {
      // No `capabilities.provide(`/`.require(` anywhere in this file: this `.request(`
      // is some other library's method and there is no capability to refuse about.
      if (!capabilitySurfaceInFile) continue;
      refuse(index + 1, 'call',
        'capability_call_receiver_not_bound_to_a_required_capability',
        `receiver '${receiver}' is not bound in this file to a literal \`capabilities.require("<type>", …)\` result, so the capability this \`request(\` reaches is not derivable; it may be a handle returned by a helper, an unrelated object with a request method, or a capability required in another module`,
        'request_call_receiver');
      continue;
    }
    if (!owner) {
      refuse(index + 1, 'call',
        'owning_plugin_not_derivable_from_path',
        `'${estatePath}' has no 'plugins/<owner>/' segment, so the plugin making this call is not derivable`,
        'estate_relative_path');
      continue;
    }
    facts.push(ctx.fact('capability_flow', index + 1, {
      capability_type: bound.type, direction: 'call', idiom: 'capability_request_call',
      source: 'code', owner, receiver, bound_at_line: bound.line,
    }));
  }
  return facts;
}

export default {
  kind: 'capability_flow',
  filePattern: /(?:\.[cm]?[jt]sx?|(?:^|\/)plugin\.ya?ml)$/i,
  scan(lines, ctx) {
    return isPluginManifest(ctx.file) ? scanManifest(lines, ctx) : scanCode(lines, ctx);
  },
};
