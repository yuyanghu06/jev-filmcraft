import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, runJev } from '../src/chat/jev.js';
import { tools, describeTool } from '../src/tools/catalog.js';
import { textResult, failure } from '../src/core.js';
import type { Params } from '../src/core.js';
import type { AgentContext } from '../src/chat/providers.js';

const project = { project: { activeSequence: 10, root: { children: [{ item: 1, type: 'Movie', name: 'City' }, { item: 10, type: 'Sequence', name: 'Main' }] } }, sequence: { video: [{ id: 30, items: [{ clip: 12, item: 1, name: 'City', durationFrames: 171 }] }], audio: [] } };
function context(prompt: string, action: string, select: (key: string, q: any) => string, onCall?: AgentContext['call']) {
  const calls: { name: string; args: Params }[] = [];
  const questions: Record<string, any>[] = [];
  let actions = 0;
  const ctx: AgentContext = {
    config: { apiKey: 'fixture', model: 'jev-test' }, turns: [{ role: 'user', text: prompt }], signal: new AbortController().signal,
    tools: tools.filter(t => ['filmcraft_inspect', 'filmcraft_jobs_list', action].includes(t.name)).map(describeTool), say: () => {},
    call: async (name, args) => { calls.push({ name, args }); return onCall ? onCall(name, args) : textResult(project); },
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body)); questions.push(body.questions);
      return Response.json({ answers: Object.fromEntries(Object.entries<any>(body.questions).map(([key, q]) => {
        const choice = key === 'progress' ? 'done' : key === 'action' ? (actions++ === 0 ? action : 'done') : Object.keys(q.criteria).find(k => q.criteria[k]?.default) ?? select(key, q);
        assert(Object.hasOwn(q.criteria, choice), `${key}: ${choice}`);
        return [key, { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
      })) });
    },
  };
  return { ctx, calls, questions };
}

test('clip IDs cannot be drawn from frame counts, track IDs or other entity IDs', () => {
  const integer = { type: 'integer', exclusiveMinimum: 0 };
  assert.deepEqual(candidates(integer, 'clip', 'Shorten clip 12 by 30 frames, deltaFrames -30.', [project]), [12]);
  assert.deepEqual(candidates(integer, 'clip', 'Shorten clip 9999 by 12 frames.', [project]), []);
  assert.deepEqual(candidates(integer, 'item', 'inspect current sequence', [project], 'filmcraft_sequence_inspect'), [10]);
  assert.deepEqual(candidates(integer, 'clip', '```json\n{"clip":30}\n```', [project]), [12]);
  assert.deepEqual(candidates({ type: 'array', items: integer }, 'clips', '```json\n{"clips":[12,30]}\n```', [project]), [[12]]);
  const title = 'A title lasting 3 seconds, at tick 0 on zero-based video track index 1.';
  assert.deepEqual(candidates({ type: 'integer' }, 'track', title, [project], 'filmcraft_title_create'), [1]);
  assert.deepEqual(candidates({ type: 'number' }, 'seconds', title, [project], 'filmcraft_title_create'), [3]);
  assert.deepEqual(candidates({ type: 'integer' }, 'time', title, [project], 'filmcraft_title_create'), [0]);
  assert.deepEqual(candidates({ type: 'integer' }, 'deltaFrames', 'Take 12 frames off clip 15.', [project]), [12, -12]);
  assert.deepEqual(candidates({ type: 'integer' }, 'deltaFrames', 'Trim clip 15 by -12 frames.', [project]), [-12]);
  assert.deepEqual(candidates({ type: 'integer' }, 'deltaFrames', 'Trim 30 frames with deltaFrames -30.', [project]), [-30]);
  assert.deepEqual(candidates({ type: 'number' }, 'db', 'Lower audio clip 13 by another 2 dB.', [project], 'filmcraft_audio_gain'), [2, -2]);
  assert.deepEqual(candidates({ type: 'number' }, 'db', 'Set audio clip 13 to +2 dB.', [project], 'filmcraft_audio_gain'), [2]);
  assert.deepEqual(candidates({ type: 'number' }, 'db', 'Set audio clip 13 to -2 dB.', [project], 'filmcraft_audio_gain'), [-2]);
});

test('exact JSON settings leave unrelated optional parameters at their defaults', async () => {
  const fixture = context('Use these exact arguments: ```json\n{"seconds":2,"name":"Point"}\n```', 'filmcraft_marker_add', () => { throw new Error('Exact arguments must not generate parameter questions'); });
  await runJev(fixture.ctx);
  assert.equal(fixture.questions.length, 2);
  assert.deepEqual(fixture.calls.find(c => c.name === 'filmcraft_marker_add')?.args, { seconds: 2, name: 'Point' });
});

