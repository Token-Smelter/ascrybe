export const version = 'tree-paths/v1';
export async function derive({ repository, specification }) {
  const extensions = new Set(specification.extensions ?? []);
  const paths = await repository.listFiles(specification.directory ?? '');
  const accepted = paths.filter(path => !extensions.size || [...extensions].some(extension => path.endsWith(extension))).sort();
  return { answer_units: accepted, witnesses: accepted.map(path => ({ path, line_start: 1, line_end: 1 })) };
}
