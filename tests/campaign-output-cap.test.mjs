import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../tools/campaign.mjs', import.meta.url), 'utf8');

test('what the accumulator retains is clamped to what a string can hold', () => {
  assert.match(source, /const retained = Math\.min\(maxOutputBytes, bufferConstants\.MAX_STRING_LENGTH - \d+\)/u,
    'retention must be clamped below the runtime string ceiling');
  // The append must use the clamped value, not the configured cap.
  assert.match(source, /const remaining = Math\.max\(0, retained - outBytes\)/u);
  // Byte accounting keeps using the configured cap, so the recorded outcome is unchanged.
  assert.match(source, /if \(outBytes > maxOutputBytes\)/u);
});

test('the configured cap this estate ships exceeds the string ceiling it would be held in', () => {
  const runtime = JSON.parse(readFileSync(new URL('../ascrybe.config.example.json', import.meta.url), 'utf8'));
  const caps = Object.values(runtime.models ?? {}).map(model => model.max_event_bytes).filter(Number.isFinite);
  assert.ok(caps.length > 0, 'the example runtime config must declare event caps');
  // Not a demand that the cap be lowered -- only that exceeding the ceiling is survivable, which
  // is what the clamp guarantees. This records why the clamp cannot be removed.
  assert.equal(caps.some(cap => cap > constants.MAX_STRING_LENGTH), true,
    'a shipped cap exceeds MAX_STRING_LENGTH, which is exactly what the clamp exists to survive');
});
