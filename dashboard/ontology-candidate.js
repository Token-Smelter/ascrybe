// Renders the derived renderer contract of one proposed generation. Every scheme, concept, label
// and grouping comes from /api/view-model; only UI chrome and the predicate/standing legend are fixed.
import { createGraphView } from '/ontology-graph.js';
import { createEstateView } from '/ontology-estate.js';
import { createReconcileView } from '/ontology-reconcile.js';
const state = { model: null, concepts: new Map(), artifacts: new Map(), tab: 'graph', lastConcept: null, graphView: null, estateView: null };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const words = value => String(value ?? '').replaceAll('_', ' ');
const short = id => String(id ?? '').split(':').at(-1).slice(0, 12);
const stamp = (value, extra = '') => h('span', { class: `stamp stamp--${value}${extra}` }, words(value));
const lines = o => `${o.start_line}${o.end_line !== o.start_line ? `–${o.end_line}` : ''}`;

function go(kind, id = '') {
  const next = `#${kind}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash === next) render(); else location.hash = next;
}

function sourceLine(o) {
  return h('div', { class: 'source' },
    h('button', { type: 'button', class: 'linkish', onclick: () => go('artifact', o.artifact_id) }, o.artifact_id),
    h('span', {}, `${o.repository}:${o.path}:${lines(o)}`), h('span', {}, `@${String(o.commit_sha).slice(0, 8)}`),
    stamp(o.standing), o.span_class && o.span_class !== 'code' ? h('span', { class: 'stamp stamp--muted', title: 'The passage is comment text: observed at the pin, but what it says is a claim, not behaviour' }, `${o.span_class} text`) : null);
}

// A quote usually starts mid-line; drop the indentation its continuation lines share.
function dedent(text) {
  const [first, ...rest] = String(text).split('\n');
  const indents = rest.filter(line => line.trim()).map(line => line.match(/^[ \t]*/u)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return [first, ...rest.map(line => line.slice(Math.min(cut, line.match(/^[ \t]*/u)[0].length)))].join('\n');
}
const quote = o => h('blockquote', { class: 'quote' }, dedent(o.quote));

function conceptLink(accession) {
  const target = state.concepts.get(accession);
  return h('button', { type: 'button', class: 'linkish', onclick: () => go('concept', accession) }, target?.concept.label ?? accession);
}

function assertionEntry(a, subject) {
  return h('div', { class: `entry${a.polarity === 'deny' ? ' entry--counterexample' : ''}` },
    h('div', { class: 'entry__head' },
      h('span', { class: `predicate${a.membership ? ' predicate--member' : ''}` }, `${a.polarity === 'deny' ? 'not ' : ''}${words(a.predicate)}`),
      subject,
      a.basis === 'referenced_by_document' ? h('span', { class: 'stamp stamp--muted', title: 'Named in a document; the thing itself was not read and ownership or permission is not established' }, 'referenced, not read') : null,
      a.held_out ? h('span', { class: 'stamp stamp--muted' }, 'held out of synthesis') : null),
    quote(a.occurrence), sourceLine(a.occurrence));
}

function evidenceEntry(e) {
  return h('div', { class: `entry${e.role === 'counterexample' ? ' entry--counterexample' : ''}` },
    h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(e.role)),
      e.locator && e.locator !== 'exact' ? h('span', { class: 'mono', title: e.model_quote ? `model quoted: ${e.model_quote}` : '' }, `located by ${e.locator}`) : null),
    quote(e), e.reason ? h('p', { class: 'entry__note' }, e.reason) : null, sourceLine(e));
}

function section(title, children, empty = null) {
  const body = children.filter(Boolean);
  if (!body.length && !empty) return null;
  return h('section', {}, h('h3', {}, title), body.length ? body : h('p', { class: 'empty' }, empty));
}

// Categories whose instances are subjects in code, decisions or kinds of things; themes, practices
// and policies are fully meaningful with only defining and describing sources.
const INSTANCE_EXPECTED = new Set(['responsibility', 'type', 'strategy']);

function conflictEntry(b) {
  return h('div', { class: 'entry entry--blocker' },
    h('div', { class: 'entry__head' }, stamp('blocks_acceptance'), h('span', {}, words(b.kind)), h('span', { class: 'mono' }, words(b.identity))),
    h('p', { class: 'entry__note' }, `${words(b.predicate)} — affirmed in ${b.affirm_path}`), h('blockquote', { class: 'quote' }, dedent(b.affirm_quote)),
    h('p', { class: 'entry__note' }, `denied in ${b.deny_path}`), h('blockquote', { class: 'quote' }, dedent(b.deny_quote)));
}

function renderConcept(accession) {
  const entry = state.concepts.get(accession);
  if (!entry) return renderMissing(accession);
  state.lastConcept = accession;
  const { concept: c, scheme, collection } = entry;
  const relating = state.model.legend.relating_predicates;
  const affirmed = predicate => c.assertions.filter(a => a.predicate === predicate && a.polarity !== 'deny');
  const subject = a => [h('span', { class: 'entry__name' }, a.referent), h('span', { class: 'mono' }, words(a.referent_kind))];
  const relations = collection.relations.filter(r => r.from === accession || r.to === accession);
  const neighbors = state.model.neighbor_review.filter(p => p.a === accession || p.b === accession);
  const instances = c.assertions.filter(a => a.membership);
  return h('article', { class: 'reveal' },
    h('div', { class: 'card' },
      h('div', { class: 'source' }, h('span', {}, c.accession), h('span', { class: 'stamp stamp--muted' }, c.semantic_category),
        stamp(c.standing.summary), h('span', { class: 'stamp stamp--muted' }, words(c.origin)), h('span', {}, `version ${short(c.version_id)}`)),
      h('h2', {}, c.label),
      h('p', { class: 'definition' }, c.definition),
      h('div', { class: 'bounds' },
        h('section', {}, h('h4', {}, 'Includes'), h('p', {}, c.inclusion)),
        h('section', {}, h('h4', {}, 'Excludes'), h('p', {}, c.exclusion))),
      c.invariants.length || c.instance_conditions?.length ? h('div', { class: 'bounds' },
        c.invariants.length ? h('section', {}, h('h4', {}, 'What the concept itself states'), c.invariants.map(v => h('p', {}, v))) : null,
        c.instance_conditions?.length ? h('section', {}, h('h4', {}, 'What an instance must satisfy'), c.instance_conditions.map(v => h('p', {}, v))) : null) : null,
      c.standing.standings_present?.length > 1 ? h('p', { class: 'mono' }, `evidence standings: ${c.standing.standings_present.map(words).join(', ')}`) : null,
      c.aliases.length ? h('div', { class: 'chips' }, c.aliases.map(a => h('span', { class: 'chip' }, a))) : null,
      h('p', { class: 'mono' }, `${collection.collection_id} · ${scheme.label} · instances by ${c.constitutive_predicates.map(words).join(' or ')}`
        + (c.domain.length ? ` · from ${c.domain.map(words).join(', ')}` : ''))),
    section('Blocks acceptance (implemented checks only)', c.blockers.map(conflictEntry)),
    section('Citation overlap — review', c.citation_overlaps.map(f => h('div', { class: 'entry' },
      h('p', { class: 'entry__note' }, 'A member quote overlaps a cited counterexample. This is a citation check, not a conflict finding.'),
      h('blockquote', { class: 'quote' }, dedent(f.member_quote)), h('blockquote', { class: 'quote' }, dedent(f.counterexample_quote))))),
    section('Re-discovered under new words — same concept or refinement? (candidates, not active)', collection.candidates.filter(x => x.relation_to_existing.existing_accession === accession).map(x => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(x.relation_to_existing.kind)), h('span', { class: 'entry__name' }, x.label), h('span', { class: 'stamp stamp--muted' }, 'needs human decision')),
      h('p', { class: 'entry__note' }, x.relation_to_existing.reason),
      h('div', { class: 'bounds' },
        h('section', {}, h('h4', {}, 'Existing definition'), h('p', {}, c.definition)),
        h('section', {}, h('h4', {}, 'Candidate definition'), h('p', {}, x.definition))),
      x.evidence.map(e => h('div', {}, e.new_to_existing ? h('span', { class: 'stamp stamp--muted' }, 'evidence new to the existing concept') : null, evidenceEntry(e)))))),
    section('Pending changes', c.pending_changes.map(ch => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, ch.op), h('span', { class: 'stamp stamp--muted' }, words(ch.status))),
      h('p', { class: 'entry__note' }, ch.reason),
      ch.proposed_versions.map(p => h('div', { class: 'entry' }, h('span', { class: 'entry__name' }, p.label), h('p', {}, p.definition))),
      ch.evidence.map(evidenceEntry)))),
    ...c.constitutive_predicates.map(p => section(`Instances · ${words(p)}`, affirmed(p).map(a => assertionEntry(a, subject(a))))),
    !instances.length && INSTANCE_EXPECTED.has(c.semantic_category)
      ? h('p', { class: 'empty' }, `No subject in the supplied excerpts instantiates this ${c.semantic_category}.`) : null,
    section('Denied by a source', c.assertions.filter(a => a.polarity === 'deny').map(a => assertionEntry(a, subject(a)))),
    ...relating.filter(p => p !== 'describes').map(p => section(`${words(p)} by`, affirmed(p).map(a => assertionEntry(a, subject(a))))),
    affirmed('describes').length ? h('details', {}, h('summary', {}, `Described by ${affirmed('describes').length} passage(s) — not instances`),
      affirmed('describes').map(a => assertionEntry(a, subject(a)))) : null,
    section('Evidence passages', c.evidence.map(evidenceEntry), 'No located evidence passage.'),
    section('Relations', relations.map(r => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, conceptLink(r.from), h('span', { class: 'predicate' }, words(r.type)), conceptLink(r.to),
        h('span', { class: 'stamp stamp--muted' }, words(r.origin))),
      h('p', { class: 'entry__note' }, r.definition), r.evidence.map(evidenceEntry)))),
    section('Neighbor review', neighbors.map(p => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(p.relation)),
        conceptLink(p.a === accession ? p.b : p.a), h('span', { class: 'stamp stamp--muted' }, words(p.status))),
      h('p', { class: 'entry__note' }, p.reason)))));
}

const coverageText = c => `${words(c.status)}${c.reason ? ` — ${c.reason}` : ''}`;

function renderArtifact(id) {
  const artifact = state.artifacts.get(id);
  if (!artifact) return renderMissing(id);
  const citing = [...state.concepts.values()].flatMap(({ concept }) => concept.evidence
    .filter(e => e.artifact_id === id).map(e => ({ e, concept })));
  const rejected = state.model.rejected.filter(r => r.artifact_id === id);
  return h('article', { class: 'reveal' },
    state.lastConcept ? h('p', {}, h('button', { type: 'button', class: 'linkish', onclick: () => go('concept', state.lastConcept) },
      `← back to ${state.concepts.get(state.lastConcept)?.concept.label ?? 'concept'}`)) : null,
    h('div', { class: 'card' },
      h('div', { class: 'source' }, h('span', {}, artifact.artifact_id), stamp(artifact.standing),
        artifact.held_out ? h('span', { class: 'stamp stamp--muted' }, 'held out of synthesis') : null),
      h('h2', {}, artifact.path),
      h('p', { class: 'mono' }, `${artifact.repository} @${artifact.commit_sha} · lines ${artifact.start_line}–${artifact.end_line} · ${artifact.collection_id}`),
      artifact.graph_node_ids.length ? h('p', { class: 'mono' }, `graph: ${artifact.graph_node_ids.map(n => `${n.kind} ${n.node_id}`).join(', ')}`) : null,
      artifact.coverage ? h('p', { class: 'entry__note' }, `Vocabulary coverage: ${coverageText(artifact.coverage.synthesis)}. Subject grounding: ${coverageText(artifact.coverage.grounding)}.`) : null),
    section('Subjects in this excerpt', artifact.referents.map(r => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'entry__name' }, r.name), h('span', { class: 'mono' }, words(r.kind)),
        h('span', { class: 'mono' }, `lines ${lines(r.occurrence)}`),
        r.basis === 'referenced_by_document' ? h('span', { class: 'stamp stamp--muted' }, 'referenced, not read') : null),
      r.denotes && r.denotes !== r.name ? h('p', { class: 'entry__note' }, `denotes: ${r.denotes}`) : null,
      quote(r.occurrence),
      r.assertions.map(a => h('div', { class: 'entry__head' },
        h('span', { class: `predicate${a.membership ? ' predicate--member' : ''}` }, `${a.polarity === 'deny' ? 'not ' : ''}${words(a.predicate)}`),
        conceptLink(a.concept_accession))),
      r.coverage.status !== 'related' ? h('p', { class: 'entry__note' }, coverageText(r.coverage)) : null)),
    'No typed subject was grounded in this excerpt.'),
    section('Cited as concept evidence', citing.map(({ e, concept }) => h('div', { class: `entry${e.role === 'counterexample' ? ' entry--counterexample' : ''}` },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(e.role)), conceptLink(concept.accession)),
      quote(e), e.reason ? h('p', { class: 'entry__note' }, e.reason) : null))),
    section('Rejected for this excerpt', rejected.map(r => h('div', { class: 'entry entry--counterexample' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(r.code)), h('span', {}, [r.predicate, r.referent, r.concept].filter(Boolean).join(' · '))),
      r.quote ? h('blockquote', { class: 'quote' }, r.quote) : null))));
}

function table(headers, rows) {
  return h('table', { class: 'review-table' }, h('thead', {}, h('tr', {}, headers.map(x => h('th', {}, x)))),
    h('tbody', {}, rows.map(row => h('tr', {}, row.map(cell => h('td', {}, cell))))));
}

function renderReview() {
  const m = state.model;
  const tally = rows => Object.entries(rows.reduce((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {}));
  const notes = m.collections.flatMap(c => [...c.gaps.map(g => ({ ...g, type: 'gap', c })), ...c.unresolved.map(u => ({ ...u, type: 'unresolved', c }))]);
  return h('article', { class: 'reveal' },
    h('div', { class: 'card' }, h('h2', {}, 'Review'),
      h('p', { class: 'definition' }, 'No review decision has been recorded for anything in this generation, and review recording is not enabled in this viewer.'),
      table(['Decision', 'Count'], tally(m.decisions_needed.map(d => words(d.decision_kind)))),
      h('p', { class: 'mono' }, `${m.decisions_needed.filter(d => d.status === 'blocks_acceptance').length} decision(s) block acceptance under the implemented checks`)),
    section('Pending vocabulary changes', m.collections.flatMap(c => c.changes.map(ch => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, ch.op), ch.accessions.map(conceptLink)),
      h('p', { class: 'entry__note' }, ch.reason), ch.evidence.map(evidenceEntry)))), 'No change proposed.'),
    section('Identity candidates — pending human decision', m.collections.flatMap(c => c.candidates.map(x => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(x.relation_to_existing.kind)), h('span', { class: 'entry__name' }, x.label),
        conceptLink(x.relation_to_existing.existing_accession)), h('p', { class: 'entry__note' }, x.relation_to_existing.reason)))), 'No renamed re-discovery awaits a decision.'),
    section('Neighbor review', m.neighbor_review.map(p => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, conceptLink(p.a), h('span', { class: 'predicate' }, words(p.relation)), conceptLink(p.b)),
      h('p', { class: 'entry__note' }, p.reason))), 'No redundancy, contradiction or identity question.'),
    section('Unresolved queue — carried into the next update', m.collections.flatMap(c => (c.unresolved_artifact_ids ?? []).map(id => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'mono' }, c.collection_id), h('button', { type: 'button', class: 'linkish', onclick: () => go('artifact', id) }, id))))),
    'Nothing is waiting on a better explanation.'),
    section('Gaps and unresolved questions', notes.map(n => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, n.type), h('span', { class: 'mono' }, `${n.c.collection_id} · ${words(n.kind)}`)),
      h('p', {}, n.description), (n.evidence ?? []).map(evidenceEntry)))),
    section('Coverage per excerpt', m.collections.map(c => h('div', {},
      h('p', { class: 'mono' }, c.collection_id),
      table(['Excerpt', 'Vocabulary', 'Subjects', 'Expansion'], c.coverage.artifacts.map(a => {
        const expanded = (c.expansion_statuses ?? []).find(x => x.artifact_id === a.artifact_id);
        return [h('button', { type: 'button', class: 'linkish', onclick: () => go('artifact', a.artifact_id) }, a.artifact_id),
          coverageText(a.synthesis), coverageText(a.grounding), expanded ? coverageText(expanded) : '—'];
      }))))),
    section(`Acceptance blockers — implemented checks only (${m.legend.implemented_checks.map(words).join('; ')})`,
      m.collections.flatMap(c => c.schemes.flatMap(s => s.concepts.flatMap(x => x.blockers))).map(conflictEntry), 'None from the implemented checks; other contradictions are not detected.'),
    section('Findings', m.findings.map(f => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(f.kind)), f.concept_accession ? conceptLink(f.concept_accession) : null),
      f.quote ? h('blockquote', { class: 'quote' }, f.quote) : null)), 'No finding.'),
    section('Rejected model output', [table(['Reason', 'Count'], tally(m.rejected.map(r => `${words(r.code)} (${r.where})`)))]),
    section('Not interpreted', [h('details', {}, h('summary', {}, `${m.unsupported.length} binary file(s) inventoried, not interpreted`),
      table(['Repository', 'Path'], m.unsupported.map(u => [u.repository, u.path])))]));
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value); else el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) el.append(child instanceof Node ? child : String(child));
  return el;
}

// Concepts sit in one column per scheme the generation produced; typed relations are drawn between
// them. Columns, labels and edges all come from the generation: nothing here names a domain.
function renderMap() {
  const m = state.model, NODE_W = 210, NODE_H = 46, GAP_X = 110, GAP_Y = 16, TOP = 40;
  const columns = m.collections.flatMap(c => c.schemes.map(s => ({ c, s })));
  const pos = new Map();
  columns.forEach(({ s }, i) => s.concepts.forEach((x, j) => pos.set(x.accession, { x: 20 + i * (NODE_W + GAP_X), y: TOP + j * (NODE_H + GAP_Y) })));
  const width = 40 + columns.length * (NODE_W + GAP_X), rows = Math.max(1, ...columns.map(({ s }) => s.concepts.length));
  const height = TOP + rows * (NODE_H + GAP_Y) + 20;
  const edges = m.collections.flatMap(c => c.relations).filter(r => pos.has(r.from) && pos.has(r.to));
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Concepts and typed relations' });
  columns.forEach(({ c, s }, i) => root.append(svg('text', { x: 20 + i * (NODE_W + GAP_X), y: 20, class: 'map-scheme' }, `${c.collection_id} · ${s.label}`)));
  edges.forEach((r, i) => {
    const a = pos.get(r.from), b = pos.get(r.to), sameColumn = a.x === b.x;
    const x1 = sameColumn ? a.x + NODE_W : (a.x < b.x ? a.x + NODE_W : a.x), x2 = sameColumn ? b.x + NODE_W : (a.x < b.x ? b.x : b.x + NODE_W);
    const y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2, bend = sameColumn ? 60 : (x2 - x1) / 2;
    root.append(svg('path', { d: `M${x1},${y1} C${x1 + (sameColumn ? bend : bend)},${y1} ${x2 - (sameColumn ? -bend : bend)},${y2} ${x2},${y2}`, class: 'map-edge', fill: 'none' }));
    root.append(svg('text', { x: (x1 + x2) / 2 + (sameColumn ? bend / 2 : 0), y: (y1 + y2) / 2 - 3, class: 'map-edge-label' }, words(r.type)));
  });
  for (const [accession, at] of pos) {
    const { concept } = state.concepts.get(accession);
    const subjects = concept.assertions.filter(a => a.membership).length;
    root.append(svg('g', { class: `map-node map-node--${concept.currentness.state}`, tabindex: '0', role: 'link', onclick: () => go('concept', accession),
      onkeydown: e => { if (e.key === 'Enter') go('concept', accession); } },
      svg('rect', { x: at.x, y: at.y, width: NODE_W, height: NODE_H, rx: 3 }),
      svg('text', { x: at.x + 8, y: at.y + 18, class: 'map-node__label' }, concept.label.slice(0, 30)),
      svg('text', { x: at.x + 8, y: at.y + 36, class: 'map-node__meta' }, `${concept.semantic_category} · ${subjects} subj · ${words(concept.currentness.state)}`)));
  }
  const list = edges.length ? edges.map(r => h('div', { class: 'entry' }, h('div', { class: 'entry__head' }, conceptLink(r.from), h('span', { class: 'predicate' }, words(r.type)), conceptLink(r.to)),
    h('p', { class: 'entry__note' }, r.definition))) : [h('p', { class: 'empty' }, 'This generation proposes no relation between concepts.')];
  return h('article', { class: 'reveal' }, h('div', { class: 'card' }, h('h2', {}, 'Concept map'),
    h('p', { class: 'definition' }, 'One column per scheme the generation proposed; edges are the typed relations it proposed, each backed by quoted evidence on the concept page. Node tone shows whether support is current.'),
    h('div', { class: 'map-scroll' }, root)), section('Typed relations', list));
}

function renderRevisions() {
  const m = state.model, rev = m.revision;
  const stale = rev.stale_evidence;
  return h('article', { class: 'reveal' },
    h('div', { class: 'card' }, h('h2', {}, 'Revisions'),
      h('p', { class: 'definition' }, rev.prior_generation_id ? `Interpreted against prior generation ${short(rev.prior_generation_id)}. Prior concepts are kept as hypotheses; nothing is accepted or merged.` : 'First interpretation: no prior generation.'),
      table(['Collection', 'Mode', 'Carried', 'Added', 'Identity candidates', 'Pending changes', 'Changed artifacts', 'Unresolved queue'],
        rev.collections.map(c => [c.collection_id, words(c.mode), c.carried, c.added, c.candidates, c.pending_changes, c.changed_artifact_ids.join(', ') || '—', c.unresolved_artifact_ids.join(', ') || '—']))),
    section('Support that no longer exists at the pin', stale.map(f => h('div', { class: 'entry entry--counterexample' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(f.role ?? 'support')), f.concept_accession ? conceptLink(f.concept_accession) : null,
        h('span', { class: 'mono' }, f.path)), h('blockquote', { class: 'quote' }, dedent(f.quote)),
      h('p', { class: 'entry__note' }, f.file_in_corpus ? 'The file is still present; this exact passage changed or was removed.' : 'The file is not in the current corpus.'))),
    'No supporting passage disappeared between the two interpretations.'),
    section('Concepts by currentness', [table(['Concept', 'Category', 'Origin', 'Located support', 'Stale support', 'State'],
      [...state.concepts.values()].map(({ concept: c }) => [h('button', { type: 'button', class: 'linkish', onclick: () => go('concept', c.accession) }, c.label),
        c.semantic_category, words(c.origin), c.currentness.support_located, c.currentness.support_stale, words(c.currentness.state)]))]),
    m.declared_bounds ? section('Declared processing bounds', [h('p', { class: 'mono' }, `${JSON.stringify(m.declared_bounds)} · model ${m.model_config.requested} · requested thinking ${m.model_config.thinking} · ${m.model_config.scaffold}. Surplus beyond a bound is listed under rejected output with its content.`)]) : null);
}

// ---- Aligned view: proposals relating concepts and subjects across collections. Originals stay visible,
// every link shows both quoted endpoints, and nothing here is accepted or merged.
const pinText = e => `${e.repository}:${e.path}:${e.start_line}${e.end_line !== e.start_line ? `–${e.end_line}` : ''} @${String(e.commit_sha).slice(0, 8)}`;
const conceptOf = key => state.aligned.byKey.get(key);
const inFilter = c => state.alignFilter.has(c.collection_id);

function endpointCard(end, tag) {
  return h('div', { class: 'endpoint' },
    h('div', { class: 'entry__head' }, h('span', { class: 'mono' }, `${tag} · ${end.collection_id}`), h('button', { type: 'button', class: 'linkish', onclick: () => go('aligned', `${end.generation_id}|${end.accession}`) }, end.label),
      h('span', { class: 'stamp stamp--muted' }, end.semantic_category), stamp(end.standing)),
    end.evidence.map(e => h('div', {}, h('blockquote', { class: 'quote' }, dedent(e.quote)),
      h('div', { class: 'source' }, h('span', {}, pinText(e)), stamp(e.standing), e.span_class && e.span_class !== 'code' ? h('span', { class: 'stamp stamp--muted' }, `${e.span_class} text`) : null,
        e.verified_at_pin ? h('span', { class: 'stamp stamp--muted', title: 'The quote was found in the pinned excerpt when the link was made' }, 'verified at pin') : null))));
}

function subjectEndpoint(e, tag) {
  return h('div', { class: 'endpoint' },
    h('div', { class: 'entry__head' }, h('span', { class: 'mono' }, `${tag} · ${e.collection_id}`), h('span', { class: 'entry__name' }, e.name), h('span', { class: 'mono' }, words(e.kind)), stamp(e.standing),
      e.basis === 'referenced_by_document' ? h('span', { class: 'stamp stamp--muted' }, 'referenced, not read') : null),
    h('blockquote', { class: 'quote' }, dedent(e.quote)), h('div', { class: 'source' }, h('span', {}, pinText(e))));
}

function linkEntry(l) {
  const subs = state.aligned.model.subject_links.filter(x => x.link_id === l.link_id);
  const hier = l.relation === 'broader' || l.relation === 'narrower';
  return h('div', { class: 'entry entry--link' },
    h('div', { class: 'entry__head' }, h('span', { class: 'predicate predicate--member' }, words(l.relation)), l.cross_kind ? h('span', { class: 'predicate' }, words(l.cross_kind)) : null,
      h('span', { class: 'stamp stamp--muted' }, `uncertainty ${l.uncertainty}`), l.carried_from ? h('span', { class: 'stamp stamp--muted' }, 'Carried unchanged') : null,
      null),
      h('p', { class: 'entry__note' }, l.reason),
    l.role_kind === 'governs' ? h('p', { class: 'entry__note' }, [h('span', { class: 'predicate' }, 'governs'), ` derived from "${l.via_subject.name}" (${words(l.via_subject.kind)}, ${words(l.via_subject.claim_standing)}); referenced, not read; ownership not verified.`]) : null,
    (l.retrieval ?? []).length ? h('p', { class: 'mono' }, `found by: ${l.retrieval.map(r => r.source === 'semantic' ? `semantic shortlist (${r.reason})` : r.source === 'lexical' ? `word overlap ${r.score}` : words(r.source)).join('; ')}`) : null,
    l.context_round === 2 ? h('p', { class: 'mono' }, `judged after a wider look at the same pin: ${l.context_receipt ? JSON.stringify(l.context_receipt.a) : ''}`) : null,
    hier ? h('p', { class: 'entry__note' }, ['Inclusion basis, quoted from the broader definition: ', h('em', {}, l.inclusion_basis)]) : null,
    h('div', { class: 'pair' }, endpointCard(l.a_endpoint, 'a'), endpointCard(l.b_endpoint, 'b')),
    l.source_observation ? h('p', { class: 'entry__note' }, `Observed in source for ${l.source_observation.source_concept.split('/').at(-1)}: ${l.source_observation.observed_instances} instance(s)${l.source_observation.observed_subjects.length ? ' — ' + l.source_observation.observed_subjects.map(x => x.name).join('; ') : ''}. A document claim is not an observation.`) : null,
    subs.length ? h('details', {}, h('summary', {}, `${subs.length} subject link(s)`), subs.map(x => h('div', { class: 'entry' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(x.relation)), x.from_side ? h('span', { class: 'mono' }, `from ${x.from_side}`) : null, h('span', { class: 'stamp stamp--muted' }, `uncertainty ${x.uncertainty}`)),
      h('p', { class: 'entry__note' }, x.reason), h('div', { class: 'pair' }, subjectEndpoint(x.a_endpoint, 'a'), subjectEndpoint(x.b_endpoint, 'b'))))) : null);
}

// A bounded neighbourhood: the chosen concept, the concepts it is linked to, labelled edges.
function egoMap(key) {
  const model = state.aligned.model, centre = conceptOf(key);
  const links = model.links.filter(l => [l.a_endpoint, l.b_endpoint].some(e => `${e.generation_id}|${e.accession}` === key));
  const neighbours = links.map(l => { const other = `${l.a_endpoint.generation_id}|${l.a_endpoint.accession}` === key ? l.b_endpoint : l.a_endpoint; return { l, key: `${other.generation_id}|${other.accession}`, c: conceptOf(`${other.generation_id}|${other.accession}`) }; }).slice(0, 12);
  const W = 760, H = Math.max(160, 40 + neighbours.length * 54);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Linked concepts' });
  const cy = H / 2;
  root.append(svg('g', { class: 'map-node' }, svg('rect', { x: 20, y: cy - 24, width: 230, height: 48, rx: 3 }), svg('text', { x: 28, y: cy - 4, class: 'map-node__label' }, centre.label.slice(0, 32)),
    svg('text', { x: 28, y: cy + 14, class: 'map-node__meta' }, `${centre.collection_id} · ${centre.semantic_category}`)));
  neighbours.forEach((n, i) => {
    const y = 30 + i * 54;
    root.append(svg('path', { d: `M250,${cy} C360,${cy} 400,${y + 20} 510,${y + 20}`, class: 'map-edge', fill: 'none' }));
    root.append(svg('text', { x: 380, y: (cy + y + 20) / 2 - 4, class: 'map-edge-label' }, `${words(n.l.relation)}${n.l.cross_kind ? ' · ' + words(n.l.cross_kind) : ''}`));
    root.append(svg('g', { class: 'map-node', tabindex: '0', role: 'link', onclick: () => go('aligned', n.key), onkeydown: e => { if (e.key === 'Enter') go('aligned', n.key); } },
      svg('rect', { x: 510, y, width: 230, height: 40, rx: 3 }), svg('text', { x: 518, y: y + 17, class: 'map-node__label' }, n.c.label.slice(0, 32)),
      svg('text', { x: 518, y: y + 32, class: 'map-node__meta' }, `${n.c.collection_id} · ${n.c.semantic_category}`)));
  });
  return h('div', { class: 'map-scroll' }, root);
}

function renderAligned(key) {
  const a = state.aligned, m = a.model;
  const chips = m.inputs.flatMap(i => i.collections.map(c => c.collection_id));
  const links = m.links.filter(l => inFilter(l.a_endpoint) || inFilter(l.b_endpoint)).filter(l => !key || [l.a_endpoint, l.b_endpoint].some(e => `${e.generation_id}|${e.accession}` === key));
  const hierarchy = m.hierarchy.filter(x => inFilter(conceptOf(x.broader)) && inFilter(conceptOf(x.narrower)));
  const roots = [...new Set(hierarchy.map(x => x.broader))].filter(k => !hierarchy.some(x => x.narrower === k));
  const tree = k => h('li', {}, conceptLinkKey(k), hierarchy.filter(x => x.broader === k).map(x => h('ul', {}, h('li', { title: x.inclusion_basis }, [h('span', { class: 'stamp stamp--muted' }, `narrower · ${x.uncertainty}`), ' ', conceptLinkKey(x.narrower)]))));
  const originals = [...a.byKey.values()].filter(inFilter);
  const unlinked = originals.filter(c => !c.links.length);
  return h('article', { class: 'reveal' },
    h('div', { class: 'card' }, h('h2', {}, key ? `Aligned · ${conceptOf(key).label}` : 'Aligned ontology'),
      h('p', { class: 'definition' }, 'Collections are processing boundaries, not evidence boundaries. Each proposal relates concepts or subjects interpreted separately; both quoted endpoints are shown, the originals are untouched, and nothing is merged or accepted.'),
      h('div', { class: 'chips' }, chips.map(c => h('button', { type: 'button', class: `chip${state.alignFilter.has(c) ? ' chip--on' : ''}`, 'aria-pressed': String(state.alignFilter.has(c)),
        onclick: () => { if (state.alignFilter.has(c)) state.alignFilter.delete(c); else state.alignFilter.add(c); render(); } }, c))),
      h('p', { class: 'mono' }, `${m.counts.links} link(s) · ${m.counts.hierarchy_links} hierarchy · ${m.counts.cross_kind_links} document↔source · ${m.counts.subject_links} subject link(s) · ${m.counts.judged_none} pair(s) judged unrelated · ${m.counts.rejected} rejected · ${m.counts.stale_links} stale · model ${m.model_config.requested} (thinking ${m.model_config.thinking}) ${m.model_config.scaffold}`),
      key ? h('p', {}, h('button', { type: 'button', class: 'linkish', onclick: () => go('aligned') }, '← all links')) : null),
    key ? section('Linked neighbourhood', [egoMap(key)]) : null,
    !key ? section('Policies and what they govern (read from the generation\'s own quoted assertions)', (m.governed_subjects ?? []).filter(x => state.alignFilter.has(x.collection_id)).map(x => h('div', { class: 'entry entry--link' },
      h('div', { class: 'entry__head' }, h('span', { class: 'predicate predicate--member' }, 'subject to'), h('span', { class: 'entry__name' }, x.subject.name), h('span', { class: 'mono' }, words(x.subject.kind)),
        h('span', { class: 'stamp stamp--muted' }, `policy: ${x.policy.label}`), stamp(x.subject.claim_standing),
        x.subject.referenced_not_read ? h('span', { class: 'stamp stamp--muted', title: 'Named in a document; the thing itself was not read and ownership or permission is not established' }, 'referenced, not read · ownership not verified') : null,
        x.subject.claim_standing === 'source_observed' ? h('span', { class: 'stamp stamp--muted', title: 'A status or label declared in source is a declaration; it is not an independent check that the property holds' }, 'declared in source · not independently verified') : null),
      h('p', { class: 'entry__note' }, 'A policy defines scope; the subject is subject_to it. This is a documented claim about the subject, not an identity between concepts.'),
      h('div', { class: 'pair' },
        h('div', { class: 'endpoint' }, h('div', { class: 'mono' }, `rule that defines the policy${x.rules.length ? '' : ' (none located)'}`), x.rules.map(r => h('div', {}, h('blockquote', { class: 'quote' }, dedent(r.quote)), h('div', { class: 'source' }, h('span', {}, pinText(r)), stamp(r.standing))))),
        h('div', { class: 'endpoint' }, h('div', { class: 'mono' }, 'governed subject'), h('blockquote', { class: 'quote' }, dedent(x.subject.evidence.quote)), h('div', { class: 'source' }, h('span', {}, pinText(x.subject.evidence)), stamp(x.subject.evidence.standing)))))),
    'No policy-governed subject in the selected collections.') : null,
    !key && roots.length ? section('Proposed hierarchy (needs an inclusion quote from the broader definition)', [h('ul', { class: 'tree' }, roots.map(tree))]) : null,
    section(key ? 'Links of this concept' : 'Cross-collection links', links.map(linkEntry), 'No link is proposed for the selected collections.'),
    !key ? section('Needs more context (not the same as no link)', [...(m.needs_context ?? []).map(n => h('div', { class: 'entry' }, h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, 'needs context'),
      h('span', {}, `${n.a_label} (${n.a_collection}) ↔ ${n.b_label} (${n.b_collection})`)), h('p', { class: 'entry__note' }, `Missing after the wider look: ${n.wanted}`),
      (n.retrieval ?? []).length ? h('p', { class: 'mono' }, `found by: ${n.retrieval.map(r => r.source === 'semantic' ? `semantic shortlist (${r.reason}${r.gap ? '; gap: ' + r.gap.text : ''})` : `word overlap ${r.score}`).join('; ')}`) : null)),
      ...(m.subject_needs_context ?? []).map(n => h('div', { class: 'entry' }, h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, 'subject needs context'), h('span', { class: 'mono' }, `${n.a_ref} ↔ ${n.b_ref}`)), h('p', { class: 'entry__note' }, n.wanted)))], 'Nothing is waiting on more context.') : null,
    !key ? section('Originals with no proposed link', [h('details', {}, h('summary', {}, `${unlinked.length} of ${originals.length} concept(s) are not linked`),
      unlinked.map(c => h('div', { class: 'rail-scheme' }, conceptLinkKey(c.key), ' ', h('span', { class: 'mono' }, `${c.collection_id} · ${c.semantic_category}`))))]) : null,
    !key ? section('Withheld or stale', [...m.withheld_concepts.map(w => h('div', { class: 'entry entry--counterexample' }, h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, words(w.reason)),
      h('span', { class: 'mono' }, `${w.collection_id} · ${w.accession.split('/').at(-1)}`)), h('p', { class: 'entry__note' }, 'Its support is not current, so it is kept out of current links.'))),
      ...m.stale_links.map(x => h('div', { class: 'entry entry--counterexample' }, h('div', { class: 'entry__head' }, h('span', { class: 'predicate' }, 'stale link'), h('span', {}, `${x.a_label} ↔ ${x.b_label}`)), h('p', { class: 'entry__note' }, words(x.reason))))]) : null,
    !key && m.candidate_pairs ? section('How pairs were chosen, and what was not examined', [h('p', { class: 'mono' }, `word overlap: ${m.candidate_pairs.lexical.kept} judged of ${m.candidate_pairs.lexical.considered} · semantic shortlist: ${m.candidate_pairs.semantic.proposed} proposed, ${m.candidate_pairs.semantic.added_beyond_lexical} beyond the word baseline (${m.candidate_pairs.semantic.added_judged_linked} linked, ${m.candidate_pairs.semantic.added_judged_none} judged unrelated, ${m.candidate_pairs.semantic.added_needs_context} need context)`),
      h('p', { class: 'entry__note' }, m.candidate_pairs.note),
      h('details', {}, h('summary', {}, `${m.candidate_pairs.lexical.over_count} pair(s) over the declared bound were NOT judged; ${m.candidate_pairs.semantic.rejected.length} semantic proposal(s) refused`),
        m.candidate_pairs.lexical.over_declared_bound.map(x => h('div', { class: 'rail-scheme' }, `${x.a} (${x.a_collection}) ↔ ${x.b} (${x.b_collection}) · score ${x.score}`)),
        m.candidate_pairs.semantic.rejected.map(x => h('div', { class: 'rail-scheme' }, `refused: ${x.code} ${x.a ?? ''} ${x.b ?? ''}`))),
      h('details', {}, h('summary', {}, `${m.candidate_pairs.semantic.proposed} semantic proposal(s)`), m.candidate_pairs.semantic.pairs.map(x => h('div', { class: 'rail-scheme' }, `${x.a} (${x.a_collection}) ↔ ${x.b} (${x.b_collection}) — ${x.reason}${x.gap?.text ? ' [gap: ' + x.gap.text + ']' : ''}`)))]) : null);
}
function conceptLinkKey(k) {
  const c = conceptOf(k);
  return h('button', { type: 'button', class: 'linkish', onclick: () => go('aligned', k) }, `${c.label} (${c.collection_id})`);
}

function renderMissing(id) {
  return h('article', { class: 'card' }, h('h2', {}, 'Not in this generation'), h('p', { class: 'mono' }, id));
}

function railVocabulary() {
  if (state.model.lazy) {
    return state.model.collections.map(c => h('details', { class: 'rail-group', ...(state.openRail?.has(c.collection_id) ? { open: '' } : {}), ontoggle: e => { (state.openRail ??= new Set())[e.target.open ? 'add' : 'delete'](c.collection_id); if (e.target.open && !e.target.dataset.filled) { e.target.dataset.filled = '1'; render(); } } },
      h('summary', { class: 'rail-group__title' }, c.collection_id, ' ', h('span', { class: 'muted' }, `${c.schemes.reduce((n, s) => n + s.concepts.length, 0)} concepts`)),
      state.openRail?.has(c.collection_id) ? c.schemes.map(s => [h('div', { class: 'rail-scheme', title: s.definition }, s.label),
        s.concepts.slice(0, 300).map(x => h('button', { type: 'button', class: 'rail-item', 'aria-current': String(location.hash === `#concept/${encodeURIComponent(x.accession)}`), onclick: () => go('concept', x.accession) },
          h('span', { class: 'rail-item__label' }, x.label), h('span', { class: 'rail-item__count', title: 'assertions' }, x.counts?.assertions ?? 0), h('span', { class: 'rail-item__meta' }, x.semantic_category))),
        s.concepts.length > 300 ? h('p', { class: 'muted' }, `${s.concepts.length - 300} more in this scheme are not listed here`) : null]) : null));
  }
  return state.model.collections.map(c => h('div', { class: 'rail-group' },
    h('div', { class: 'rail-group__title' }, h('span', {}, c.collection_id), h('span', { class: 'stamp stamp--muted' }, words(c.mode))),
    c.schemes.map(s => [h('div', { class: 'rail-scheme', title: s.definition }, s.label),
      s.concepts.map(x => h('button', { type: 'button', class: 'rail-item', 'aria-current': String(location.hash === `#concept/${encodeURIComponent(x.accession)}`),
        onclick: () => go('concept', x.accession) },
        h('span', { class: 'rail-item__label' }, x.label),
        h('span', { class: 'rail-item__count', title: 'instances' }, x.assertions.filter(a => a.membership).length),
        h('span', { class: 'rail-item__meta' }, x.semantic_category, stamp(x.standing.summary), words(x.origin),
          x.pending_changes.length ? h('span', { class: 'stamp stamp--muted' }, 'change pending') : null,
          x.blockers.length ? stamp('blocks_acceptance') : null)))])));
}

