// DIAGRAM-RELATION extractor.
//
// A mermaid flowchart is the most structured thing in a documentary corpus. `TaskOrch -->|publishes|
// Envelope` is a typed edge with two endpoints, authored deliberately, in a machine-parseable
// grammar — and until now it was discarded. `structured-source.mjs` refuses diagram fences for a
// good reason: running a key/value scanner over `A --> B` mints observations like `BOOT = BOOT`
// stamped with deterministic-structure authority. The mistake was concluding that diagrams
// therefore carry no structure, rather than that they carry a DIFFERENT KIND of structure.
//
// What a diagram edge is, exactly: an author's claim about how the system is arranged. It is not
// an observation of the code and must never be adjudicated as one. A design document may draw a
// component that was never built, or draw an arrow the implementation reversed — those are the
// findings this extractor exists to make visible, and they are only visible if the drawn edge is
// recorded as DRAWN rather than silently promoted to fact or silently dropped.
//
// So every fact here carries `assertion: 'documented'` and its diagram's syntax and fence address.
// The relation family is the author's own edge label when they wrote one (`-->|publishes|`),
// preserved verbatim rather than mapped onto the code vocabulary: a document saying "publishes"
// and a producer emitting `publishes_envelope` agreeing is a finding, and pre-collapsing them
// into one name destroys the very comparison that makes the diagram worth extracting.
//
// Node labels are kept because they are how a human names the thing (`ROOT["Atomic root"]`), while
// the identifier is how the diagram references it. Both are needed: the identifier joins edges
// within the diagram, the label is what a reader would match against an entity surface.

const FENCE = /^\s*(?:`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/;
const CLOSE = /^\s*(?:`{3,}|~{3,})\s*$/;
const DIAGRAM_LANGUAGES = new Set(['mermaid', 'plantuml', 'puml', 'dot', 'graphviz']);

// Mermaid flowchart/graph edges. The arrow forms differ in meaning to a reader (dotted, thick,
// open) and the difference is preserved as the arrow's literal text rather than normalized away.
const MERMAID_EDGE = new RegExp([
  '^\\s*',
  '([A-Za-z_][\\w-]*)',                        // source identifier
  '(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}|>[^\\]]*\\]))?', // optional source shape/label
  // Longest form first: an alternation that tries `-->` before `--->` leaves the extra `-` to be
  // read as part of the target, which turned `R1 -->|104 kinds| OUT` into an arrow of `--->->`.
  '\\s*(<-{2,3}|={2,3}>|-\\.->|-\\.-|-{3}>|-{2}>|-{3}|-{2}|o-{2,2}o|x-{2,2}x)', // arrow
  '(?:\\|([^|]*)\\|)?',                        // optional edge label
  '\\s*([A-Za-z_][\\w-]*)',                    // target identifier
  '(?:\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}|>[^\\]]*\\]))?', // optional target shape/label
].join(''), 'u');

// A node declaration carries the human label: ROOT["Atomic root"], Store[(Database)], A{Decision}.
const MERMAID_NODE = /^\s*([A-Za-z_][\w-]*)\s*(?:\[\(?"?([^"\]()]+)"?\)?\]|\(\("?([^"()]+)"?\)\)|\("?([^"()]+)"?\)|\{"?([^"{}]+)"?\})/u;

// Sequence diagrams state participation and message flow; both are architectural assertions.
const SEQUENCE_PARTICIPANT = /^\s*(?:participant|actor)\s+([A-Za-z_][\w-]*)(?:\s+as\s+(.+?))?\s*$/iu;
const SEQUENCE_MESSAGE = /^\s*([A-Za-z_][\w-]*)\s*(-?->>?|--?\)|-?-x)\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/u;

const KEYWORDS = new Set(['flowchart', 'graph', 'subgraph', 'end', 'classdef', 'class', 'style', 'click',
  'sequencediagram', 'statediagram', 'erdiagram', 'gantt', 'title', 'section', 'digraph', 'rankdir',
  'direction', 'note', 'over', 'left', 'right', 'participant', 'actor', 'loop', 'alt', 'else', 'opt',
  'par', 'and', 'rect', 'activate', 'deactivate', 'autonumber', 'accTitle', 'accDescr']);

const clean = value => String(value ?? '').trim();
const identifier = value => {
  const held = clean(value);
  return held && !KEYWORDS.has(held.toLowerCase()) ? held : null;
};

function diagramKind(body) {
  const first = body.find(line => clean(line)) ?? '';
  const held = clean(first).toLowerCase();
  if (held.startsWith('sequencediagram')) return 'sequence';
  if (held.startsWith('erdiagram')) return 'entity_relationship';
  if (held.startsWith('statediagram')) return 'state';
  if (held.startsWith('classdiagram')) return 'class';
  if (held.startsWith('flowchart') || held.startsWith('graph') || held.startsWith('digraph')) return 'flow';
  return 'unknown';
}

