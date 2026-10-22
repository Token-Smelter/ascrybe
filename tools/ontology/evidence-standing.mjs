// Read-time evidence-standing gate. A sealed generation keeps the status and standing it was
// written with. Projections derive held vs proposed, and claim vs observed code, so a later rule
// does not rewrite that generation.

const COMMENT = 'comment';
const DOCUMENT = 'document';
const CODE = 'code';

export function evidenceRowClass(row, artifactKind = null) {
  if (!row) return 'unknown';
  if (row.standing === 'comment_claim' || row.span_class === 'comment') return COMMENT;
  if (row.standing === 'documentary_claim' || row.standing === 'third_party_reference'
    || artifactKind === 'document_claim' || artifactKind === 'third_party_reference') return DOCUMENT;
  if (row.standing === 'source_observed' || artifactKind === 'code' || artifactKind === 'structured_source') return CODE;
  return 'unknown';
}

// A copy only when the stored standing would present a comment or a document as observed code.
export function projectedOccurrence(row, artifactKind = null) {
  if (!row) return row;
  const kind = evidenceRowClass(row, artifactKind);
  const standing = kind === COMMENT ? 'comment_claim'
    : kind === DOCUMENT ? (row.standing === 'third_party_reference' || artifactKind === 'third_party_reference' ? 'third_party_reference' : 'documentary_claim')
    : kind === CODE ? 'source_observed'
    : row.standing;
  return standing === row.standing ? row : { ...row, standing };
}

export function conceptEvidenceGate({ standing = null, evidence = [], storedStatus = 'proposed', artifactKindOf = () => null } = {}) {
  const summary = standing?.summary ?? 'no_located_evidence';
  const support = (evidence ?? []).filter(row => row && (row.role == null || row.role === 'support'));
  const classes = support.map(row => evidenceRowClass(row, artifactKindOf(row.artifact_id)));
  const only = kind => support.length > 0 && classes.every(item => item === kind);
  const has = kind => classes.includes(kind);
  // Rows override a stored source_observed summary: a comment in a code file, or a document
  // whose row was labelled as source, is not observed code. A stored summary still decides when
  // the generation did not keep per-row standings.
  const commentOnly = only(COMMENT) || (summary === 'comment_claim' && !has(CODE) && !has(DOCUMENT));
  const documentOnly = only(DOCUMENT) || ((summary === 'documentary_claim' || summary === 'third_party_reference') && !has(CODE) && !has(COMMENT));
  const observedCode = !commentOnly && !documentOnly && (summary === 'source_observed' || only(CODE));
  const evidence_class = commentOnly || documentOnly ? 'claim' : observedCode ? 'observed code' : null;
  const status = summary === 'no_located_evidence' || storedStatus === 'held' ? 'held' : 'proposed';
  return Object.freeze({ status, evidence_class });
}

// Explorer tuples use a standing index. A claim must not keep the source-observed index.
export function standingIndexForGate(summaryIndex, gate, classes = []) {
  if (gate.status === 'held') return 4;
  if (gate.evidence_class !== 'claim' || summaryIndex === 2 || summaryIndex === 3) return summaryIndex;
  if (classes.length && classes.every(item => item === COMMENT)) return 3;
  if (gate.evidence_class === 'claim') return 2;
  return summaryIndex;
}