test('ordinary edits exclude an unconstructible batch; explicit batch steps remain supported', async () => {
  const fixture = context('Add a marker at 2 seconds called "Point".', 'filmcraft_marker_add', (key, q) => {
    if (key.startsWith('present.')) return ['present.seconds', 'present.name'].includes(key) ? 'include' : 'omit';
    return Object.keys(q.criteria).find(k => q.criteria[k]?.value === (key === 'seconds' ? 2 : 'Point'))!;
  });
  fixture.ctx.tools.push(describeTool(tools.find(t => t.name === 'filmcraft_batch')!));
  await runJev(fixture.ctx);
  assert(fixture.questions.filter(q => q.action).every(q => !Object.hasOwn(q.action.criteria, 'filmcraft_batch')));
  assert.deepEqual(fixture.calls.find(c => c.name === 'filmcraft_marker_add')?.args, { seconds: 2, name: 'Point', target: 'program' });

  const steps = [{ id: 'markers.add', params: { seconds: 2, name: 'Point' } }];
  const batch = context('Run these exact arguments: ```json\n' + JSON.stringify({ steps }) + '\n```', 'filmcraft_batch', () => { throw new Error('Explicit batch needs no parameter decisions'); });
  await runJev(batch.ctx);
  assert.deepEqual(batch.calls.find(c => c.name === 'filmcraft_batch')?.args, { steps });
});

test('explicit JSON binds values without another model choice and rejects nonexistent targets', async () => {
  const prompt = 'Trim this clip: ```json\n{"clip":12,"edge":"out","deltaFrames":-30}\n```';
  const fixture = context(prompt, 'filmcraft_clip_trim', key => { assert.equal(key, 'present.mode'); return 'omit'; });
  await runJev(fixture.ctx);
  assert.deepEqual(fixture.calls.find(c => c.name === 'filmcraft_clip_trim')?.args, { clip: 12, edge: 'out', deltaFrames: -30, mode: 'regular' });
  assert.equal(fixture.calls.filter(c => c.name === 'filmcraft_inspect').length, 2, 'Refresh state after the edit');
  const invalid = context(prompt.replace('"clip":12', '"clip":30'), 'filmcraft_clip_trim', () => 'omit');
  await assert.rejects(runJev(invalid.ctx), /known project target/);
  assert(!invalid.calls.some(c => c.name === 'filmcraft_clip_trim'));
});

test('omitted optional values are not queried and earlier turns do not pollute candidates', async () => {
  const fixture = context('Add a marker at 2 seconds called "New".', 'filmcraft_marker_add', (key, q) => {
    if (key.startsWith('present.')) return ['present.seconds', 'present.name'].includes(key) ? 'include' : 'omit';
    assert(['seconds', 'name'].includes(key), 'Irrelevant optional values must not be queried');
    assert(!Object.values<any>(q.criteria).some(v => v.value === 99 || v.value === 'Old'));
    return Object.keys(q.criteria).find(k => q.criteria[k]?.value === (key === 'seconds' ? 2 : 'New'))!;
  });
  fixture.ctx.turns.unshift({ role: 'user', text: 'Add "Old" at 99 seconds.' }, { role: 'assistant', text: 'Finished.' });
  await runJev(fixture.ctx);
  assert.deepEqual(fixture.calls.find(c => c.name === 'filmcraft_marker_add')?.args, { seconds: 2, name: 'New', target: 'program' });
});

test('rejected engine actions throw instead of returning successful completion', async () => {
  const fixture = context('Undo once.', 'filmcraft_undo', () => { throw new Error('No parameters expected'); }, async name => name === 'filmcraft_undo' ? failure('Nothing to undo') : textResult(project));
  await assert.rejects(runJev(fixture.ctx), /FilmCraft rejected filmcraft_undo/);
  assert.equal(fixture.questions.length, 1);
});

test('literal clip IDs are inspected before binding and output effect objects are not input candidates', async () => {
  const fixture = context('Apply the default video transition to clip 12.', 'filmcraft_transition_video', key => {
    assert(key.startsWith('present.'), 'An inspected literal ID needs no model decision');
    return 'omit';
  });
  await runJev(fixture.ctx);
  assert.equal(fixture.calls.find(c => c.name === 'filmcraft_transition_video')?.args.clip, 12);
  const inspected = [{ params: { opacity: { value: 'Float(100.0)' } }, effect: 'motion' }];
  assert.deepEqual(candidates({ type: 'object', default: {} }, 'params', 'Default transition', inspected), [{}]);
  assert.deepEqual(candidates({ type: 'string', default: 'cross_dissolve' }, 'effect', 'Default transition', inspected, 'filmcraft_transition_video'), ['cross_dissolve']);
});

