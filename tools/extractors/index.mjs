import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textExtensions } from '../lib.mjs';

// Each entry is [extractor, specifier, allowedMissing]. `allowedMissing` is
// the exhaustive set of specifiers this extractor is PERMITTED to lack: only
// an ERR_MODULE_NOT_FOUND whose unresolved specifier is a member converts to
// an exclusion receipt; every other load failure is loud. The cascade sets
// name every specifier that can surface first on a partially-installed host:
// treesitter-{swift,kotlin,csharp,python} import ../treesitter/loader.mjs AND
// ./treesitter-js.mjs, which itself needs json5 and ../treesitter/loader.mjs.
const TREESITTER_CASCADE = Object.freeze(['../treesitter/loader.mjs', './treesitter-js.mjs', 'json5']);
const definitions = [
  ['hcl', './hcl.mjs', []],
  ['http', './http.mjs', []],
  ['aws', './aws.mjs', []],
  ['dependencies', './dependencies.mjs', []],
  ['config', './config.mjs', []],
  ['sql', './sql.mjs', []],
  ['sqlite-ddl', './sqlite-ddl.mjs', []],
  ['sql-dml', './sql-dml.mjs', []],
  ['envelopes', './envelopes.mjs', []],
  ['capabilities', './capabilities.mjs', []],
  ['yaml-catalog', './yaml-catalog.mjs', ['yaml']],
  ['catalog-records', './catalog-records.mjs', ['yaml']],
  ['declaration-comments', './declaration-comments.mjs', []],
  ['diagrams', './diagrams.mjs', []],
  ['document-structure', './document-structure.mjs', []],
  ['manifest-completeness', './manifest-completeness.mjs', ['yaml']],
  ['treesitter-js', './treesitter-js.mjs', ['json5', '../treesitter/loader.mjs']],
  ['treesitter-swift', './treesitter-swift.mjs', TREESITTER_CASCADE],
  ['treesitter-kotlin', './treesitter-kotlin.mjs', TREESITTER_CASCADE],
  ['treesitter-csharp', './treesitter-csharp.mjs', TREESITTER_CASCADE],
  ['treesitter-python', './treesitter-python.mjs', TREESITTER_CASCADE],
];

function unresolvedSpecifier(error) {
  const packageMatch = error.message.match(/Cannot find package '([^']+)'/);
  if (packageMatch) return packageMatch[1];
  const importerMatch = error.message.match(/ imported from (.+)$/);
  if (error.url && importerMatch) {
    const relative = path.relative(path.dirname(importerMatch[1]), fileURLToPath(error.url)).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  }
  return null;
}

const extractors = [];
export const extractorExclusionReceipts = [];
const available = [];
for (const [extractor, specifier, allowedMissing] of definitions) {
  try {
    const loaded = await import(specifier);
    extractors.push(loaded.default);
    available.push({ extractor, specifier, kind: loaded.default.kind });
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const unresolved_specifier = unresolvedSpecifier(error);
    if (!unresolved_specifier) throw error;
    if (!allowedMissing.includes(unresolved_specifier)) {
      throw new Error(
        `extractor '${extractor}' (${specifier}) failed to load: unresolved specifier '${unresolved_specifier}' is not declared optional for this extractor`,
        { cause: error },
      );
    }
    extractorExclusionReceipts.push(Object.freeze({
      schema: 'estate-map/extractor-exclusion/v1',
      kind: 'extractor_exclusion',
      disposition: 'excluded',
      extractor,
      extractor_specifier: specifier,
      unresolved_specifier,
      failure_code: error.code,
    }));
  }
}
Object.freeze(extractorExclusionReceipts);

export const extractorAvailabilityReceipt = Object.freeze({
  schema: 'estate-map/extractor-availability/v1',
  kind: 'extractor_availability',
  available: Object.freeze(available.map(Object.freeze)),
  exclusions: extractorExclusionReceipts,
});