function railArtifacts() {
  const groups = Map.groupBy([...state.artifacts.values()], a => a.collection_id);
  return [...groups].map(([collection, artifacts]) => h('div', { class: 'rail-group' },
    h('div', { class: 'rail-group__title' }, collection),
    state.model.lazy && artifacts.length > 200 ? h('p', { class: 'muted' }, `Showing 200 of ${artifacts.length} units. Use the Estate view to find a source.`) : null,
    artifacts.slice(0, state.model.lazy ? 200 : Infinity).map(a => h('button', { type: 'button', class: 'rail-item', 'aria-current': String(location.hash === `#artifact/${encodeURIComponent(a.artifact_id)}`),
      onclick: () => go('artifact', a.artifact_id) },
      h('span', { class: 'rail-item__label' }, a.path.split('/').slice(-2).join('/')),
      h('span', { class: 'rail-item__count', title: 'subjects' }, a.referents.length),
      h('span', { class: 'rail-item__meta' }, a.artifact_id, stamp(a.standing), a.held_out ? 'held out' : null)))));
}

function railReview() {
  const m = state.model;
  return h('div', { class: 'rail-group' },
    h('button', { type: 'button', class: 'rail-item', onclick: () => go('review') },
      h('span', { class: 'rail-item__label' }, 'Pending decisions'), h('span', { class: 'rail-item__count' }, m.decisions_needed.length)),
    h('p', { class: 'mono' }, `${m.counts.acceptance_blockers_from_implemented_checks} blocker(s) from implemented checks · ${m.counts.pending_changes} change(s) · ${m.counts.rejected} rejected`));
}

