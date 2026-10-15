// Paid-answer reuse for the documentary claims layer
// (docs/delta-updatable-estate-maps.md "Paid answer reuse and documentary campaigns").
//
// tools/semantic-claim-extractor.mjs's extractSemanticClaims() already reuses an answer from its
// OWN run's journal -- resumability, keyed by `prompt_digest = sha256(prompt)`, where `prompt` is
// built ONLY from the window's path, author outline, and numbered content
// (buildExtractionPrompt()). It never renders a repository pin, a source SHA, or code facts, so
// the exact same window content at two different commits renders the exact same prompt and the
// exact same digest -- the design's "excluded from paid-request identity ... only when the
// rendered prompt does not contain them" holds today by construction, not by a new field this
// module adds.
//
// This module extends that SAME identity across epochs: a window whose exact rendered prompt
// matches an entry in a PARENT epoch's retained, read-only journal is imported into the current
// run's own journal before extraction starts, so extractSemanticClaims's existing (and already
// tested) journal-hit path reuses it -- never re-dispatched, never re-priced, and never rewritten:
// the original answer bytes travel unchanged, with `reused_from_parent` added as custody, never
// substituted into `answer`/`outcome`/`usage`, matching "it must never rewrite old bytes as if the
// current producer emitted them."
//
// A window with no match anywhere is a NEW window: the plan and the merge both name it as such and
// leave it to the caller to either dispatch it for real (an ordinary paid extraction run) or, in an
// explicitly offline/zero-spend run, refuse it with offlineNoDispatchRunner() below -- never guess
// an answer, never fall back to a nearby prompt.
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from '../lib.mjs';
import {
  buildExtractionPrompt, DEFAULT_WINDOW_BYTES, MAX_CLAIMS_PER_WINDOW, windowDocument,
} from '../semantic-claim-extractor.mjs';

export const DOCUMENTARY_REUSE_PLAN_SCHEMA = 'estate-map/documentary-reuse-plan/v1';

const compare = (left, right) => left.localeCompare(right);

/**
 * The same admission rule extractSemanticClaims's private loadJournal() applies: only a terminal
 * 'ok' answer with its prompt digest and payload intact is a usable cache hit. A corrupt or
 * partial line is skipped, never guessed at -- the same fail-closed reading the design's cache
 * precedent requires. Exported so a caller (a plan, a merge, a test) can inspect a retained journal
 * without re-deriving this rule.
 *
 * MODEL SCOPING (opt-in). `paid_request_identity` includes the model, provider, and route
 * (docs/delta-updatable-estate-maps.md) -- an answer from one model is not interchangeable with an
 * answer from another, even for the byte-identical prompt. `expected_model`, when given, restricts
 * this journal to entries that RECORD that exact model (tools/semantic-claim-extractor.mjs writes
 * `model` on every entry it appends); an entry with no recorded model (every journal written before
 * that field existed) is refused rather than assumed to match -- see backfillJournalModel() below
 * for how to make an old journal's provenance explicit instead of guessing at reuse time. Omitting
 * `expected_model` entirely (the default) is unchanged from before this parameter existed: every
 * usable entry loads, regardless of what model (if any) it names.
 */
export function loadAnswerJournal(path, { expected_model: expectedModel } = {}) {
  const held = new Map();
  if (!path || !existsSync(path)) return held;
  for (const row of readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(row); } catch { continue; }
    if (!(entry?.prompt_digest && entry.outcome === 'ok' && entry.answer)) continue;
    if (expectedModel !== undefined && entry.model !== expectedModel) continue;
    held.set(entry.prompt_digest, entry);
  }
  return held;
}

/**
 * Make an old journal's model provenance explicit, once, as its own auditable step -- never
 * inferred at reuse time. Adds `model` to every entry that does not already carry one; refuses
 * (throws) if an entry already names a DIFFERENT model, rather than silently overwriting a
 * genuinely mixed-provenance file. Idempotent: re-running with the same model on an
 * already-backfilled file changes nothing.
 */
export function backfillJournalModel({ path, model }) {
  if (!model) throw new Error('backfillJournalModel requires a model name');
  if (!existsSync(path)) return { rows: 0, backfilled: 0 };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean);
  let backfilled = 0;
  const rewritten = lines.map(row => {
    let entry;
    try { entry = JSON.parse(row); } catch { return row; }
    if (entry.model == null) { backfilled += 1; return JSON.stringify({ ...entry, model }); }
    if (entry.model !== model) {
      throw new Error(`refusing to backfill ${path}: an entry already names model "${entry.model}", not "${model}" -- this journal's provenance is not uniform`);
    }
    return row;
  });
  if (backfilled) writeFileSync(path, `${rewritten.join('\n')}\n`);
  return { rows: lines.length, backfilled };
}

function currentWindows({ document_paths: documentPaths, materialized_root: materializedRoot, window_bytes: windowBytes }) {
  const windows = [];
  for (const path of documentPaths.slice().sort(compare)) {
    windows.push(...windowDocument({
      path, content: readFileSync(join(materializedRoot, path), 'utf8'), maxBytes: windowBytes,
    }));
  }
  return windows;
}

