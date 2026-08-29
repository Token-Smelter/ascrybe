// HTTP-SURFACE extractor.
//
// Three idiom families, each found by reading the REAL registration sites on
// this branch before the pattern was written:
//
//   aspnet            `[Route("...")]` + `[HttpGet]`/`[HttpPost]`… attributes
//                     (test/fixtures/estate-map/mini-estate/order-api/
//                     Controllers/OrdersController.cs:6,:9)
//   express/fastify   `app|router|fastify.get|post|put|delete|patch('...')`
//                     (test/fixtures/estate-map/mini-estate/node-gateway/
//                     index.js:4,:5)
//   host-runtime-plugin  `context.http.route(METHOD, path, { auth }, handler)` —
//                     THIS ESTATE'S OWN IDIOM, 143 real sites, e.g.
//                     plugins/fault-watch/server/query.mjs:138-142 and
//                     plugins/session-notes/server/index.mjs:758.
//
// WHY THE PLUGIN IDIOM WAS ADDED (instrument defect I2, acceptance-test-report
// §5). Before it existed this extractor recognised only the first two
// families, and the ONLY route nodes in the whole estate graph were the five
// mini-estate test fixtures above — every real HTTP surface was missing while
// fixtures were presented as the answer. A reviewer asking the map an HTTP
// question got a confidently wrong answer, which is worse than an empty one.
//
// THE MOUNT PREFIX IS DERIVED, NOT ASSUMED. `context.http.route` does NOT
// register the path it is given: src/runtime/plugin-context.mjs:367-369
// registers `/api/plugins/${name}${path}`, where `name` is the plugin the
// context belongs to. That prefix is reconstructed HERE from the owning
// directory (`.../plugins/<owner>/...`), and the fact records BOTH the
// declared path and the reconstructed full path plus the basis
// (`plugin_directory_name`) so a reader can see which part is quoted and which
// part is derived.
//
// REFUSALS, NOT GUESSES. A `.http.route(` call whose METHOD or PATH is not a
// string literal (a variable, a template literal, a concatenation) is not
// groundable to a route, and a call under no `plugins/<owner>/` directory has
// no derivable mount prefix. Neither is skipped silently: each emits an
// `http_route_refusal` fact naming exactly what could not be determined, and
// merge.mjs carries them in `graph.route_refusals`.
//
// AUTH IS READ WHERE DECLARED, REFUSED WHERE NOT. `{ auth: "required" }` /
// `{ auth: "open" }` is the estate's real marker (scripts/check-plugin-route-auth.mjs
// enforces its presence). When the options object is absent or its `auth` is
// not a literal, `auth` is null and `auth_basis` says why, rather than
// defaulting to a value the source never states.

function joinRoute(a='',b='') { const route=`/${[a,b].filter(Boolean).join('/')}`.replace(/\/+/, '/').replace(/\/$/,''); return route||'/'; }