// A diagram's own existence is the primary fact. Its identifiers are diagram-local shorthand —
// measured across 615 host-runtime documents, 78% of them name nothing in the estate — so the fence
// itself, kept verbatim, is what a reader can always trust: this document drew this, here. Edges
// extracted from it are assertions ABOUT that drawing, not a substitute for it, and grounding a
// drawn identifier to a real entity is a later receipt-backed step. An ungrounded assertion is
// honest; a wrongly grounded one would be the failure this map exists to refuse.
function scanDiagram({ body, startLine, syntax, ctx, facts, mode }) {
  const shape = diagramKind(body);
  const text = body.join('\n');
  const address = `${ctx.file}:${startLine}`;
  facts.push(ctx.fact('diagram', startLine, {
    assertion: 'documented', ...mode, diagram_syntax: syntax, diagram_shape: shape,
    diagram_address: address, line_end: startLine + body.length - 1,
    line_count: body.length, byte_length: Buffer.byteLength(text),
    // Verbatim, so a reader can render or re-parse the drawing without the document.
    diagram_text: text,
  }));
  const labels = new Map();
  const seenNodes = new Set();
  const declare = (id, label, line) => {
    const held = identifier(id);
    if (!held) return null;
    if (label && !labels.has(held)) labels.set(held, clean(label));
    if (!seenNodes.has(held)) {
      seenNodes.add(held);
      facts.push(ctx.fact('diagram_node', line, {
        assertion: 'documented', ...mode, diagram_syntax: syntax, diagram_shape: shape,
        diagram_address: address, node_identifier: held, node_label: labels.get(held) ?? null,
        diagram_start_line: startLine,
      }));
    }
    return held;
  };

  body.forEach((rawLine, index) => {
    const line = startLine + index;
    const text = rawLine.replace(/%%.*$/u, '');
    if (!clean(text)) return;

    const node = MERMAID_NODE.exec(text);
    if (node) declare(node[1], node[2] ?? node[3] ?? node[4] ?? node[5], line);

    const participant = SEQUENCE_PARTICIPANT.exec(text);
    if (participant) { declare(participant[1], participant[2], line); return; }

    const message = SEQUENCE_MESSAGE.exec(text);
    if (message) {
      const from = declare(message[1], null, line);
      const to = declare(message[3], null, line);
      if (from && to) {
        facts.push(ctx.fact('diagram_relation', line, {
          assertion: 'documented', ...mode, diagram_syntax: syntax, diagram_shape: shape,
          subject_kind: 'relation', from_resolution: 'unresolved', to_resolution: 'unresolved',
          diagram_address: address, from_identifier: from, to_identifier: to, arrow: clean(message[2]),
          // A sequence message's text is the author's own name for the interaction.
          relation_label: clean(message[4]), diagram_start_line: startLine,
        }));
      }
      return;
    }

    const edge = MERMAID_EDGE.exec(text);
    if (!edge) return;
    const nodeLabels = /(?:\[\(?"?([^"\]()]+)"?\)?\]|\(\("?([^"()]+)"?\)\)|\("?([^"()]+)"?\)|\{"?([^"{}]+)"?\})/gu;
    const inline = [...text.matchAll(nodeLabels)].map(match => match[1] ?? match[2] ?? match[3] ?? match[4]);
    const from = declare(edge[1], inline[0], line);
    const to = declare(edge[4], inline[inline.length - 1], line);
    if (!from || !to) return;
    facts.push(ctx.fact('diagram_relation', line, {
      assertion: 'documented', ...mode, diagram_syntax: syntax, diagram_shape: shape,
      // The subject is a RELATION whose endpoints are the identifiers as written. They ground to
      // nothing until a receipted resolver says otherwise, and the verbatim text stays regardless.
      subject_kind: 'relation', from_resolution: 'unresolved', to_resolution: 'unresolved',
      diagram_address: address, from_identifier: from, to_identifier: to, arrow: clean(edge[2]),
      // Verbatim, never mapped onto the code relation vocabulary: a document saying "publishes"
      // and a producer emitting publishes_envelope agreeing is exactly the finding to preserve.
      relation_label: edge[3] === undefined ? null : clean(edge[3]),
      from_label: labels.get(from) ?? null, to_label: labels.get(to) ?? null,
      diagram_start_line: startLine,
    }));
  });
}

export default {
  kind: 'diagram_relation',
  filePattern: /\.mdx?$/iu,
  scan(lines, ctx) {
    const facts = [];
    // A drawing inherits the standing of the document that drew it: one in research/ or archive/
    // is not a claim about the current system, and stamping every fence identically would undo
    // exactly what document mode exists to prevent. The harness classifies the file — an
    // extractor must load standalone, so it reads the decision rather than importing the
    // classifier from outside its own directory.
    const document = ctx.document ?? {};
    const mode = Object.freeze({ document_mode: document.mode ?? null,
      document_mode_basis: document.basis ?? null,
      adjudication_frame: document.adjudication_frame ?? null,
      document_archived: document.archived ?? null });
    let index = 0;
    while (index < lines.length) {
      const open = FENCE.exec(lines[index] ?? '');
      const syntax = open ? clean(open[1]).toLowerCase() : null;
      if (!syntax || !DIAGRAM_LANGUAGES.has(syntax)) { index += 1; continue; }
      let end = index + 1;
      while (end < lines.length && !CLOSE.test(lines[end] ?? '')) end += 1;
      scanDiagram({ body: lines.slice(index + 1, end), startLine: index + 2, syntax, ctx, facts, mode });
      index = end + 1;
    }
    return facts;
  },
};
