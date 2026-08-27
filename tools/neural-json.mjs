// Defensive JSON extraction for model answers in the documentation-claim census neural path.
// A model may wrap JSON in ``` fences or prose; take the first balanced {...} or [...] block.
// Mirrors the intent of campaign.mjs parseModelJson but is dependency-free so the extractor,
// resolver, and mock runner can parse without importing the spawn machinery.
// A single 6 KB JSON answer is lost entirely when the model drops one bracket (observed: one paid
// atomic answer with all six relations present but one unclosed `{`/`]`). A JSON-lines answer
// degrades per line instead: one malformed relation is quarantined, the rest of the purchased unit
// survives. Returns { mode, header, entries[] } where a failed line is retained verbatim.
export function parseModelJsonStream(text) {
  if (text == null) return null;
  const single = parseCensusModelJson(text);
  if (single && typeof single === 'object' && !Array.isArray(single)) return { mode: 'single', header: single, entries: [] };
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^```/.test(line));
  if (!lines.length) return null;
  const entries = lines.map((raw, index) => {
    try { return { index, ok: true, value: JSON.parse(raw), raw }; }
    catch (error) { return { index, ok: false, error: error.message, raw }; }
  });
  if (!entries.some(entry => entry.ok)) return null;
  const headerAt = entries.findIndex(entry => entry.ok && entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value) && 'outcome' in entry.value);
  return {
    mode: 'stream',
    header: headerAt === -1 ? null : entries[headerAt].value,
    entries: entries.filter((_, index) => index !== headerAt),
  };
}

export function parseCensusModelJson(text) {
  if (text == null) return null;
  let source = String(text).trim();
  if (!source) return null;
  source = source.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const firstObj = source.indexOf('{');
  const firstArr = source.indexOf('[');
  let open;
  if (firstObj === -1) open = firstArr;
  else if (firstArr === -1) open = firstObj;
  else open = Math.min(firstObj, firstArr);
  if (open === -1) return null;
  const closer = source[open] === '{' ? '}' : ']';
  const last = source.lastIndexOf(closer);
  if (last <= open) return null;
  const candidate = source.slice(open, last + 1);
  try { return JSON.parse(candidate); }
  catch { return null; }
}
