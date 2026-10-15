// Preserve source witnesses; do not infer authority from naming conventions alone.
import { fail } from './schemas.mjs';

const SCOPE_PATTERN = /^[a-z][a-z0-9-]*$/;
const CODE_PATTERN = /^[A-Z]{2,6}-\d{4}$/;
const CONCEPT_ID_PATTERN = /^ontology-concept:([a-z][a-z0-9-]*):([A-Z]{2,6}-\d{4})$/;

/** `ontology-concept:<scope>:<CODE>`, e.g. `ontology-concept:ascrybe:AR-0001`. */
export function conceptId(scope, code) {
  if (!SCOPE_PATTERN.test(String(scope ?? ''))) {
    fail('ONTOLOGY_CONCEPT_SCOPE_INVALID', `concept scope ${JSON.stringify(scope)} is not a valid lowercase identifier`);
  }
  if (!CODE_PATTERN.test(String(code ?? ''))) {
    fail('ONTOLOGY_CONCEPT_CODE_INVALID', `concept accession code ${JSON.stringify(code)} does not match <PREFIX>-<NNNN>`);
  }
  return `ontology-concept:${scope}:${code}`;
}

/** The inverse of conceptId; throws on anything that is not exactly that shape. */
export function parseConceptId(id) {
  const match = CONCEPT_ID_PATTERN.exec(String(id ?? ''));
  if (!match) fail('ONTOLOGY_CONCEPT_ID_INVALID', `${JSON.stringify(id)} is not a valid concept accession id`);
  return Object.freeze({ scope: match[1], code: match[2] });
}
