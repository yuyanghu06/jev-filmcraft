import test from 'node:test';
import assert from 'node:assert/strict';
import { FilmcraftService } from '../src/api/service.js';
import { PluginError, resultData, textResult } from '../src/core.js';
import type { Backend, Params } from '../src/core.js';
import { planSchema } from '../src/chat/plan.js';

const key = 'jev-plan-private-key';
const target = { clip: 1, track: 'V1', startFrame: 0, durationFrames: 240 };
const plan = (steps: any[]) => ({ version: 1, objective: 'Cut the selected shot precisely', sequence: 10, steps });
const split = { id: 'cut', operation: 'split', target, atFrame: 96, outcome: 'An edit at frame 96 preserves all source frames' };
function decision(body: any, selected = 'execute') {
  const criteria = body.questions.action.criteria;
  return Response.json({ answers: { action: { type: 'choice', choice: selected, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === selected ? 1 : 0])) } } });
}
function fixture(options: { fetch?: typeof fetch; failAfterSplit?: boolean; noOp?: boolean; noRipple?: boolean } = {}) {
  let next = 100;
  let clips: any[] = [{ ...target, item: 7, start: 0 }];
  let selection: number[] = [];
  const calls: { tool: string; args: Params }[] = [];
  const requests: any[] = [];
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool, args) => {
    calls.push({ tool, args: structuredClone(args) });
    if (tool === 'doc_inspect') return textResult({ project: { activeSequence: 10 }, sequence: { id: 10, settings: { frame_rate: { num: 24, den: 1 } }, video: [{ id: 20, items: clips.filter(c => c.track === 'V1') }, { id: 21, items: clips.filter(c => c.track === 'V2') }], audio: [] } });
    const p = args.params as any;
    if (args.id === 'timeline.razor' && !options.noOp) {
      const clip = clips.find(c => c.clip === p.clip);
      assert(clip, 'Primitive must target an existing ID');
      const end = clip.startFrame + clip.durationFrames;
      clip.durationFrames = p.frame - clip.startFrame;
      clips.push({ ...clip, clip: next++, startFrame: p.frame, start: p.frame * 254016000000 / 24, durationFrames: end - p.frame });
      if (options.failAfterSplit) throw new Error('connection lost after native edit');
    }
    if (args.id === 'timeline.trim') {
      const clip = clips.find(c => c.clip === p.clip);
      clip.durationFrames += p.edge === 'in' ? -p.deltaFrames : p.deltaFrames;
      if (p.edge === 'in') clip.startFrame += p.deltaFrames;
    }
    if (args.id === 'timeline.move') for (const move of p.moves) {
      const clip = clips.find(c => c.clip === move.clip);
      clip.track = move.track; clip.start = move.time; clip.startFrame = Math.round(move.time * 24 / 254016000000);
    }
    if (args.id === 'timeline.select') selection = p.clips;
    if (['edit.clear', 'edit.rippleDelete'].includes(String(args.id))) {
      const removed = clips.filter(c => selection.includes(c.clip));
      clips = clips.filter(c => !selection.includes(c.clip));
      if (args.id === 'edit.rippleDelete' && !options.noRipple) for (const clip of clips) for (const gone of removed) if (clip.startFrame >= gone.startFrame + gone.durationFrames) clip.startFrame -= gone.durationFrames;
    }
    return textResult({ ok: true });
  } };
  const providerFetch: typeof fetch = options.fetch ?? (async (url, opts) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(opts?.body)); requests.push(body);
    assert.equal(body.assets, undefined);
    assert.equal(body.state.image, undefined);
    assert(!JSON.stringify(body).includes('data_base64'));
    return decision(body);
  });
  const service = new FilmcraftService(backend, { env: { TYPESAFE_API_KEY: key }, fetch: providerFetch });
  return { service, calls, requests, clips: () => clips };
}

test('versioned plans reject malformed steps, duplicate IDs, forward references and stale targets before mutation', async () => {
  for (const invalid of [{ ...plan([split]), version: 2 }, plan([{ ...split, atFrame: -1 }]), plan([split, split]), plan([{ ...split, target: { stepId: 'later', segment: 'left' } }])]) {
    assert.equal(planSchema.safeParse(invalid).success, false);
    const { service, calls } = fixture();
    await assert.rejects(service.invoke('filmcraft_execute_plan', { plan: invalid }), (e: any) => e.code === 'INVALID_ARGUMENTS');
    assert.equal(calls.length, 0);
  }
  const { service, calls, requests } = fixture();
  const result = await service.invoke('filmcraft_execute_plan', { plan: plan([{ ...split, target: { ...target, durationFrames: 200 } }]) });
  assert.equal(result.isError, true);
  assert.match((resultData(result) as any).error, /Stale plan target/);
  assert.equal(requests.length, 0);
  assert(calls.every(c => c.tool === 'doc_inspect'));
});

