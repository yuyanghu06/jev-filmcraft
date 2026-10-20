import test from 'node:test';
import assert from 'node:assert/strict';
import { jevTools, nativeMoveArguments } from '../src/chat/jev-tools.js';
import { tools, describeTool } from '../src/tools/catalog.js';
import { candidates } from '../src/chat/jev.js';

const project = { sequence: { video: [{ id: 4, items: [{ clip: 12, start: 254016000000 }] }, { id: 5, items: [] }], audio: [] } };
test('single moves preserve native shape, defaults, and linked options without generated JSON', () => {
  assert.deepEqual(nativeMoveArguments({ clip: 12, seconds: 2, track: 'V2', linked: true }, project), { moves: [{ clip: 12, track: 'V2', time: 508032000000 }], linked: true });
  assert.deepEqual(nativeMoveArguments({ clip: 12, track: 'V2' }, project), { moves: [{ clip: 12, track: 'V2', time: 254016000000 }] });
  assert.deepEqual(nativeMoveArguments({ clip: 12, seconds: 0 }, project), { moves: [{ clip: 12, track: 4, time: 0 }] });
  assert.throws(() => nativeMoveArguments({ clip: 99, seconds: 2 }, project), /no longer present/);
  assert.throws(() => nativeMoveArguments({ clip: 12, seconds: 2, time: 1 }, project), /not both/);
  assert.throws(() => nativeMoveArguments({ clip: 12, seconds: 1e20 }, project), /safe tick/);
});

test('Jev scalar move schema leaves the native MCP schema and explicit batch moves intact', () => {
  const original = tools.filter(t => t.name === 'filmcraft_clip_move').map(describeTool);
  const simplified = jevTools(original, {});
  assert(simplified[0]!.inputSchema.properties?.clip);
  assert(!simplified[0]!.inputSchema.properties?.moves);
  assert(original[0]!.inputSchema.properties?.moves);
  assert.equal(jevTools(original, { moves: [] })[0], original[0]);
});

test('track candidates include real labels and IDs without confusing them with clip IDs', () => {
  assert.deepEqual(candidates({ type: 'string' }, 'track', 'Place item 1 on V2.', [project], 'filmcraft_clip_place'), ['V2']);
  assert.deepEqual(candidates({ type: 'integer' }, 'track', 'Move clip 12 to V2.', [project], 'filmcraft_clip_move'), []);
  assert.deepEqual(candidates({ type: 'integer' }, 'track', 'Create a title on V2.', [project], 'filmcraft_title_create'), [1]);
});