// `context.http.route("GET", "/health", { auth: "required" }, handler)`. The
// receiver is deliberately loose (`context.http`, `ctx.http`, a destructured
// `http`) because the estate writes all three; what makes it a route is the
// `.route(` call with a literal METHOD then a literal PATH.
// The options object is captured only when it is followed by the handler
// argument, so a call site whose options contain a nested object or a call
// (`{ auth: authFor(name) }`) is still recognised as HAVING options — the
// alternative reads as `no_options_object`, which would be a false statement
// about the source rather than an honest "could not determine".
const PLUGIN_ROUTE=/\bhttp\s*\.\s*route\s*\(\s*(["'])([A-Za-z]+)\1\s*,\s*(["'])([^"'`]*)\3\s*(?:,\s*(\{.*?\})\s*,)?/;
// Any `.http.route(` call at all — used to DETECT the sites the literal
// pattern above could not ground, so they become refusals rather than silence.
const PLUGIN_ROUTE_CALL=/\bhttp\s*\.\s*route\s*\(/;
const AUTH_MARKER=/\bauth\s*:\s*(["'])([A-Za-z_]+)\1/;
const COMMENT_LINE=/^\s*(?:\/\/|\/\*|\*)/;
const HTTP_METHODS=new Set(['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS']);
// F7 (orientation-test-report.md §7.2). The route fact above SYNTHESIZES
// `mount_prefix` and stamps `mount_basis:'plugin_directory_name'` — correctly,
// but with NO witness site, so on Q14 the map had the right mechanism and could
// not cite it, and the citation rule dropped it a band. "Any synthesized field
// should carry the `file:line` that justifies it."
//
// This pattern finds the site that PRODUCES the prefix at run time —
// src/runtime/plugin-context.mjs:368, `` `/api/plugins/${name}${…}` `` — and
// emits it as its own fact. merge.mjs joins it onto every route node carrying a
// `mount_basis`, so the derived half of a route becomes citable.
const MOUNT_PREFIX_PRODUCER=/`(\/api\/plugins\/)\$\{/;

/**
 * The plugin that owns a file, from its ESTATE-RELATIVE path: the segment
 * directly after the LAST `plugins` segment. `plugins/session-notes/server/index.mjs`
 * -> `session-notes`; `test-fixtures/plugins/test-plugin/server/index.mjs`
 * -> `test-plugin`. A path with no `plugins` segment yields null, which is a
 * refusal rather than a guess.
 */
export function pluginOwnerFromPath(estatePath) {
  const segments=String(estatePath||'').split('/').filter(Boolean);
  for(let index=segments.length-2;index>=0;index--)if(segments[index]==='plugins'){
    const owner=segments[index+1];
    return owner&&owner!=='..'?owner:null;
  }
  return null;
}

/** The path src/runtime/plugin-context.mjs:368 actually registers for `owner`. */
export const pluginMountPrefix=owner=>`/api/plugins/${owner}`;
export const pluginFullRoute=(owner,declared)=>`${pluginMountPrefix(owner)}${declared.startsWith('/')?declared:`/${declared}`}`.replace(/\/$/,'')||pluginMountPrefix(owner);

/**
 * One route fact shape for every framework.
 *
 * Identity candidacy requires `declared_route` and `owner`, and for a long time only one
 * framework's idiom set them -- so routes from every other framework were extracted and then
 * refused as `route_declaration_unwitnessed`, leaving an estate that uses none of that framework
 * with no Route entities at all. A route is owned by whatever component declares it; when nothing
 * finer is derivable that is the repository, and saying so is a basis rather than a guess.
 */
export function routeFact({ method, declared, framework, ctx, owner = null, owner_basis = null,
  mount_prefix = null, mount_basis = null, extra = {} }) {
  const path = String(declared || '').startsWith('/') ? declared : `/${declared || ''}`;
  return {
    method,
    route: mount_prefix ? `${mount_prefix}${path}`.replace(/\/$/u, '') || mount_prefix : path,
    declared_route: path,
    owner: owner || ctx.repo,
    // How the owner was decided, so a component-scoped owner is never mistaken for a declared one.
    owner_basis: owner_basis || 'repository',
    ...(mount_prefix ? { mount_prefix, mount_basis } : {}),
    framework,
    ...extra,
  };
}

/**
 * A call site's target, split into the parts a route can be matched on.
 *
 * An absolute URL names a host the caller does not own; a relative one names a path within
 * whatever base the caller was configured with. Both carry the path, which is what a registered
 * route can be compared against -- the host is recorded and never used to match, because the base
 * URL is usually assembled at run time and guessing it would manufacture edges.
 */
export function clientTarget(urlOrPath) {
  const held = String(urlOrPath || '');
  const absolute = /^https?:\/\//iu.test(held);
  if (!absolute) return { path: held.startsWith('/') ? held : `/${held}`, host: null, target_basis: 'relative_literal' };
  try {
    const parsed = new URL(held);
    return { path: parsed.pathname || '/', host: parsed.host, target_basis: 'absolute_literal' };
  } catch {
    return { path: null, host: null, target_basis: 'unparsable_url' };
  }
}


// IDIOMS BELOW WERE READ FROM REAL CALL SITES BEFORE BEING WRITTEN, for the reason the header
// gives: a guessed pattern produces a confidently empty map. Each notes the shape it was taken
// from. Paths that are not string literals are refused rather than guessed, exactly as the plugin
// idiom refuses a non-literal route.

const PY_ROUTE = /@(?:\w+)\.(get|post|put|delete|patch|route)\s*\(\s*(['"])([^'"]+)\2([^)]*)\)/i;
const PY_ROUTE_METHODS = /methods\s*=\s*\[([^\]]*)\]/i;
const PY_CLIENT = /\b(?:requests|httpx|session|client)\.(get|post|put|delete|patch)\s*\(\s*(?:url\s*=\s*)?(['"])((?:https?:\/\/|\/)[^'"]*)\2/i;
// Real Python passes a name, not a literal: `requests.get(url, headers=...)`. The name is almost
// always assigned a few lines above from an f-string whose leading interpolation is a base and
// whose remainder is the path -- and whose own interpolations are already template-shaped, so
// `f"{self.base_url}/projects/{project_id}"` yields `/projects/{project_id}` and can meet the
// parameterised route that serves it.
const PY_CLIENT_VAR = /\b(?:requests|httpx|session|client)\.(get|post|put|delete|patch)\s*\(\s*(?:url\s*=\s*)?([A-Za-z_]\w*)\s*[,)]/i;
const PY_ASSIGN = name => new RegExp(`^\\s*${name}\\s*=\\s*f?(['"])(.*)\\1\\s*$`, 'u');
const PY_ASSIGN_WINDOW = 15;

/**
 * The path a name was assigned within a bounded window above its use, or null.
 *
 * Bounded because an unbounded search crosses function boundaries and would resolve a name to an
 * assignment that never reaches the call. Two different assignments in the window are not a
 * tie-break to guess at -- the value is genuinely undecided from bytes, and the call is refused.
 */
export function pythonAssignedPath(lines, index, name) {
  const pattern = PY_ASSIGN(name);
  const found = [];
  for (let above = index - 1; above >= 0 && above >= index - PY_ASSIGN_WINDOW; above -= 1) {
    const held = pattern.exec(lines[above]);
    if (!held) continue;
    // Strip a leading interpolated base: what remains is this call's own path.
    const path = held[2].replace(/^\{[^}]*\}/u, '');
    if (path.startsWith('/')) found.push({ path, line: above + 1 });
  }
  const distinct = [...new Set(found.map(entry => entry.path))];
  if (distinct.length !== 1) return distinct.length ? { refusal: 'assigned_path_ambiguous' } : null;
  // `f"{base}/{p}"` resolves to `/{p}` -- every segment interpolated, no literal anywhere. That is
  // not an address; it matches any single-segment route and would bind a caller to whichever
  // service happened to be scored highest. A path must say at least one thing about itself.
  if (!/\/[^/{}]*[A-Za-z0-9][^/{}]*/u.test(distinct[0].replace(/\{[^}]*\}/gu, ''))) {
    return { refusal: 'assigned_path_entirely_interpolated' };
  }
  return found[0];
}

/** Flask and FastAPI decorators, plus `requests`/`httpx` call sites. */
function scanPython(lines, ctx) {
  const facts = [];
  lines.forEach((line, index) => {
    const route = PY_ROUTE.exec(line);
    if (route) {
      const verb = route[1].toLowerCase();
      const declared = route[3];
      // `@app.route` states its methods in an argument; `@app.get` states one in its name. A
      // `route(...)` with no methods list defaults to GET in both frameworks, which is the
      // framework's own documented default rather than an assumption made here.
      const listed = PY_ROUTE_METHODS.exec(route[4] || '');
      const methods = verb === 'route'
        ? (listed ? listed[1].split(',').map(m => m.replace(/['"\s]/gu, '').toUpperCase()).filter(Boolean) : ['GET'])
        : [verb.toUpperCase()];
      for (const method of methods) {
        if (!HTTP_METHODS.has(method)) continue;
        facts.push(ctx.fact('http_route', index + 1, routeFact({ method, declared, framework: 'python-decorator', ctx })));
      }
    }
    const call = PY_CLIENT.exec(line);
    if (call) {
      facts.push(ctx.fact('http_client', index + 1, { url_or_path: call[3], method: call[1].toUpperCase(),
        caller: ctx.repo, ...clientTarget(call[3]) }));
      return;
    }
    const named = PY_CLIENT_VAR.exec(line);
    if (named) {
      const assigned = pythonAssignedPath(lines, index, named[2]);
      if (assigned?.path) {
        facts.push(ctx.fact('http_client', index + 1, { url_or_path: assigned.path,
          method: named[1].toUpperCase(), caller: ctx.repo, client_idiom: 'python_local_assignment',
          path_assigned_at_line: assigned.line, ...clientTarget(assigned.path),
          target_basis: 'local_assignment_resolved' }));
      } else {
        facts.push(ctx.fact('http_client_refusal', index + 1, {
          reason: assigned?.refusal ?? 'assigned_path_not_found',
          reason_detail: `\`${named[2]}\` is not assigned a literal path within ${PY_ASSIGN_WINDOW} lines above this call, so the address is decided elsewhere and is not derivable from bytes on disk`,
          examined: 'local_assignment', method: named[1].toUpperCase(), caller: ctx.repo }));
      }
    }
  });
  return facts;
}

const KT_RETROFIT = /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"\s*\)/;
// Real Retrofit interfaces name a constant far more often than a literal: every one of this
// domain's 318 annotations reads `@GET(ApiRoutes.Worlds.WORLDS)`. Refusing them all would be
// correct and useless, so the reference is recorded as a reference and the constant it names is
// recorded where it is declared. Joining the two is merge's job, not a per-file guess.
const KT_RETROFIT_CONST = /@(GET|POST|PUT|DELETE|PATCH)\s*\(\s*([A-Z][\w.]*)\s*\)/;
const KT_OBJECT = /^\s*(?:private\s+|internal\s+)?object\s+(\w+)\s*\{/;
const KT_CONST = /^\s*(?:private\s+|internal\s+)?const\s+val\s+(\w+)\s*(?::[^=]+)?=\s*"([^"]*)"/;
const KT_OKHTTP_URL = /\.url\s*\(\s*"((?:https?:\/\/|\/)[^"]*)"\s*\)/;

/**
 * Retrofit interface annotations and OkHttp request builders.
 *
 * A Retrofit annotation is the richest consumption fact available anywhere in this extractor: it
 * states the method and the path together, declaratively, at a site that cannot be anything but a
 * call. A Retrofit path is conventionally relative with no leading slash.
 */
function scanKotlin(lines, ctx) {
  const facts = [];
  // Object nesting gives a constant its qualified name, which is what a reference cites.
  const scope = [];
  let depth = 0;
  lines.forEach((line, index) => {
    const object = KT_OBJECT.exec(line);
    if (object) scope.push({ name: object[1], depth });
    const constant = KT_CONST.exec(line);
    if (constant) {
      facts.push(ctx.fact('string_constant', index + 1, {
        qualified_name: [...scope.map(entry => entry.name), constant[1]].join('.'),
        name: constant[1], value: constant[2], language: 'kotlin',
      }));
    }
    depth += (line.match(/\{/gu) || []).length - (line.match(/\}/gu) || []).length;
    while (scope.length && depth <= scope.at(-1).depth) scope.pop();

    const reference = KT_RETROFIT_CONST.exec(line);
    if (reference && !KT_RETROFIT.test(line)) {
      facts.push(ctx.fact('http_client', index + 1, { url_or_path: null, method: reference[1].toUpperCase(),
        caller: ctx.repo, client_idiom: 'retrofit_annotation',
        // Named, not resolved: the value is declared in another file and substituting a guess here
        // would invent a path. `path_basis` says the address is pending, never that it is absent.
        path_constant: reference[2], path: null, host: null, target_basis: 'constant_reference' }));
    }
    const retrofit = KT_RETROFIT.exec(line);
    if (retrofit) {
      const path = retrofit[2].startsWith('/') ? retrofit[2] : `/${retrofit[2]}`;
      facts.push(ctx.fact('http_client', index + 1, { url_or_path: path, method: retrofit[1].toUpperCase(),
        caller: ctx.repo, client_idiom: 'retrofit_annotation', ...clientTarget(path) }));
    }
    const buildConfig = GRADLE_BUILD_CONFIG_URL.exec(line);
    if (buildConfig) {
      facts.push(ctx.fact('config_value_url', index + 1, { key: buildConfig[1], url: buildConfig[2] }));
    }
    const okhttp = KT_OKHTTP_URL.exec(line);
    if (okhttp) {
      // A builder states its URL but not its verb; the verb is a separate call on the builder and
      // is not derivable from this line, so it stays null rather than defaulting to GET.
      facts.push(ctx.fact('http_client', index + 1, { url_or_path: okhttp[1], method: null,
        caller: ctx.repo, client_idiom: 'okhttp_builder', ...clientTarget(okhttp[1]) }));
    }
  });
  return facts;
}

// A Gradle build declares the base URL its client is compiled against:
//     buildConfigField("String", "BASE_URL", "\"https://api.example.invalid\"")
// Without it every call site in the app is a bare path with nothing to say WHICH service it
// addresses, and the matcher discards unhinted candidates rather than binding a path to an
// unrelated route. The declaration is a literal in a tracked file, so it is quoted, not inferred.
const GRADLE_BUILD_CONFIG_URL = /buildConfigField\s*\(\s*"String"\s*,\s*"(\w+)"\s*,\s*"\\?"(https?:\/\/[^"\\]+)\\?""/;

const SWIFT_URL = /URL\s*\(\s*string:\s*"((?:https?:\/\/|\/)[^"]*)"\s*\)/;
// A Swift router type is the same declaration Retrofit makes, spelled as an enum: one switch maps
// each case to its path and another maps it to its method. Neither switch alone is a call; paired
// by case name they are exactly one, which is why they are read together rather than as literals.
// A client declares the service it addresses by naming it: `apiBaseUrlString: "https://..."`.
// Without that, every path the router builds is a bare path with nothing saying WHICH service it
// belongs to, and the matcher discards unhinted candidates rather than guessing. The declaration
// is a literal in a tracked file, so it is quoted like any other.
const SWIFT_NAMED_URL = /\b(\w*[Uu]rl\w*)\s*[:=]\s*"(https?:\/\/[^"]+)"/;

const SWIFT_PROPERTY = /\bvar\s+(path|method)\s*:/;
const SWIFT_CASE = /^\s*case\s+\.(\w+)/;
const SWIFT_RETURN_PATH = /^\s*return\s+"([^"]*)"/;
const SWIFT_RETURN_METHOD = /^\s*return\s+\.(\w+)/;

/**
 * Case-to-path and case-to-method switches, joined by case name.
 *
 * Swift interpolation is normalised to a path template -- `\(worldId)` becomes `{worldId}` -- so a
 * parameterised client path can meet the parameterised route that serves it. The substitution is
 * shape-preserving and names the variable it came from, so nothing is invented.
 */
export function scanSwiftRouter(lines, ctx) {
  const byCase = new Map();
  let property = null;
  let current = null;
  lines.forEach((line, index) => {
    const declared = SWIFT_PROPERTY.exec(line);
    if (declared) { property = declared[1]; current = null; return; }
    if (!property) return;
    const held = SWIFT_CASE.exec(line);
    if (held) { current = held[1]; return; }
    if (!current) return;
    if (property === 'path') {
      const path = SWIFT_RETURN_PATH.exec(line);
      if (path) {
        const template = path[1].replace(/\\\((\w+)\)/gu, '{$1}');
        byCase.set(current, { ...(byCase.get(current) || {}), path: template.startsWith('/') ? template : `/${template}`, line: index + 1 });
        current = null;
      }
      return;
    }
    const method = SWIFT_RETURN_METHOD.exec(line);
    if (method && HTTP_METHODS.has(method[1].toUpperCase())) {
      byCase.set(current, { ...(byCase.get(current) || {}), method: method[1].toUpperCase() });
      current = null;
    }
  });
  const facts = [];
  for (const [name, held] of byCase) {
    if (!held.path) continue;
    facts.push(ctx.fact('http_client', held.line, { url_or_path: held.path, method: held.method ?? null,
      caller: ctx.repo, client_idiom: 'swift_router_case', router_case: name, ...clientTarget(held.path) }));
  }
  return facts;
}

/** URLSession request construction. The verb is set on the request separately, so it stays null. */
function scanSwift(lines, ctx) {
  const facts = scanSwiftRouter(lines, ctx);
  lines.forEach((line, index) => {
    const named = SWIFT_NAMED_URL.exec(line);
    if (named) facts.push(ctx.fact('config_value_url', index + 1, { key: named[1], url: named[2] }));
  });
  lines.forEach((line, index) => {
    const url = SWIFT_URL.exec(line);
    if (url) {
      facts.push(ctx.fact('http_client', index + 1, { url_or_path: url[1], method: null,
        caller: ctx.repo, client_idiom: 'swift_url_string', ...clientTarget(url[1]) }));
    }
  });
  return facts;
}

// WHICH HOST A REPOSITORY SERVES is declared by whatever provisions its domain, and until it is
// extracted the only way to connect a caller's base URL to the service it addresses is guessing
// from repository names. That guess cannot work in general: `sw-api` tokenizes to nothing at all,
// because two-letter and common words are dropped, so no hint could ever score against it. A
// declared domain is quoted evidence and needs no guess.
const DECLARED_DOMAIN = /\bdomainName\s*:\s*['"]([a-z0-9][a-z0-9.-]*\.[a-z]{2,})['"]/i;

const CDK_ADD_ROUTES = /\.addRoutes\s*\(\s*\{/;
const CDK_PATH = /\bpath\s*:\s*['"]([^'"]+)['"]/;
const CDK_METHODS = /\bmethods\s*:\s*\[([^\]]*)\]/;
const CDK_LOOKAHEAD = 10;

/**
 * AWS CDK HTTP API route registration, which spans several lines:
 *
 *     httpApi.addRoutes({ authorizer, path: '/x', methods: [apiGateway.HttpMethod.GET] })
 *
 * A bounded lookahead reads the object's own literal fields. A registration whose path is not a
 * literal within that window is refused by name, because the value is assembled elsewhere and
 * guessing it would invent a route.
 */
function scanCdkRoutes(lines, index, ctx) {
  const window = lines.slice(index, index + CDK_LOOKAHEAD).join('\n');
  const path = CDK_PATH.exec(window);
  if (!path) {
    return [ctx.fact('http_route_refusal', index + 1, { framework: 'aws-cdk-httpapi',
      reason: 'route_path_not_literal',
      reason_detail: `no literal \`path:\` appeared within ${CDK_LOOKAHEAD} lines of this addRoutes call, so the registered path is assembled elsewhere and is not derivable from bytes on disk`,
      examined: 'addRoutes_object_literal' })];
  }
  const methods = CDK_METHODS.exec(window);
  const named = methods ? [...methods[1].matchAll(/([A-Z]+)/gu)].map(m => m[1]).filter(m => HTTP_METHODS.has(m)) : [];
  if (!named.length) {
    return [ctx.fact('http_route_refusal', index + 1, { framework: 'aws-cdk-httpapi',
      reason: 'route_methods_not_literal',
      reason_detail: `the literal path '${path[1]}' was found but no literal HTTP method accompanied it`,
      examined: 'methods_array' })];
  }
  return named.map(method => ctx.fact('http_route', index + 1,
    routeFact({ method, declared: path[1], framework: 'aws-cdk-httpapi', ctx })));
}

export default { kind:'http_route', filePattern:/\.(?:cs|py|swift|kts?|[cm]?[jt]sx?)$/i, scan(lines,ctx) {
  const facts=[];
  const estatePath=`${ctx.repo}/${ctx.file}`;
  if (/\.py$/i.test(ctx.file)) return scanPython(lines,ctx);
  if (/\.kts?$/i.test(ctx.file)) return scanKotlin(lines,ctx);
  if (/\.swift$/i.test(ctx.file)) return scanSwift(lines,ctx);
  if (ctx.file.endsWith('.cs')) {
    let classRoute='', pendingRoute='', controller='';
    for (let i=0;i<lines.length;i++) {
      const route=lines[i].match(/\[Route\("([^"]+)"\)\]/); if (route) pendingRoute=route[1];
      const klass=lines[i].match(/class\s+(\w+)Controller\b/); if (klass) { controller=klass[1]; classRoute=pendingRoute.replace(/\[controller\]/ig,controller); pendingRoute=''; }
      const verb=lines[i].match(/\[Http(Get|Post|Put|Delete|Patch)(?:\("([^"]*)"\))?\]/i);
      if (verb) facts.push(ctx.fact('http_route',i+1,routeFact({method:verb[1].toUpperCase(),declared:joinRoute(classRoute,verb[2]||''),framework:'aspnet',ctx})));
      const base=lines[i].match(/BaseAddress\s*=\s*new\s+Uri\("([^"]+)"\)/); if (base) facts.push(ctx.fact('http_client',i+1,{url_or_path:base[1],client_action:'base',method:null,caller:ctx.repo,...clientTarget(base[1])}));
      const call=lines[i].match(/\.(GetAsync|PostAsync|PutAsync|DeleteAsync)\s*\(\s*"([^"]+)"/); if (call) facts.push(ctx.fact('http_client',i+1,{url_or_path:call[2],method:call[1].replace('Async','').toUpperCase(),caller:ctx.repo,...clientTarget(call[2])}));
    }
  } else {
    for (let i=0;i<lines.length;i++) {
      let m=lines[i].match(/\b(?:app|router|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/i); if (m) facts.push(ctx.fact('http_route',i+1,routeFact({method:m[1].toUpperCase(),declared:m[2],framework:lines[i].includes('fastify')?'fastify':'express',ctx})));
      m=lines[i].match(/\b(?:fetch|axios(?:\.(get|post|put|delete|patch))?)\s*\(\s*([`'"])(https?:\/\/[^`'"]+|\/[^`'"]+)\2/i);
      if (m) facts.push(ctx.fact('http_client',i+1,{url_or_path:m[3],
        // `axios.get` states its method; bare `fetch` does not, and guessing GET would invent a
        // match against a route that only answers POST.
        method:m[1]?m[1].toUpperCase():null,
        caller:ctx.repo,
        ...clientTarget(m[3])}));
      m=lines[i].match(/fastify\.route\s*\(\s*\{.*method\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"].*url\s*:\s*['"]([^'"]+)/i); if (m) facts.push(ctx.fact('http_route',i+1,routeFact({method:m[1],declared:m[2],framework:'fastify',ctx})));
      const domain=DECLARED_DOMAIN.exec(lines[i]);
      if (domain) facts.push(ctx.fact('service_hostname',i+1,{host:domain[1].toLowerCase(),basis:'declared_domain_name'}));
      if (CDK_ADD_ROUTES.test(lines[i])) facts.push(...scanCdkRoutes(lines,i,ctx));
      if (COMMENT_LINE.test(lines[i])) continue;
      const producer=lines[i].match(MOUNT_PREFIX_PRODUCER);
      if (producer) facts.push(ctx.fact('derived_value_producer',i+1,{
        derived_field:'mount_prefix',
        basis:'plugin_directory_name',
        literal_prefix:producer[1],
        // The producing EXPRESSION, quoted, so the witness can be checked
        // without re-opening the file. It is not evaluated.
        expression:lines[i].trim().slice(0,200),
      }));
      if (!PLUGIN_ROUTE_CALL.test(lines[i])) continue;
      facts.push(...scanPluginRoute(lines[i],i+1,estatePath,ctx));
    }
  }
  return facts;
}};

function scanPluginRoute(line,lineNumber,estatePath,ctx) {
  const owner=pluginOwnerFromPath(estatePath);
  const match=line.match(PLUGIN_ROUTE);
  const refuse=(reason,detail,examined)=>[ctx.fact('http_route_refusal',lineNumber,{framework:'host-runtime-plugin',reason,reason_detail:detail,examined})];
  if(!match)return refuse('route_arguments_not_literal',
    'a `.http.route(` call whose METHOD and PATH are not both string literals names no groundable route; the value is decided at run time and is not derivable from bytes on disk',
    'method_and_path_arguments');
  const method=match[2].toUpperCase();
  if(!HTTP_METHODS.has(method))return refuse('method_not_an_http_method',
    `the first argument is the literal '${match[2]}', which is not one of ${[...HTTP_METHODS].sort().join(', ')}`,
    'method_argument');
  const declared=match[4].startsWith('/')?match[4]:`/${match[4]}`;
  const options=match[5]||'';
  const auth=options.match(AUTH_MARKER);
  if(!owner)return refuse('owning_plugin_not_derivable_from_path',
    `src/runtime/plugin-context.mjs registers this route under /api/plugins/<plugin>, and '${estatePath}' has no 'plugins/<owner>/' segment, so the mounted path is not derivable`,
    'estate_relative_path');
  // The mount is RECONSTRUCTED from the directory name, not quoted from this line; naming the
  // basis keeps the derived half distinguishable from the quoted half.
  return [ctx.fact('http_route',lineNumber,routeFact({
    method, declared, framework:'host-runtime-plugin', ctx,
    owner, owner_basis:'plugin_directory_name',
    mount_prefix:pluginMountPrefix(owner), mount_basis:'plugin_directory_name',
    extra:{
      auth:auth?auth[2]:null,
      auth_basis:auth?'declared_options_literal':options?'options_object_without_literal_auth':'no_options_object',
    },
  }))];
}
