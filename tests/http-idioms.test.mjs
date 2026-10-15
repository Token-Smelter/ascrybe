import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import extractor from '../tools/extractors/http.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { mergeFacts } from '../tools/merge.mjs';

// Every fixture here is invented. The idioms were read from real code before being written --
// which is the only way any of them match anything -- but a public test cannot carry the estate it
// learned from, so these say the same shapes about a service that does not exist.

const scan = (repo, file, source) => extractor.scan(source.split('\n'),
  { repo, file, fact: (kind, line, data) => ({ kind, repo, file, line, ...data }) });
const kinds = (facts, kind) => facts.filter(fact => fact.kind === kind);

test('a CDK registration spanning several lines yields its routes, and refuses a computed path', () => {
  const facts = scan('orders-api', 'lib/stack.ts', [
    "const api = new apiGateway.HttpApi(this, 'Api', {",
    "  defaultDomainMapping: { domainName: 'api.orders.example.invalid' },",
    '});',
    'api.addRoutes({',
    '  authorizer,',
    "  path: '/orders',",
    '  methods: [apiGateway.HttpMethod.GET, apiGateway.HttpMethod.POST],',
    '});',
    'api.addRoutes({',
    '  path: buildPath(prefix),',
    '  methods: [apiGateway.HttpMethod.GET],',
    '});',
  ].join('\n'));

  const routes = kinds(facts, 'http_route');
  assert.deepEqual(routes.map(route => `${route.method} ${route.declared_route}`).sort(),
    ['GET /orders', 'POST /orders']);
  // Owner must be present or identity candidacy refuses the route outright.
  assert.equal(routes[0].owner, 'orders-api');
  assert.equal(routes[0].owner_basis, 'repository');

  // Which host this repository serves is what lets a caller's base URL find it.
  assert.deepEqual(kinds(facts, 'service_hostname').map(fact => fact.host), ['api.orders.example.invalid']);

  // A path assembled by a function call is not derivable from bytes on disk.
  const refusals = kinds(facts, 'http_route_refusal');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason, 'route_path_not_literal');
});

test('a Retrofit interface naming constants records the reference, not a guess', () => {
  const service = scan('orders-android', 'app/src/ApiService.kt', [
    'interface ApiService {',
    '    @GET(ApiRoutes.Orders.LIST)',
    '    suspend fun orders(): Response<List<Order>>',
    '    @POST("/orders/submit")',
    '    suspend fun submit(): Response<Unit>',
    '}',
  ].join('\n'));
  const calls = kinds(service, 'http_client');
  const byConstant = calls.find(call => call.path_constant);
  assert.equal(byConstant.method, 'GET');
  assert.equal(byConstant.path_constant, 'ApiRoutes.Orders.LIST');
  // Named, not resolved: the value lives in another file and substituting a guess would invent it.
  assert.equal(byConstant.url_or_path, null);
  assert.equal(byConstant.target_basis, 'constant_reference');
  // A literal in the annotation needs no resolution at all.
  const literal = calls.find(call => !call.path_constant);
  assert.equal(literal.path, '/orders/submit');
  assert.equal(literal.method, 'POST');
});

test('Kotlin constants are recorded under the qualified name a reference cites', () => {
  const facts = scan('orders-android', 'app/src/ApiRoutes.kt', [
    'object ApiRoutes {',
    '    object Orders {',
    '        const val LIST = "/orders"',
    '    }',
    '}',
  ].join('\n'));
  assert.deepEqual(kinds(facts, 'string_constant').map(fact => [fact.qualified_name, fact.value]),
    [['ApiRoutes.Orders.LIST', '/orders']]);
});

test('a Gradle build field says which service the client was compiled against', () => {
  const facts = scan('orders-android', 'app/build.gradle.kts',
    '            buildConfigField("String", "BASE_URL", "\\"https://api.orders.example.invalid\\"")');
  assert.deepEqual(kinds(facts, 'config_value_url').map(fact => [fact.key, fact.url]),
    [['BASE_URL', 'https://api.orders.example.invalid']]);
});