test('Jev executes split then references refreshed right ID for trim and move; every primitive is verified', async () => {
  const { service, requests, clips } = fixture();
  const result = resultData(await service.invoke('filmcraft_execute_plan', { plan: plan([split,
    { id: 'shorten', operation: 'trim', target: { stepId: 'cut', segment: 'right' }, edge: 'out', deltaFrames: -24, outcome: 'Shorten the right section by 24 frames' },
    { id: 'reposition', operation: 'move', target: { stepId: 'shorten', segment: 'only' }, toTrack: 'V2', toFrame: 120, outcome: 'Move the shortened section to V2 frame 120' },
  ]) })) as any;
  assert.equal(result.status, 'verified');
  assert.equal(requests.length, 3);
  assert(result.steps.every((s: any) => s.status === 'verified' && s.operations.every((o: any) => o.verification.passed)));
  assert.deepEqual(clips().map(c => [c.clip, c.track, c.startFrame, c.durationFrames]), [[1, 'V1', 0, 96], [100, 'V2', 120, 120]]);
  assert.equal(result.steps[0].refreshedClipIds[1].clip, 100);
  assert.equal(result.steps[1].operations[0].args.clip, 100);
  assert.equal(result.refreshedClipIds.length, 2);
});

for (const ripple of [false, true]) test(`bounded remove-range resolves fresh split IDs and verifies exact deletion (ripple:${ripple})`, async () => {
  const { service, clips, requests } = fixture();
  const result = resultData(await service.invoke('filmcraft_execute_plan', { plan: plan([{ id: 'remove', operation: 'remove-range', target, startFrame: 48, endFrame: 96, ripple, outcome: 'Remove only frames 48 through 95' }]) })) as any;
  assert.equal(result.status, 'verified');
  assert.equal(requests.length, 3);
  assert.deepEqual(clips().map(c => [c.startFrame, c.durationFrames]).sort((a, b) => a[0] - b[0]), [[0, 48], [ripple ? 48 : 96, 144]]);
  assert.equal(result.steps[0].operations.length, 3);
  assert(result.steps[0].operations.at(-1).verification.passed);
});

test('partial failure preserves the split, reports skipped steps and refreshed IDs, and rejects plan replay', async () => {
  const { service, calls } = fixture({ failAfterSplit: true });
  const input = { plan: plan([split, { id: 'later', operation: 'trim', target: { stepId: 'cut', segment: 'right' }, edge: 'out', deltaFrames: -1, outcome: 'Shorten one frame' }]) };
  const result = resultData(await service.invoke('filmcraft_execute_plan', input)) as any;
  assert.equal(result.status, 'partial-failure');
  assert.equal(result.steps[0].operations[0].status, 'attempted');
  assert.equal(result.steps[1].status, 'not-started');
  assert.deepEqual(result.refreshedClipIds.map((c: any) => c.clip), [1, 100]);
  assert.equal(calls.filter(c => c.args.id === 'timeline.razor').length, 1);
  await assert.rejects(service.invoke('filmcraft_execute_plan', input), (e: any) => e.code === 'PLAN_REPLAY');
  assert.equal(calls.filter(c => c.args.id === 'timeline.razor').length, 1);
});

test('native no-op success fails independent state verification and stops remaining actions', async () => {
  const { service, calls } = fixture({ noOp: true });
  const result = resultData(await service.invoke('filmcraft_execute_plan', { plan: plan([split]) })) as any;
  assert.equal(result.status, 'partial-failure');
  assert.match(result.error, /Verification failed/);
  assert.equal(result.steps[0].operations[0].verification.passed, false);
  assert.equal(calls.filter(c => c.tool === 'command_run').length, 1);
});

test('Jev plan and chat share busy ownership; cancellation aborts inference before mutation and releases ownership', async () => {
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { entered = resolve; });
  const { service, calls } = fixture({ fetch: async (_url, options) => {
    entered();
    await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    throw new Error('unreachable');
  } });
  const abort = new AbortController();
  const running = service.invoke('filmcraft_execute_plan', { plan: plan([split]) }, { signal: abort.signal });
  await gate;
  assert.throws(() => service.beginChat(), (e: any) => e.code === 'BUSY');
  await assert.rejects(service.invoke('filmcraft_clip_trim', { clip: 1, edge: 'out', deltaFrames: -1 }), (e: any) => e.code === 'BUSY');
  abort.abort();
  assert.equal((resultData(await running) as any).status, 'stopped');
  assert(calls.every(c => c.tool === 'doc_inspect'));
  const owner = service.beginChat();
  await assert.rejects(service.invoke('filmcraft_inspect', {}), (e: any) => e.code === 'BUSY');
  service.endChat(owner);
  assert.equal(service.busy, false);
});

test('missing Jev credentials fail with actionable setup before any backend or inference call', async () => {
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async () => { throw new Error('must not call'); } };
  await assert.rejects(new FilmcraftService(backend, { env: {} }).invoke('filmcraft_execute_plan', { plan: plan([split]) }), (e: any) => e instanceof PluginError && e.code === 'MISSING_JEV_KEY');
});


test('remove-range verification rejects a backend that deletes but fails to close the planned gap', async () => {
  const { service } = fixture({ noRipple: true });
  const result = resultData(await service.invoke('filmcraft_execute_plan', { plan: plan([{ id: 'remove', operation: 'remove-range', target, startFrame: 48, endFrame: 96, ripple: true, outcome: 'Remove and close exactly 48 frames' }]) })) as any;
  assert.equal(result.status, 'partial-failure');
  assert.match(result.error, /planned start frame/);
  assert.equal(result.steps[0].operations.at(-1).verification.passed, false);
});
