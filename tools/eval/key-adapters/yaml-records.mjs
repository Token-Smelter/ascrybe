import { LineCounter, parseDocument } from 'yaml';
export const version = 'yaml-records/v1';

function field(node, key) { return node?.items?.find(item => String(item.key?.value) === key)?.value; }
function scalar(node) { return node?.value; }
function atPath(node, path) { return path.reduce((current, key) => field(current, key), node); }
function lineOf(counter, range) { return counter.linePos(range?.[0] ?? 0).line; }

export async function derive({ repository, specification }) {
  const paths = (await repository.listFiles(specification.directory ?? '')).filter(path => path.endsWith('.yaml') || path.endsWith('.yml')).sort();
  const answer_units = []; const witnesses = [];
  for (const path of paths) {
    const source = await repository.readFile(path); const counter = new LineCounter();
    const document = parseDocument(source, { lineCounter: counter });
    if (document.errors.length) throw new Error(`YAML parse refusal: ${path}`);
    const collection = atPath(document.contents, specification.collection_path ?? []);
    for (const item of collection?.items ?? []) {
      const predicate = specification.where ?? {};
      if (!Object.entries(predicate).every(([key, value]) => scalar(field(item, key)) === value)) continue;
      const selected = field(item, specification.project);
      if (typeof scalar(selected) !== 'string') throw new Error(`YAML projection refusal: ${path}`);
      answer_units.push(scalar(selected));
      const line = lineOf(counter, selected.range); witnesses.push({ path, line_start: line, line_end: line, quote: scalar(selected) });
    }
  }
  return { answer_units: [...new Set(answer_units)].sort(), witnesses };
}