test('a Swift router pairs its path switch with its method switch, by case', () => {
  const facts = scan('orders-ios', 'Router.swift', [
    'enum OrdersRouter: URLRequestConvertible {',
    '    var baseURL: URL { Environment.current.apiBaseUrl }',
    '    var path: String {',
    '        switch self {',
    '        case .list:',
    '            return "/orders"',
    '        case .detail(let orderId):',
    '            return "/orders/\\(orderId)/detail"',
    '        }',
    '    }',
    '    var method: HTTPMethod {',
    '        switch self {',
    '        case .list:',
    '            return .get',
    '        case .detail:',
    '            return .post',
    '        }',
    '    }',
    '}',
  ].join('\n'));
  const calls = kinds(facts, 'http_client');
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`).sort(),
    ['GET /orders', 'POST /orders/{orderId}/detail']);
  // Neither switch alone is a call; the method comes from the one this path did not appear in.
  assert.equal(calls.every(call => call.client_idiom === 'swift_router_case'), true);
});

test('a Swift base-URL declaration becomes a hint', () => {
  const facts = scan('orders-ios', 'Environment.swift',
    '        apiBaseUrlString: "https://api.orders.example.invalid",');
  assert.deepEqual(kinds(facts, 'config_value_url').map(fact => fact.url),
    ['https://api.orders.example.invalid']);
});

test('a Python call naming a variable is resolved within a bounded window, or refused by name', () => {
  const resolved = scan('orders-worker', 'worker.py', [
    'def fetch(project_id):',
    '    url = f"{self.base_url}/projects/{project_id}/orders"',
    '    return requests.get(url, headers=headers, timeout=30)',
  ].join('\n'));
  const call = kinds(resolved, 'http_client')[0];
  assert.equal(call.method, 'GET');
  // The f-string's own interpolation is already template-shaped and meets a template route.
  assert.equal(call.path, '/projects/{project_id}/orders');
  assert.equal(call.target_basis, 'local_assignment_resolved');

  // `f"{base}/{p}"` has no literal segment at all. It is not an address: it would match any
  // single-segment route on whichever service scored highest.
  const degenerate = scan('orders-worker', 'w2.py', [
    'def go(p):',
    '    url = f"{base_url}/{p}"',
    '    return requests.get(url)',
  ].join('\n'));
  assert.equal(kinds(degenerate, 'http_client').length, 0);
  assert.equal(kinds(degenerate, 'http_client_refusal')[0].reason, 'assigned_path_entirely_interpolated');

  // An assignment beyond the window belongs to another function and never reaches this call.
  const far = scan('orders-worker', 'w3.py',
    ['    url = "/orders"', ...Array.from({ length: 20 }, () => '    pass'), '    requests.get(url)'].join('\n'));
  assert.equal(kinds(far, 'http_client').length, 0);
  assert.equal(kinds(far, 'http_client_refusal')[0].reason, 'assigned_path_not_found');
});

test('a Flask decorator states its methods, and defaults to GET when it states none', () => {
  const facts = scan('orders-worker', 'app.py', [
    '@app.route("/health")',
    'def health(): pass',
    '@app.route("/orders", methods=["POST", "PUT"])',
    'def orders(): pass',
    '@app.get("/metrics")',
    'def metrics(): pass',
  ].join('\n'));
  assert.deepEqual(kinds(facts, 'http_route').map(route => `${route.method} ${route.declared_route}`).sort(),
    ['GET /health', 'GET /metrics', 'POST /orders', 'PUT /orders']);
});

// The whole point of the above is this: two clients written in different languages, each naming
// its routes in its own idiom, bound to the API that serves them -- across repositories, with
// every link quoted from a tracked file rather than inferred.
// The API repository is deliberately named so that it tokenizes to NOTHING -- `oa` is dropped for
// length and `api` as a common word -- which is the real condition that made name-similarity
// useless: a repository whose name reduces to no tokens can never be hinted, and every one of its
// routes is unreachable by every caller, silently. Only the domain it declares can link them.
test('two clients in different languages resolve to the routes one API declares', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'http-join-'));
  try {
    const estate = join(root, 'estate');
    const write = (path, body) => {
      const target = join(estate, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    };
    write('oa-api/lib/stack.ts', [
      "const api = new apiGateway.HttpApi(this, 'Api', {",
      "  defaultDomainMapping: { domainName: 'api.orders.example.invalid' },",
      '});',
      'api.addRoutes({',
      "  path: '/orders',",
      '  methods: [apiGateway.HttpMethod.GET],',
      '});',
    ].join('\n'));
    write('orders-android/app/src/ApiRoutes.kt',
      ['object ApiRoutes {', '    object Orders {', '        const val LIST = "/orders"', '    }', '}'].join('\n'));
    write('orders-android/app/src/ApiService.kt',
      ['interface ApiService {', '    @GET(ApiRoutes.Orders.LIST)', '    suspend fun orders(): Unit', '}'].join('\n'));
    write('orders-android/app/build.gradle.kts',
      '        buildConfigField("String", "BASE_URL", "\\"https://api.orders.example.invalid\\"")');
    write('orders-ios/Router.swift', [
      'enum OrdersRouter: URLRequestConvertible {',
      '    var path: String {', '        switch self {', '        case .list:', '            return "/orders"',
      '        }', '    }',
      '    var method: HTTPMethod {', '        switch self {', '        case .list:', '            return .get',
      '        }', '    }', '}',
    ].join('\n'));
    write('orders-ios/Environment.swift', '        apiBaseUrlString: "https://api.orders.example.invalid",');

    await extractEstate(estate, join(root, 'extract'), { strict: false });
    await mergeFacts(join(root, 'extract'), join(root, 'merge'));
    const graph = JSON.parse(readFileSync(join(root, 'merge', 'estate-graph.json'), 'utf8'));
    const calls = (graph.edges || []).filter(edge => edge.kind === 'http_call_candidate');
    const callers = calls.map(edge => (edge.witnesses || [{}])[0].repo).sort();

    assert.deepEqual(callers, ['orders-android', 'orders-ios'],
      'both clients must reach the API that declares the host they were built against');
    assert.equal(calls.every(edge => edge.status === 'resolved'), true,
      'one API declares this host, so neither call is ambiguous');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
