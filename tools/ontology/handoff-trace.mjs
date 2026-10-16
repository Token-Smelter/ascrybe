// Deterministic acquisition of source evidence for a proposed hand-off between two repositories. It searches the pinned trees
// (git objects at the manifest ref, never a working copy), expands the enclosing function of each hit, resolves one symbol hop to its
// definition, and records exact path:line pins. It makes no model call and states what it could not resolve instead of guessing.
// Kinds are kept apart: a datastore shared by name is not a network call, and a shared collection name is not a shared database.
import { execFileSync } from 'node:child_process';

const git = (root, args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input ? { input } : {}) });
const tryGit = (root, args) => { try { return git(root, args); } catch { return null; } };

export const TRACE_BOUNDS = Object.freeze({ block_lines: 90, hits_per_term: 6, terms: 14, definition_hops: 6 });

// Hit text is stored, so a value that looks like a credential is replaced before it is recorded.
const redact = line => line.replace(/((?:key|secret|token|password|passwd|apikey)\w*['"]?\s*[:=]\s*['"]?)[A-Za-z0-9._\/+=-]{12,}/giu, '$1[redacted]');
export function readPinned(root, ref, path) { return tryGit(root, ['show', `${ref}:${path}`]); }
export function resolvePath(root, ref, suffix) {
  const files = tryGit(root, ['ls-tree', '-r', '--name-only', ref])?.split('\n') ?? [];
  const exact = files.filter(f => f === suffix), tail = files.filter(f => f.endsWith(`/${suffix}`) || f === suffix);
  return (exact.length ? exact : tail).filter(f => !/(^|\/)(node_modules|dist|build|\.next|Pods)\//u.test(f));
}
export function grepPinned(root, ref, term, { pathspec = [] } = {}) {
  const out = tryGit(root, ['grep', '-n', '-I', '-F', '--no-color', '-e', term, ref, '--', ...pathspec, ':(exclude)*/node_modules/*', ':(exclude).*', ':(exclude)*/.*/*', ':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)*.min.js']);
  return (out ?? '').split('\n').filter(Boolean).map(l => { const m = /^[^:]+:(.+?):(\d+):(.*)$/su.exec(l); return m ? { path: m[1], line: Number(m[2]), text: redact(m[3].trim().slice(0, 240)) } : null; }).filter(Boolean);
}

const STARTS = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>|class\s+\w+|def\s+\w+|async\s+def\s+\w+|(?:public|private|internal|override|static|final|open|fileprivate|suspend|@objc)\s+.*\bfunc\s+\w+|func\s+\w+|fun\s+\w+|(?:public|private|protected|static|async)\s+[\w<>\[\], ?]+\s+\w+\s*\([^)]*\)\s*\{)/u;
export function enclosing(text, line, limit = TRACE_BOUNDS.block_lines) {
  const lines = text.split('\n');
  let start = Math.min(line, lines.length);
  for (let i = start; i >= 1 && start - i < 200; i -= 1) if (STARTS.test(lines[i - 1])) { start = i; break; }
  if (start === Math.min(line, lines.length) && !STARTS.test(lines[start - 1] ?? '')) start = Math.max(1, line - 8);
  const python = /^\s*(?:async\s+)?def\s/u.test(lines[start - 1] ?? '');
  let end = start, depth = 0, opened = false, closed = false;
  for (let i = start; i <= lines.length && i - start < limit; i += 1) {
    const l = lines[i - 1];
    if (python) { if (i > start && l.trim() && (l.match(/^\s*/u)[0].length <= (lines[start - 1].match(/^\s*/u)[0].length))) { closed = true; break; } end = i; continue; }
    for (const ch of l) { if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1; }
    end = i; if (opened && depth <= 0) { closed = true; break; }
  }
  end = Math.max(end, Math.min(lines.length, line));
  // The extent is a heuristic: braces are counted, strings, regexes and templates are not parsed. It can end early or run to the cap.
  return { start_line: start, end_line: end, text: lines.slice(start - 1, end).join('\n'), extent: 'heuristic', reached_balanced_close: closed, hit_line_cap: !closed && end - start + 1 >= limit };
}

const WRITES = /\b(put|batchPut|insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|PutItem|PutCommand|UpdateItem|UpdateCommand|putObject|PutObject|writeFile)\b/gu;
const READS = /\b(query|get|findOne|find|aggregate|countDocuments|distinct|GetItem|GetCommand|QueryCommand|Query|Scan|getObject|GetObject|readFile)\b\s*\(/gu;
const COLLECTION = /(?:collection|getCollection|Collection)\(\s*['"`]([\w.-]+)['"`]|@table\(\s*(?:config\.get\(\s*)?['"`]([\w.-]+)['"`]|TableName:\s*['"`]([\w.-]+)['"`]|(?:COLLECTION\w*|collectionName\w*|tableName\w*|TABLE\w*)\s*[:=]\s*['"`]([\w.-]+)['"`]/giu;
const CONFIG_KEYS = /process\.env\.(\w+)|config\.get\(\s*['"`]([\w.]+)['"`]|getEnv\w*\(\s*['"`](\w+)['"`]|process\.env\[['"](\w+)['"]\]|os\.environ(?:\.get)?\(?\[?['"](\w+)['"]|getenv\(['"](\w+)['"]|(?:secrets?|config|Config|Environment|env)\.(\w{3,})|getSecret\w*\(\s*['"]([^'"]+)['"]|ssm:[\w/.-]+/u;
const ENDPOINTS = /https?:\/\/[^\s'"`)\]}<>]+|(?:['"`])(\/(?:[A-Za-z0-9_-]+|\{[\w]+\}|:[\w]+)(?:\/(?:[A-Za-z0-9_.-]+|\{[\w]+\}|:[\w]+))+)(?:['"`])/gu;
// An integration is recognised by the shape of its set-up call, not by a list of vendors: Name.initialize(...), Name.configure(...), Name.shared.identify(...).
const SDK = /\b([A-Z][A-Za-z0-9]{3,})\.(?:initialize|configure|init|shared\.\w+|getInstance)\b/gu;
const DB_CLIENT = /\b(useDbClient|MongoClient|getDb|createClient|DynamoDBClient|DocumentClient|mongoose\.connect)\b/gu;
const CALLABLE = /exports\.(\w{5,})\s*=|export\s+const\s+(\w{5,})\s*=\s*(?:\w+\.)*onCall/gu;
const NETWORK = /\b(fetch|axios|requests\.(?:get|post|put)|httpsCallable|URLSession|OkHttp|Retrofit|HttpClient|invoke|InvokeCommand|publish)\b\s*\(?/gu;

const uniq = (values, n = 12) => [...new Set(values.filter(Boolean))].slice(0, n);
// Names declared at file level (a collection constant, a config key) apply to every function in the file.
const withFileLevel = (blockFacts, fileText) => { const f = factsOf(fileText); return { ...blockFacts, collections: uniq([...blockFacts.collections, ...f.collections]), config_keys: uniq([...blockFacts.config_keys, ...f.config_keys]) }; };
export function factsOf(text) {
  const all = (re, pick) => [...text.matchAll(re)].map(pick);
  return {
    writes: uniq(all(WRITES, m => m[1])), reads: uniq(all(READS, m => m[1])),
    collections: uniq(all(COLLECTION, m => m[1] ?? m[2] ?? m[3] ?? m[4])),
    config_keys: uniq(all(new RegExp(CONFIG_KEYS.source, 'gu'), m => m.slice(1).find(Boolean) ?? m[0])),
    endpoints: uniq(all(ENDPOINTS, m => m[1] ?? m[0]).filter(e => !/\.(png|jpg|svg|css|js)$/u.test(e))),
    callables: uniq(all(CALLABLE, m => m[1] ?? m[2])),
    sdk: uniq(all(SDK, m => m[1])), db_clients: uniq(all(DB_CLIENT, m => m[1])), network_calls: uniq(all(NETWORK, m => m[1].replace(/\s*\($/u, ''))),
  };
}

// One symbol hop: find where a called name is defined in the same tree and expand that definition.
export function resolveDefinition(root, ref, name, fromText = '') {
  const tail = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]([^'"]+)['"]`, 'u').exec(fromText)?.[1]?.split('/').slice(-2).join('/');
  const hits = grepPinned(root, ref, name, { pathspec: ['*.ts', '*.tsx', '*.js', '*.mjs', '*.py', '*.swift', '*.kt', '*.java'] }).sort((x, y) => Number(Boolean(tail && y.path.includes(tail))) - Number(Boolean(tail && x.path.includes(tail)))).filter(h => new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|class\\s+|def\\s+|func\\s+|fun\\s+)${name}\\b`, 'u').test(h.text));
  const hit = hits.filter(h => !/(\.|\/)(test|spec|mock)s?[./]|__mocks__|\/tests?\//u.test(h.path))[0]; if (!hit) return null;
  const text = readPinned(root, ref, hit.path); if (!text) return null;
  const block = enclosing(text, hit.line);
  return { symbol: name, path: hit.path, ...block, facts: withFileLevel(factsOf(block.text), text) };
}

// A side with no pin is searched only; a listing side contributes the file names under a path prefix as its terms.
function openSide(root, ref, repo, spec) {
  if (spec.listing) {
    const names = (tryGit(root, ['ls-tree', '-r', '--name-only', ref]) ?? '').split('\n').filter(f => f.startsWith(spec.listing)).map(f => f.split('/').at(-1).replace(/\.[^.]+$/u, '')).filter(n => n.length >= 5);
    return { repo, ok: true, search_only: true, commit_sha: ref, requested: spec, path: spec.listing, start_line: null, end_line: null, facts: { ...factsOf(''), endpoints: uniq(names, 40) }, definitions: [], listed_names: names.length };
  }
  if (!spec.path) return { repo, ok: true, search_only: true, commit_sha: ref, requested: spec, path: null, start_line: null, end_line: null, facts: factsOf(''), definitions: [] };
  return expandPin(root, ref, repo, spec);
}
export function expandPin(root, ref, repo, spec) {
  const paths = resolvePath(root, ref, spec.path);
  if (paths.length !== 1) return { repo, requested: spec, ok: false, problem: paths.length ? `ambiguous path, ${paths.length} matches` : 'path not present at the pinned commit' };
  const text = readPinned(root, ref, paths[0]);
  if (text == null) return { repo, requested: spec, ok: false, problem: 'unreadable at the pinned commit' };
  const total = text.split('\n').length, line = spec.line ?? 1;
  if (line > total) return { repo, requested: spec, ok: false, problem: `line ${line} is beyond the ${total}-line file at the pin` };
  const block = spec.whole ? { start_line: 1, end_line: Math.min(total, TRACE_BOUNDS.block_lines * 2), text: text.split('\n').slice(0, TRACE_BOUNDS.block_lines * 2).join('\n') } : enclosing(text, line);
  const facts = withFileLevel(factsOf(block.text), text);
  const imported = new Set([...text.matchAll(/import\s*\{([^}]+)\}/gu)].flatMap(m => m[1].split(',').map(x => x.trim().split(/\s+as\s+/u).at(-1))));
  const named = uniq([...block.text.matchAll(/\b([A-Za-z_]\w{4,})\b/gu)].map(m => m[1]).filter(n => imported.has(n) && (facts.db_clients.includes(n) || /^(use|get|create|init|send|post|call|insert|update|retrieve|connect)/u.test(n) || /^[A-Z]\w+$/u.test(n))), TRACE_BOUNDS.definition_hops);
  const definitions = named.map(n => resolveDefinition(root, ref, n, text)).filter(Boolean).filter(d => !(d.path === paths[0] && d.start_line <= block.start_line && d.end_line >= block.end_line));
  return { repo, ok: true, commit_sha: ref, path: paths[0], requested: spec, start_line: block.start_line, end_line: block.end_line, block_text: block.text, facts, definitions };
}

// Search the other repository's pinned tree for what one side exposes or names. The terms come from the first side's own code.
export function searchOther(root, ref, terms) {
  return uniq(terms, TRACE_BOUNDS.terms).map(term => ({ term, hits: grepPinned(root, ref, term).filter(h => !/\.(md|json|lock)$/u.test(h.path) || /config/u.test(h.path)).slice(0, TRACE_BOUNDS.hits_per_term) })).filter(t => t.hits.length);
}

// A dotted configuration key is mapped to its environment variable by searching the tree for the key's last part.
export function configBridge(root, ref, keys) {
  return uniq(keys.filter(k => k.includes('.')), 8).flatMap(key => {
    const tail = key.split('.').at(-1);
    const ENV = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/u;
    return grepPinned(root, ref, tail, { pathspec: ['*.ts', '*.js', '*.py', '*.json', '*.yaml', '*.yml'] }).filter(h => !/(test|spec)\./u.test(h.path)).slice(0, 6).flatMap(h => {
      const body = readPinned(root, ref, h.path)?.split('\n') ?? [];
      for (let i = h.line; i <= Math.min(body.length, h.line + 6); i += 1) { const m = /\benv\s*:\s*['"]([A-Z][A-Z0-9_]+)['"]/u.exec(body[i - 1] ?? '') ?? (i === h.line ? ENV.exec(body[i - 1]) : null); if (m) return [{ key, env: m[1], path: h.path, line: i, text: redact(body[i - 1].trim().slice(0, 200)) }]; }
      return [];
    }).slice(0, 2);
  });
}
const sameValues = (a, b) => a.filter(x => b.includes(x));
function needs(a, b, crossHits) {
  const named = [...(a.facts.callables ?? []), ...(a.facts.endpoints ?? []), ...(a.facts.collections ?? []), ...(b.facts.endpoints ?? [])].filter(t => t.length >= 6).slice(0, 4).join(', ');
  const where = [...new Set(crossHits.flatMap(c => c.hits.map(h => `${c.in}:${h.path}:${h.line}`)))].slice(0, 3).join('; ');
  const lead = `Terms searched: ${named || 'none could be derived from the pinned block'}.`;
  if (crossHits.length) return `${lead} Matches (${where}) are string matches only; no read, write, call or integration around them uses the same resource. Needed: the source that connects them (a configuration value, an infrastructure definition, or a caller not yet located).`;
  return `${lead} Nothing in the other pinned tree names them. Needed: where the other side learns this name or address at runtime (a remote configuration value or other deployed setting), or a repository not in this manifest.`;
}
export function judge(a, b, searchAB, searchBA, bridges = []) {
  const findings = [];
  const aAll = [a, ...(a.definitions ?? [])], bAll = [b, ...(b.definitions ?? [])];
  const gather = (side, key) => uniq(side.flatMap(s => s.facts?.[key] ?? []), 40);
  const aw = gather(aAll, 'writes'), bw = gather(bAll, 'writes'), ar = gather(aAll, 'reads'), br = gather(bAll, 'reads');
  const shared = sameValues(gather(aAll, 'collections'), gather(bAll, 'collections'));
  if (shared.length && ((aw.length && br.length) || (bw.length && ar.length))) {
    const [writer, reader] = aw.length && br.length ? [a, b] : [b, a];
    const keys = side => gather([side, ...(side.definitions ?? [])], 'config_keys'), wk = keys(writer), rk = keys(reader), shareKeys = sameValues(wk, rk);
    findings.push({ kind: 'datastore', relation: 'writes_to_and_reads_from_same_named_collection', collections: shared, writer: writer.repo, reader: reader.repo,
      physical_store: shareKeys.length ? 'same connection configuration key in code, value not read back' : 'unresolved',
      missing: `The deployed value of ${wk.length ? wk.join(', ') : 'the writer connection setting'} and ${rk.length ? rk.join(', ') : 'the reader connection setting'} (secret or environment value, not in the repository). Without it the same collection name does not show the same physical database.`,
      refs: [writer, reader].flatMap(s => [{ repo: s.repo, path: s.path, start_line: s.start_line, end_line: s.end_line }, ...(s.definitions ?? []).map(d => ({ repo: s.repo, path: d.path, start_line: d.start_line, end_line: d.end_line, symbol: d.symbol }))]) });
  }
  const bridgeEnv = new Map(bridges.map(x => [x.env, x]));
  for (const [reader, other] of [[a, b], [b, a]]) {
    const envs = gather([reader, ...(reader.definitions ?? [])], 'config_keys').filter(k => bridgeEnv.has(k) || /^[A-Z][A-Z0-9_]+$/u.test(k));
    const keys = gather([other, ...(other.definitions ?? [])], 'config_keys').filter(k => k.includes('.'));
    const hit = bridges.filter(x => envs.includes(x.env) && keys.includes(x.key));
    if (hit.length && !findings.some(f => f.kind === 'datastore')) findings.push({ kind: 'datastore', relation: 'same_table_setting_by_configuration_mapping', config_key: hit[0].key, environment_variable: hit[0].env,
      physical_store: 'unresolved', missing: `The deployed value of ${hit[0].env}; the code maps ${hit[0].key} to it, the value is set at deploy time.`,
      refs: [reader, other].filter(x => x.path).map(x => ({ repo: x.repo, path: x.path, start_line: x.start_line, end_line: x.end_line })).concat(hit.map(x => ({ repo: other.repo, path: x.path, start_line: x.line, end_line: x.line, text: x.text }))) });
  }
  const eps = [...sameValues(gather(aAll, 'endpoints'), gather(bAll, 'endpoints')), ...searchAB.filter(t => /^\/|^https?:/u.test(t.term)).map(t => t.term), ...searchBA.filter(t => /^\/|^https?:/u.test(t.term)).map(t => t.term)];
  const callers = gather(aAll, 'network_calls').length || gather(bAll, 'network_calls').length || searchAB.length + searchBA.length > 0;
  if (eps.length && callers) findings.push({ kind: 'network', relation: 'endpoint_named_on_both_sides', endpoints: uniq(eps, 6), missing: 'Which deployed route or host the literal resolves to, and that the call is reached at runtime.',
    refs: [a, b].map(s => ({ repo: s.repo, path: s.path, start_line: s.start_line, end_line: s.end_line })) });
  const sdkShared = sameValues(gather(aAll, 'sdk'), gather(bAll, 'sdk'));
  if (sdkShared.length) findings.push({ kind: 'sdk_forwarding', relation: 'same_named_integration_on_both_sides', names: sdkShared.slice(0, 6), missing: 'The destination credentials and that both sides address the same workspace; the code names the SDK, not the account.',
    refs: [a, b].map(s => ({ repo: s.repo, path: s.path, start_line: s.start_line, end_line: s.end_line })) });
  const callableTerms = new Set([...gather(aAll, 'callables'), ...gather(bAll, 'callables')]);
  const invocations = [...searchAB.map(t => ({ ...t, in: b.repo, from: a.repo })), ...searchBA.map(t => ({ ...t, in: a.repo, from: b.repo }))]
    .flatMap(t => t.hits.filter(h => callableTerms.has(t.term) && /allable|fetch|axios|URLSession|request|invoke/u.test(h.text)).map(h => ({ term: t.term, repo: t.in, path: h.path, line: h.line, text: h.text })));
  if (invocations.length) findings.push({ kind: 'network', relation: 'callable_defined_on_one_side_and_invoked_by_name_on_the_other', callables: uniq(invocations.map(i => i.term), 6),
    missing: 'The deployed project and region the client points at, and that the function is deployed under this name; the repositories show the name matches, not that the call reaches this deployment.',
    refs: [...[a, b].filter(x => x.path).map(x => ({ repo: x.repo, path: x.path, start_line: x.start_line, end_line: x.end_line })), ...invocations.slice(0, 4).map(i => ({ repo: i.repo, path: i.path, start_line: i.line, end_line: i.line, text: i.text }))] });
  const GENERIC_WORDS = /^(environment|secret|secretstring|token|apikey|region|domain|string|config|writekey|current|build)$/u;
  const vendorTokens = side => new Set([...gather([side, ...(side.definitions ?? [])], 'sdk'), ...gather([side, ...(side.definitions ?? [])], 'config_keys')].map(x => x.toLowerCase().replace(/[^a-z]/gu, '')).filter(x => x.length >= 7 && !GENERIC_WORDS.test(x)));
  const aTok = vendorTokens(a), bTok = vendorTokens(b);
  const vendors = [...aTok].flatMap(x => [...bTok].filter(y => y.slice(0, 8) === x.slice(0, 8)).map(() => x)).filter((x, i, all) => all.indexOf(x) === i);
  if (vendors.length && !findings.length) findings.push({ kind: 'shared_vendor_destination', relation: 'both_sides_name_the_same_vendor', vendors: vendors.slice(0, 4),
    missing: 'Whether the two credentials address the same vendor workspace or project. The code on each side names the vendor and reads its own credential; the values are secrets or deployed settings, not in the repository, so a shared destination is not shown.',
    refs: [a, b].filter(x => x.path).map(x => ({ repo: x.repo, path: x.path, start_line: x.start_line, end_line: x.end_line })) });
  const crossHits = [...searchAB.map(t => ({ ...t, in: b.repo, from: a.repo })), ...searchBA.map(t => ({ ...t, in: a.repo, from: b.repo }))];
  if (!findings.length) findings.push({ kind: 'none_located', relation: crossHits.length ? 'terms_found_but_no_structural_link' : 'no_shared_term_found', missing: needs(a, b, crossHits),
    refs: [] });
  return { findings, cross_hits: crossHits.slice(0, 20) };
}

// Identical file content in two trees is the one deterministic sign that an asset was copied rather than redrawn.
export function sharedBlobs(rootA, refA, prefixA, rootB, refB, prefixB = '') {
  const list = (root, ref, prefix) => new Map((tryGit(root, ['ls-tree', '-r', '-l', ref]) ?? '').split('\n').filter(Boolean).map(l => /^\d+ blob (\w+)\s+(\d+|-)\t(.*)$/u.exec(l)).filter(m => m && m[3].startsWith(prefix) && Number(m[2]) >= 400).map(m => [m[3], m[1]]));
  const a = list(rootA, refA, prefixA), b = list(rootB, refB, prefixB), byOid = new Map();
  for (const [path, oid] of b) byOid.set(oid, [...(byOid.get(oid) ?? []), path]);
  const matches = [...a].filter(([, oid]) => byOid.has(oid)).map(([path, oid]) => ({ a_path: path, b_paths: byOid.get(oid).slice(0, 3), blob: oid }));
  return { files_considered_a: a.size, files_considered_b: b.size, matches };
}
export function traceHandOff(spec, roots) {
  const a = openSide(roots[spec.a.repo].root, roots[spec.a.repo].ref, spec.a.repo, spec.a), b = openSide(roots[spec.b.repo].root, roots[spec.b.repo].ref, spec.b.repo, spec.b);
  for (const side of [a, b]) {
    const source = roots[side.repo];
    if (source.source_kind) side.source_kind = source.source_kind;
    if (source.snapshot) side.snapshot = source.snapshot;
    if (source.parents) side.parents = source.parents;
  }
  const base = { trace_id: spec.id, label: spec.label, a, b, static_only: true, note: 'A static match shows code that lines up. It does not show the connection is deployed or runs.' };
  if (!a.ok || !b.ok) return { ...base, findings: [{ kind: 'unresolved_lead', relation: 'pin_not_verified', missing: [a, b].filter(x => !x.ok).map(x => `${x.repo}: ${x.problem} (${x.requested.path})`).join('; ') }], cross_hits: [] };
  const termsFrom = side => [...side.facts.collections, ...side.facts.endpoints, ...side.facts.callables, ...side.definitions.flatMap(d => d.facts.collections)].filter(t => (t.length >= 8 || /[._/-]/u.test(t)) && t.length >= 6 && !/^(https?:\/\/(localhost|127))/u.test(t));
  const searchAB = searchOther(roots[b.repo].root, roots[b.repo].ref, termsFrom(a)), searchBA = searchOther(roots[a.repo].root, roots[a.repo].ref, termsFrom(b));
  const keysOf = side => [...side.facts.config_keys, ...side.definitions.flatMap(d => d.facts.config_keys)];
  const bridges = [...configBridge(roots[b.repo].root, roots[b.repo].ref, keysOf(b)), ...configBridge(roots[a.repo].root, roots[a.repo].ref, keysOf(a))];
  if (spec.blob_match) {
    const m = sharedBlobs(roots[spec.a.repo].root, roots[spec.a.repo].ref, spec.a.listing ?? '', roots[spec.b.repo].root, roots[spec.b.repo].ref, spec.b.listing ?? '');
    return { ...base, blob_match: { ...m, matches: m.matches.slice(0, 40) }, cross_hits: [], findings: [m.matches.length
      ? { kind: 'asset_copy', relation: 'identical_file_content_in_both_trees', matches: m.matches.length, files_considered: [m.files_considered_a, m.files_considered_b], refs: m.matches.slice(0, 6).flatMap(x => [{ repo: spec.a.repo, path: x.a_path }, ...x.b_paths.map(path => ({ repo: spec.b.repo, path }))]),
        missing: 'Whether the copy is made by a build step or by hand, and whether the copied file is a member of a shipped bundle (project membership is not read here). Identical bytes show a copy exists, not that it ships.' }
      : { kind: 'none_located', relation: 'no_identical_file_content', missing: `No file of 400 bytes or more under ${spec.a.listing || 'the first tree'} has identical bytes in the other tree (${m.files_considered_a} and ${m.files_considered_b} files compared). A resized, exported or recoloured asset would not match; the binding would then need a build step or manifest that names both.`, refs: [] }] };
  }
  return { ...base, terms_searched: { from_a_in_b: termsFrom(a).slice(0, TRACE_BOUNDS.terms), from_b_in_a: termsFrom(b).slice(0, TRACE_BOUNDS.terms) }, ...judge(a, b, searchAB, searchBA, bridges) };
}
