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
//                     plugins/failure-observatory/server/query.mjs:138-142 and
//                     plugins/episodic-memory/server/index.mjs:758.
//
// WHY THE PLUGIN IDIOM WAS ADDED (instrument defect I2, acceptance-test-report
// §5). Before it existed this extractor recognised only the first two
// families, and the ONLY route nodes in the whole estate graph were the five
// mini-estate test fixtures above — every real HTTP surface was missing while
// fixtures were presented as the answer. A reviewer asking the map an HTTP
// question got a confidently wrong answer, which is worse than an empty one.
//
// THE MOUNT PREFIX IS DERIVED, NOT ASSUMED. `context.http.route` does NOT
// register the path it is given: src/substrate/pluginContext.mjs:367-369
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
// src/substrate/pluginContext.mjs:368, `` `/api/plugins/${name}${…}` `` — and
// emits it as its own fact. merge.mjs joins it onto every route node carrying a
// `mount_basis`, so the derived half of a route becomes citable.
const MOUNT_PREFIX_PRODUCER=/`(\/api\/plugins\/)\$\{/;

/**
 * The plugin that owns a file, from its ESTATE-RELATIVE path: the segment
 * directly after the LAST `plugins` segment. `plugins/episodic-memory/server/index.mjs`
 * -> `episodic-memory`; `test-fixtures/plugins/test-plugin/server/index.mjs`
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

/** The path src/substrate/pluginContext.mjs:368 actually registers for `owner`. */
export const pluginMountPrefix=owner=>`/api/plugins/${owner}`;
export const pluginFullRoute=(owner,declared)=>`${pluginMountPrefix(owner)}${declared.startsWith('/')?declared:`/${declared}`}`.replace(/\/$/,'')||pluginMountPrefix(owner);

export default { kind:'http_route', filePattern:/\.(?:cs|[cm]?[jt]sx?)$/i, scan(lines,ctx) {
  const facts=[];
  const estatePath=`${ctx.repo}/${ctx.file}`;
  if (ctx.file.endsWith('.cs')) {
    let classRoute='', pendingRoute='', controller='';
    for (let i=0;i<lines.length;i++) {
      const route=lines[i].match(/\[Route\("([^"]+)"\)\]/); if (route) pendingRoute=route[1];
      const klass=lines[i].match(/class\s+(\w+)Controller\b/); if (klass) { controller=klass[1]; classRoute=pendingRoute.replace(/\[controller\]/ig,controller); pendingRoute=''; }
      const verb=lines[i].match(/\[Http(Get|Post|Put|Delete|Patch)(?:\("([^"]*)"\))?\]/i);
      if (verb) facts.push(ctx.fact('http_route',i+1,{method:verb[1].toUpperCase(),route:joinRoute(classRoute,verb[2]||''),framework:'aspnet'}));
      const base=lines[i].match(/BaseAddress\s*=\s*new\s+Uri\("([^"]+)"\)/); if (base) facts.push(ctx.fact('http_client',i+1,{url_or_path:base[1],client_action:'base'}));
      const call=lines[i].match(/\.(GetAsync|PostAsync|PutAsync|DeleteAsync)\s*\(\s*"([^"]+)"/); if (call) facts.push(ctx.fact('http_client',i+1,{url_or_path:call[2],method:call[1].replace('Async','').toUpperCase()}));
    }
  } else {
    for (let i=0;i<lines.length;i++) {
      let m=lines[i].match(/\b(?:app|router|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/i); if (m) facts.push(ctx.fact('http_route',i+1,{method:m[1].toUpperCase(),route:m[2],framework:lines[i].includes('fastify')?'fastify':'express'}));
      m=lines[i].match(/\b(?:fetch|axios(?:\.(?:get|post|put|delete|patch))?)\s*\(\s*([`'"])(https?:\/\/[^`'"]+|\/[^`'"]+)\1/i); if (m) facts.push(ctx.fact('http_client',i+1,{url_or_path:m[2]}));
      m=lines[i].match(/fastify\.route\s*\(\s*\{.*method\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"].*url\s*:\s*['"]([^'"]+)/i); if (m) facts.push(ctx.fact('http_route',i+1,{method:m[1],route:m[2],framework:'fastify'}));
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
    `src/substrate/pluginContext.mjs registers this route under /api/plugins/<plugin>, and '${estatePath}' has no 'plugins/<owner>/' segment, so the mounted path is not derivable`,
    'estate_relative_path');
  return [ctx.fact('http_route',lineNumber,{
    method,
    route:pluginFullRoute(owner,declared),
    declared_route:declared,
    mount_prefix:pluginMountPrefix(owner),
    // The mount is RECONSTRUCTED from the directory name, not quoted from this
    // line; naming the basis keeps the derived half distinguishable from the
    // quoted half.
    mount_basis:'plugin_directory_name',
    owner,
    framework:'host-runtime-plugin',
    auth:auth?auth[2]:null,
    auth_basis:auth?'declared_options_literal':options?'options_object_without_literal_auth':'no_options_object',
  })];
}