// Keep language admission independent from optional parser availability. YAML
// remains input to envelopes/capabilities, while Swift/Kotlin/C# remain input
// to sqlite-ddl. This intentionally keeps those files in files_scanned even
// when their richer extractors are excluded.
const extensionDecisions = [
  ['.html', 'treesitter-js parses JavaScript licensed by complete inline script elements'],
  ['.htm', 'treesitter-js parses JavaScript licensed by complete inline script elements'],
  ['.swift', 'sqlite-ddl scans embedded DDL'],
  ['.kt', 'sqlite-ddl scans embedded DDL'],
  ['.kts', 'pre-existing Kotlin script scan scope remains stable while its optional extractor is excluded'],
  ['.cs', 'base text extension retained; sqlite-ddl scans embedded DDL'],
  ['.yaml', 'envelopes and capabilities scan plugin manifests'],
  ['.yml', 'envelopes and capabilities scan plugin manifests'],
  // Markdown was never admitted to the scan, so the diagram and document-structure extractors
  // matched files the walk never offered them: a corpus of 615 mermaid-bearing documents and
  // 31,626 headings produced exactly zero facts in the pipeline while producing them correctly
  // when called directly. Admitting the extension is what makes a documentary producer reachable.
  ['.md', 'diagrams and document-structure read documentary assertions and the author\'s outline'],
  ['.mdx', 'diagrams and document-structure read documentary assertions and the author\'s outline'],
];
for (const [extension] of extensionDecisions) textExtensions.add(extension);
export const textExtensionRegistrationReceipt = Object.freeze({
  schema: 'estate-map/text-extension-registration/v1',
  kind: 'text_extension_registration',
  disposition: 'retained_independent_of_extractor_availability',
  availability_effect: 'optional extractor loss does not shrink scan scope or the files_scanned denominator',
  extensions: Object.freeze(extensionDecisions.map(([extension, reason]) => Object.freeze({ extension, reason }))),
  scan_scope_effect: 'walk admits every matching file under the active directory exclusions',
  files_scanned_denominator_effect: 'every admitted readable matching file is included in each repository files_scanned count',
});

// `sqliteDdl` reads the DDL that this estate embeds in `.mjs` template literals,
// which `sql` (filePattern /\.sql$/) structurally cannot see. Its facts create NO
// graph nodes in merge.mjs by design — they are schema EVIDENCE consumed by
// entity-layer.mjs, so registering it cannot perturb the node population or any
// of the five diagnostic queues. Proven by the A/B in
// examples/entity-layer-report-2026-07-26.md §5.
// `capabilities` reads the OTHER inter-plugin coupling mechanism this estate
// uses (the capability registry), which the import graph and the envelope bus
// both miss. It needs no new text extension: it reads the same `.mjs`/`.ts`
// sources and the same `plugin.yaml` manifests `envelopes` already admits.
// Its facts DO mint graph nodes (one per capability type) and edges, so the
// A/B in examples/range-extension-report-2026-07-26.md attributes the
// resulting `undomained` growth exactly, as the route work did.
// COVERAGE-CLOSURE EXTRACTORS (orientation-test-report.md §7.2). Three of the
// seven features register their own extractor here; the other four ride the
// existing tree-sitter JS parse (F1/F1b literal values + throw sites, F3
// persistence targets, F6 tool registrations — see treesitter-js.mjs) or amend
// an existing producer (F7 witnesses derived route values in http.mjs).
//
// NONE of these fact kinds mints a graph node in merge.mjs, by the same design
// `sqliteDdl` already follows: they are EVIDENCE read by the query surface, not
// new subjects. That is what keeps the conservation gates
// (tools/estate-map/conservation.mjs, invoked from merge.mjs) passing —
// a subject minted without its witnessed incidence would fail the build, and
// the correct response to that would be to fix the extractor, never the gate.
//   sqlDml                F5: INSERT/UPDATE column lists + ALTER/CREATE INDEX.
//   yamlCatalog           F2: every YAML file's records — the potions,
//                         work-types and checks catalogs the map had zero
//                         records for.
//   manifestCompleteness  F4: plugin.yaml key presence (present_nonempty /
//                         present_empty / absent) + comment retention.
export default extractors;
