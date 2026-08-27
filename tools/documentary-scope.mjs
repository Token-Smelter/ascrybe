// What the paid claim extraction is allowed to read.
//
// The documentary corpus had no scope rule at all: every markdown file at the pinned commit went
// to the model. The code plane has had a scope taxonomy since it was written -- categories with
// descriptions, counted per category and reported in the manifest -- and the documentary side got
// none, which is how 244 documents that nothing can refute ended up in a run priced by the window.
//
// Two mechanisms, because they answer different questions.
//
// DERIVED. The document classifier already computes an adjudication frame for free, and `none`
// means no current standing: a log, or archived material. A claim extracted from a document that
// nothing can refute is a claim no adjudicator can ever act on, so paying to extract it buys
// nothing. This rule needs no configuration and generalizes to estates nobody has looked at.
//
// DECLARED. Some exclusions are judgement a classifier cannot make -- a retired subsystem, an
// assembled review package whose contents are copies of documents already in the corpus. Those
// are named in configuration, with a category and a reason, in the shape the code plane uses.
//
// SKIP IS NOT DELETE. An excluded document is still extracted structurally, still becomes a node
// carrying its mode and frame, and is still counted here. Only the paid extraction skips it. The
// fact that a document exists and says something is real whether or not anyone interrogates it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyDocument } from './document-mode.mjs';

export const DOCUMENTARY_SCOPE_SCHEMA = 'ascrybe/documentary-scope/v1';

/** The frame that means "nothing can refute this", and so nothing can adjudicate a claim from it. */
export const UNADJUDICABLE_FRAME = 'none';

function compiled(rules) {
  return rules.map(rule => {
    const prefixes = Array.isArray(rule.path_prefixes) ? rule.path_prefixes : [];
    const patterns = (Array.isArray(rule.path_patterns) ? rule.path_patterns : []).map(p => new RegExp(p, 'u'));
    return { category: rule.category, description: rule.description ?? null,
      match: path => prefixes.some(prefix => path.startsWith(prefix)) || patterns.some(re => re.test(path)) };
  });
}

/**
 * Partition a documentary corpus into what the model will read and what it will not, with every
 * exclusion attributed to the rule that made it.
 */
export function documentaryScope({ paths, materialized_root: root, exclusions = [],
  skip_unadjudicable: skipUnadjudicable = true }) {
  const declared = compiled(exclusions);
  const included = [];
  const excluded = [];
  for (const path of paths) {
    const rule = declared.find(candidate => candidate.match(path));
    if (rule) { excluded.push({ path, category: rule.category, basis: 'declared' }); continue; }
    if (!skipUnadjudicable) { included.push(path); continue; }
    let text = '';
    try { text = readFileSync(join(root, path), 'utf8'); } catch { included.push(path); continue; }
    const held = classifyDocument({ path, text });
    if (held.adjudication_frame === UNADJUDICABLE_FRAME) {
      excluded.push({ path, category: 'no_adjudication_frame', basis: 'derived',
        document_mode: held.mode, archived: held.archived });
      continue;
    }
    included.push(path);
  }
  const byCategory = {};
  for (const row of excluded) byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  return Object.freeze({
    schema: DOCUMENTARY_SCOPE_SCHEMA,
    included,
    excluded,
    counts: {
      offered: paths.length,
      included: included.length,
      excluded: excluded.length,
      // Named per category so a corpus that shrank can be read, not guessed at.
      excluded_by_category: Object.fromEntries(Object.entries(byCategory).sort(([l], [r]) => (l < r ? -1 : 1))),
    },
    rules: {
      derived: skipUnadjudicable ? [{ category: 'no_adjudication_frame',
        description: 'the classifier found no frame in which the document could be refuted' }] : [],
      declared: exclusions.map(rule => ({ category: rule.category, description: rule.description ?? null,
        path_prefixes: rule.path_prefixes ?? [], path_patterns: rule.path_patterns ?? [] })),
    },
  });
}