test('completion checks continue unfinished requests and inspect each edit before finishing', async () => {
  const state = structuredClone(project) as any;
  state.sequence.markers = [];
  state.sequence.audio = [{ items: [{ clip: 16, name: 'Bus audio', gainDb: 0 }] }];
  const fixture = context('Add "Bus Pass" at 7 seconds, then set audio clip 16 to -3 dB.', 'filmcraft_marker_add', () => '', async (name, args) => {
    if (name === 'filmcraft_marker_add') state.sequence.markers.push({ name: args.name, seconds: args.seconds });
    if (name === 'filmcraft_audio_gain') state.sequence.audio[0].items[0].gainDb = args.db;
    return textResult(name === 'filmcraft_inspect' ? state : { ok: true });
  });
  fixture.ctx.tools.push(describeTool(tools.find(t => t.name === 'filmcraft_audio_gain')!));
  const progress: string[] = [];
  fixture.ctx.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    const answers = Object.fromEntries(Object.entries<any>(body.questions).map(([key, q]) => {
      let choice: string;
      if (key === 'action') choice = state.sequence.markers.length ? 'filmcraft_audio_gain' : 'filmcraft_marker_add';
      else if (key === 'progress') {
        assert(!Object.hasOwn(q.criteria, 'filmcraft_inspect'), 'Completion should not compete with another inspection');
        choice = state.sequence.audio[0].items[0].gainDb === -3 ? 'done' : 'remaining';
        progress.push(choice);
        assert(body.state.completed.at(-1).stateChanges, 'Fresh inspection must precede completion');
        assert.equal(body.state.completed.at(-1).inspection?.completed, true, 'Completion explicitly identifies the fresh inspection');
      } else if (key.startsWith('present.')) choice = ['present.seconds', 'present.name'].includes(key) ? 'include' : 'omit';
      else {
        const wanted: Record<string, unknown> = { seconds: 7, name: 'Bus Pass', target: 'program', clips: [16], mode: 'set', db: -3 };
        choice = Object.keys(q.criteria).find(k => JSON.stringify(q.criteria[k]?.value) === JSON.stringify(wanted[key]))!;
        assert.equal(body.assets, undefined, 'Arguments do not need image payloads');
      }
      assert(Object.hasOwn(q.criteria, choice), key);
      return [key, { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
    }));
    return Response.json({ answers });
  };
  await runJev(fixture.ctx);
  assert.deepEqual(progress, ['remaining', 'done']);
  assert.deepEqual(fixture.calls.map(c => c.name), ['filmcraft_inspect', 'filmcraft_marker_add', 'filmcraft_inspect', 'filmcraft_audio_gain', 'filmcraft_inspect']);
  assert.equal(state.sequence.markers[0].name, 'Bus Pass');
  assert.equal(state.sequence.audio[0].items[0].gainDb, -3);
});

test('uncertain completion stops without repeating a successful edit', async () => {
  const fixture = context('Undo once.', 'filmcraft_undo', () => '');
  const fetch = fixture.ctx.fetch;
  fixture.ctx.fetch = async (...args) => {
    const response = await fetch(...args);
    const body = await response.json();
    if (body.answers.progress) body.answers.progress = { type: 'choice', choice: 'done', confidence: 0.2, probabilities: { done: 0.6, remaining: 0.4 } };
    return Response.json(body);
  };
  await assert.rejects(runJev(fixture.ctx), /completed edits remain/);
  assert.equal(fixture.calls.filter(c => c.name === 'filmcraft_undo').length, 1);
});

test('targeted deletion replaces ambient selection before issuing native delete', async () => {
  const fixture = context('Delete timeline clip 12, leaving a gap.', 'filmcraft_selection_delete', (key, q) => {
    assert.equal(key, 'clips');
    return Object.keys(q.criteria).find(k => JSON.stringify(q.criteria[k]?.value) === '[12]')!;
  });
  await runJev(fixture.ctx);
  assert.deepEqual(fixture.calls.filter(c => ['filmcraft_clip_select', 'filmcraft_selection_delete'].includes(c.name)), [
    { name: 'filmcraft_clip_select', args: { clips: [12], linked: true } },
    { name: 'filmcraft_selection_delete', args: {} },
  ]);
});

test('export completion follows the returned job ID and polls without model decisions', async () => {
  let polls = 0;
  const fixture = context('Export: ```json\n{"path":"/tmp/test-export.mp4"}\n```', 'filmcraft_export_start', () => 'omit', async name => {
    if (name === 'filmcraft_export_start') return textResult({ job: 7, path: '/tmp/test-export.mp4' });
    if (name === 'filmcraft_jobs_list') return textResult([{ id: 99, finished: true, result: { error: 'unrelated older job' } }, { id: 7, finished: ++polls > 1, result: polls > 1 ? { path: '/tmp/test-export.mp4', frames: 150 } : null, offlineMedia: [] }]);
    return textResult(project);
  });
  const fetch = fixture.ctx.fetch;
  fixture.ctx.fetch = async (...args) => {
    const body = JSON.parse(String(args[1]?.body));
    if (body.questions.progress) {
      const evidence = body.state.completed.find((entry: any) => entry.exportJob === 7);
      assert.equal(evidence.job.finished, true);
      assert.deepEqual(evidence.job.offlineMedia, []);
    }
    return fetch(...args);
  };
  await runJev(fixture.ctx);
  assert.equal(polls, 2);
  assert.equal(fixture.calls.filter(c => c.name === 'filmcraft_export_start').length, 1);
  assert.equal(fixture.questions.length, 3, 'Action, optional settings, and final decision only');
});