/**
 * Zero-cost, offline plan: for every window the CURRENT document scope would extract, which parent
 * journal (if any, checked in the given priority order -- the first match is the one that would
 * actually be reused) already carries a usable answer for its EXACT rendered prompt, and which
 * windows have no match anywhere and would need a live dispatch. Reads no live model and writes
 * nothing.
 */
export function planDocumentaryReuse({
  document_paths: documentPaths, materialized_root: materializedRoot,
  window_bytes: windowBytes = DEFAULT_WINDOW_BYTES, max_claims_per_window: maxClaims = MAX_CLAIMS_PER_WINDOW,
  // Each entry is {label, path, model?}. `model`, when given, restricts that parent to entries
  // recorded as answered by exactly that model -- model-scoped reuse (see loadAnswerJournal()).
  // Omitted: unchanged, permissive loading, as before this parameter existed.
  parent_journals: parentJournals = [],
}) {
  const windows = currentWindows({ document_paths: documentPaths, materialized_root: materializedRoot, window_bytes: windowBytes });
  const parents = parentJournals.map(entry => ({
    label: entry.label,
    journal: loadAnswerJournal(entry.path, entry.model === undefined ? {} : { expected_model: entry.model }),
  }));
  const reusableWindows = [];
  const newWindows = [];
  const reusableByParent = Object.fromEntries(parents.map(row => [row.label, 0]));
  for (const window of windows) {
    const promptDigest = sha256(buildExtractionPrompt({ window, max_claims: maxClaims }));
    const hit = parents.find(row => row.journal.has(promptDigest));
    if (hit) {
      reusableByParent[hit.label] += 1;
      reusableWindows.push({ path: window.path, start_line: window.start_line, prompt_digest: promptDigest, reused_from: hit.label });
    } else {
      newWindows.push({ path: window.path, start_line: window.start_line, prompt_digest: promptDigest });
    }
  }
  const body = {
    schema: DOCUMENTARY_REUSE_PLAN_SCHEMA,
    parent_journals: parents.map(row => row.label),
    windows: windows.length,
    reusable: reusableWindows.length,
    new: newWindows.length,
    reusable_by_parent: reusableByParent,
    reusable_windows: reusableWindows,
    new_windows: newWindows,
  };
  return Object.freeze(body);
}

/**
 * Seed a run's OWN journal -- the file extractSemanticClaims's `journal_dir` mechanism reads for
 * resumability and writes every fresh call to -- with every 'ok' answer a parent journal carries
 * for a prompt this run's own journal does not already have. Idempotent: safe to call more than
 * once, and never overwrites an entry this run already produced or already imported (own-journal
 * and earlier-parent hits both take priority over a later parent, so `parent_journals`' order is
 * the reuse priority order).
 *
 * Each imported row keeps every original field -- `answer`, `outcome`, `usage`, `answer_digest` --
 * byte-for-byte and adds only `reused_from_parent`, so a reused row is distinguishable from one
 * this run actually dispatched without touching any field extractSemanticClaims's own loadJournal()
 * reads.
 */
export function mergeParentAnswers({ own_journal_path: ownJournalPath, parent_journals: parentJournals = [] }) {
  const present = loadAnswerJournal(ownJournalPath);
  mkdirSync(dirname(ownJournalPath), { recursive: true });
  const importedByParent = {};
  for (const { label, path, model } of parentJournals) {
    let imported = 0;
    for (const [digest, entry] of loadAnswerJournal(path, model === undefined ? {} : { expected_model: model })) {
      if (present.has(digest)) continue;
      const row = { ...entry, reused_from_parent: label };
      appendFileSync(ownJournalPath, `${JSON.stringify(row)}\n`);
      present.set(digest, row);
      imported += 1;
    }
    importedByParent[label] = imported;
  }
  return Object.freeze({ imported_by_parent: importedByParent, total_after_merge: present.size });
}

/**
 * A ModelRunner (tools/neural-model-runner.mjs's `{model, kind, complete()}` shape) that never
 * dispatches. Paired with mergeParentAnswers(), a run using this runner reuses every window a
 * parent journal already answers and cleanly, typedly refuses every window that has no match --
 * `pre_dispatch_refused:offline_no_new_dispatch`, counted by extractSemanticClaims as a window
 * refusal (never a claim, never a guess, never a live call) -- so a plan-only invocation can never
 * spend by construction, not merely by convention. `dispatched: false` tells
 * extractSemanticClaims's own conservation counting so explicitly: this outcome is counted under
 * `offline_refusals`, never under `model_calls` (tools/semantic-claim-extractor.mjs).
 */
export function offlineNoDispatchRunner({ model = 'offline/no-dispatch' } = {}) {
  return Object.freeze({
    kind: 'offline-no-dispatch',
    model,
    async complete() {
      return { outcome: 'pre_dispatch_refused:offline_no_new_dispatch', accepted: false,
        json: null, text: '', usage: null, model, dispatched: false };
    },
  });
}
