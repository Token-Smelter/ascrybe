// DOCUMENT-STRUCTURE extractor.
//
// A document is currently a flat bag: claims carry a path and a line, and nothing records that a
// line sits under "## Known limitations" rather than "## Guarantees". Those two sections make
// opposite assertions, and a reader given only line numbers cannot tell which one it is holding.
// The document's own headings are the author's declared organization — deterministic, free, and
// lost until now.
//
// Two fact kinds, and the distinction between them matters:
//
//   document_section  one heading: its level, title, span, and the path of ancestors above it.
//                     The span runs to the next heading at the same or shallower level, so a
//                     section OWNS its subsections rather than ending where the next one begins.
//   document          the file itself: heading count, maximum depth, line and byte size. A
//                     document with no headings is still a document, and saying so is what makes
//                     "this corpus has 300 unstructured files" answerable.
//
// Fenced code is skipped when locating headings — a `# comment` inside a shell block is not a
// section, and treating it as one silently reorganizes the document around a line of code.
//
// The section path is the addressable part: ['Design', 'Constraints', 'Known limitations'] locates
// a claim in the author's own outline without depending on line numbers that every edit shifts.

const FENCE = /^\s*(?:`{3,}|~{3,})/u;
const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const SETEXT = /^\s*(={3,}|-{3,})\s*$/u;

const clean = value => String(value ?? '').trim();

// A heading's own numbering ("### 4.2 Identity") is how documents cross-reference themselves, so
// it is kept separately from the prose title rather than folded into it.
const NUMBERED = /^((?:\d+\.)*\d+)\s+(.*)$/u;

function headings(lines) {
  const rows = [];
  let fenced = false;
  lines.forEach((raw, index) => {
    if (FENCE.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    const atx = ATX.exec(raw);
    if (atx) {
      rows.push({ level: atx[1].length, text: clean(atx[2]), line: index + 1, style: 'atx' });
      return;
    }
    // Setext underlines apply to the line above, which must be prose rather than blank.
    const setext = SETEXT.exec(raw);
    if (setext && clean(lines[index - 1] ?? '') && !ATX.test(lines[index - 1] ?? '')) {
      rows.push({ level: setext[1].startsWith('=') ? 1 : 2, text: clean(lines[index - 1]), line: index, style: 'setext' });
    }
  });
  return rows;
}

export default {
  kind: 'document_section',
  filePattern: /\.mdx?$/iu,
  scan(lines, ctx) {
    const facts = [];
    const document = ctx.document ?? {};
    // Standing travels with structure for the same reason it travels with drawings: a section of
    // a research note is not a section of a specification, and a reader resolving a claim to its
    // section needs to know which it is holding.
    const standing = {
      document_mode: document.mode ?? null,
      adjudication_frame: document.adjudication_frame ?? null,
      document_archived: document.archived ?? null,
    };
    const found = headings(lines);
    facts.push(ctx.fact('document', 1, {
      ...standing,
      line_count: lines.length,
      byte_length: Buffer.byteLength(lines.join('\n')),
      heading_count: found.length,
      max_heading_level: found.reduce((deepest, row) => Math.max(deepest, row.level), 0),
      // An unstructured document is a finding, not an absence: it cannot locate its own claims.
      has_structure: found.length > 0,
    }));
    const ancestors = [];
    found.forEach((heading, index) => {
      while (ancestors.length && ancestors.at(-1).level >= heading.level) ancestors.pop();
      // A section ends where the next heading at its own level or shallower begins, so it owns
      // everything nested beneath it rather than stopping at its first subsection.
      const next = found.slice(index + 1).find(row => row.level <= heading.level);
      const numbered = NUMBERED.exec(heading.text);
      const path = [...ancestors.map(row => row.text), heading.text];
      facts.push(ctx.fact('document_section', heading.line, {
        ...standing,
        heading_level: heading.level,
        heading_style: heading.style,
        heading_text: heading.text,
        section_number: numbered ? numbered[1] : null,
        section_title: numbered ? clean(numbered[2]) : heading.text,
        // The addressable form: the author's outline, independent of line numbers that shift.
        section_path: path.join(' / '),
        section_depth: path.length,
        parent_section_path: ancestors.length ? ancestors.map(row => row.text).join(' / ') : null,
        line_end: next ? next.line - 1 : lines.length,
      }));
      ancestors.push(heading);
    });
    return facts;
  },
};