// In an estate-sized generation the page holds a lean model; one concept or source is fetched when it is opened.
async function ensureDetail(kind, id) {
  if (!state.model.lazy) return false;
  if (kind === 'concept') {
    const entry = state.concepts.get(id);
    if (!entry || !entry.concept.lazy) return false;
    const response = await fetch(`/api/concept?accession=${encodeURIComponent(id)}`);
    const full = await response.json();
    if (full) { Object.assign(entry.concept, full, { lazy: false }); return true; }
  }
  if (kind === 'artifact') {
    const entry = state.artifacts.get(id);
    if (!entry || !entry.lazy) return false;
    const full = await (await fetch(`/api/artifact?id=${encodeURIComponent(id)}`)).json();
    if (full) { Object.assign(entry, full, { lazy: false }); return true; }
  }
  return false;
}

function render() {
  const [kind, ...rest] = location.hash.slice(1).split('/');
  const id = decodeURIComponent(rest.join('/'));
  if (state.model?.lazy && (kind === 'concept' || kind === 'artifact') && !state.fetched?.has(`${kind}|${id}`)) {
    (state.fetched ??= new Set()).add(`${kind}|${id}`);
    ensureDetail(kind, id).then(() => render(), () => render());
    return;
  }
  if (kind === 'reconcile' && state.reconcileView) {
    state.tab = 'reconcile';
    document.getElementById('shell').classList.add('is-graph');
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === 'reconcile'));
    document.getElementById('detail').replaceChildren(state.reconcileView.render());
    document.getElementById('rail-body').replaceChildren();
    return;
  }
  if ((!kind || kind === 'estate' || kind === 'reconcile') && state.estateView) {
    state.tab = 'estate';
    document.getElementById('shell').classList.add('is-graph');
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === 'estate'));
    document.getElementById('detail').replaceChildren(state.estateView.render());
    document.getElementById('rail-body').replaceChildren();
    return;
  }
  if ((!kind || kind === 'graph') && state.graphView && !state.estateView) {
    state.tab = 'graph';
    for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === 'graph'));
    document.getElementById('shell').classList.add('is-graph');
    state.graphView.applyRoute(rest);
    state.graphView.render(document.getElementById('detail'), document.getElementById('rail-body'));
    return;
  }
  document.getElementById('shell').classList.remove('is-graph');
  if (kind === 'vocabulary') state.tab = 'vocabulary';
  if (kind === 'artifacts') state.tab = 'artifacts';
  if (kind === 'artifact') state.tab = state.tab === 'review' ? 'artifacts' : state.tab;
  if (kind === 'review') state.tab = 'review';
  if (kind === 'aligned') state.tab = 'aligned';
  if (kind === 'map') state.tab = 'map';
  if (kind === 'revisions') state.tab = 'revisions';
  const detail = document.getElementById('detail');
  detail.replaceChildren(kind === 'artifact' ? renderArtifact(id) : kind === 'review' ? renderReview()
    : kind === 'aligned' && state.aligned ? renderAligned(id || null) : kind === 'map' ? renderMap() : kind === 'revisions' ? renderRevisions()
    : kind === 'artifacts' ? renderArtifact(id || state.artifacts.keys().next().value) : renderConcept(kind === 'concept' ? id : state.concepts.keys().next().value));
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
  document.getElementById('rail-body').replaceChildren(...[state.tab === 'artifacts' ? railArtifacts()
    : state.tab === 'review' ? railReview() : railVocabulary()].flat());
  detail.focus({ preventScroll: true });
}

function masthead(m) {
  document.getElementById('title').textContent = m.collections.map(c => c.collection_id).join(', ');
  document.getElementById('provenance').textContent = `Generation ${m.generation_id.split(':').at(-1).slice(0, 16)}…`;
  document.getElementById('provenance').title = m.generation_id;
  const counts = [['Concepts', m.counts.concepts], ['Subjects', m.counts.referents], ['Assertions', m.counts.assertions], ['Pending decisions', m.decisions_needed.length],
    ['Not interpreted', m.counts.unsupported_binary]];
  document.getElementById('counts').replaceChildren(...counts.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))));
  document.getElementById('legend').replaceChildren(h('span', {}, 'Source check, review and kind of evidence are separate facts. Each selected item shows all three.'));
}

async function main() {
  const response = await fetch('/api/view-model', { cache: 'no-store' });
  if (!response.ok) throw new Error(`view model ${response.status}`);
  const model = await response.json();
  state.model = model;
  for (const collection of model.collections) for (const scheme of collection.schemes) for (const concept of scheme.concepts) {
    state.concepts.set(concept.accession, { concept, scheme, collection });
  }
  for (const artifact of model.artifacts) state.artifacts.set(artifact.artifact_id, artifact);
  try {
    const aligned = await fetch('/api/alignment', { cache: 'no-store' });
    if (aligned.ok) {
      const am = await aligned.json();
      state.aligned = { model: am, byKey: new Map(am.concepts.map(c => [c.key, c])) };
      state.alignFilter = new Set(am.inputs.flatMap(i => i.collections.map(c => c.collection_id)));
      document.querySelector('[data-tab="aligned"]')?.removeAttribute('hidden');
    }
  } catch { /* no alignment is served */ }
  try {
    const graphResponse = await fetch('/api/graph', { cache: 'no-store' });
    if (graphResponse.ok) {
      state.graphView = createGraphView({ h, svg, words, short, quoteBlock: o => h('blockquote', { class: 'quote' }, dedent(o.quote)), pinText, stamp });
      state.graphView.load(await graphResponse.json());
    }
  } catch { /* the page falls back to the vocabulary views */ }
  try {
    const estateResponse = await fetch('/api/estate', { cache: 'no-store' });
    if (estateResponse.ok) {
      state.estateView = createEstateView({ h, words, go, state: Object.assign(state, { rerender: () => render() }) });
      state.estateView.load(await estateResponse.json());
      document.querySelector('[data-tab="estate"]')?.removeAttribute('hidden');
      if (!state.graphView?.state.graph?.chains.length) document.querySelector('[data-tab="graph"]')?.setAttribute('hidden', '');
    }
  } catch { /* not an estate view */ }
  try {
    const reconcileResponse = await fetch('/api/reconcile', { cache: 'no-store' });
    if (reconcileResponse.ok) {
      state.reconcileView = createReconcileView({ h, words, go, state: Object.assign(state, { rerender: () => render() }) });
      state.reconcileView.load(await reconcileResponse.json());
      document.querySelector('[data-tab="reconcile"]')?.removeAttribute('hidden');
      if (!location.hash || location.hash === '#estate') location.hash = '#reconcile';
    }
  } catch { /* no reconciliation served */ }
  if (state.model.lazy) document.querySelector('[data-tab="map"]')?.setAttribute('hidden', '');
  if (!state.graphView && !state.estateView) { state.tab = 'vocabulary'; document.querySelector('[data-tab="graph"]')?.setAttribute('hidden', ''); }
  masthead(model);
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => { state.tab = tab.dataset.tab; go(state.tab); });
  }
  window.addEventListener('hashchange', render);
  render();
}

main().catch(error => {
  document.getElementById('detail').replaceChildren(h('article', { class: 'card' }, h('h2', {}, 'Could not load'), h('p', { class: 'mono' }, error.message)));
});
