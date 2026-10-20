import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startApi } from '../src/api/server.js';
import { FilmcraftService } from '../src/api/service.js';
import { textResult } from '../src/core.js';
import type { Backend, Params } from '../src/core.js';
import { candidates, readChoice } from '../src/chat/jev.js';

const token = 'chat-tests-private-local-token-0123456789';
const key = 'provider-secret-never-return-to-ui';
function choice(criteria: Record<string, unknown>, selected: string) {
  return { type: 'choice', choice: selected, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === selected ? 1 : 0])) };
}
async function setup(t: any, mock: typeof fetch, brokenLogDirectory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'filmcraft-chat-test-'));
  if (brokenLogDirectory) await writeFile(join(directory, 'debug'), 'not a directory');
  const calls: { tool: string; args: Params }[] = [];
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'ui_screenshot') {
      const bytes = Buffer.alloc(24); bytes.writeUInt32BE(1200, 16); bytes.writeUInt32BE(800, 20);
      return { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] };
    }
    return textResult({ ok: true, clip: 12 });
  } };
  const api = await startApi(new FilmcraftService(backend), { token, port: 0, chat: { env: { FILMCRAFT_STATE_DIR: directory }, fetch: mock } });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(api.url + '/v1/chat/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as any };
  };
  const finish = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const run = (await request(`runs/${id}`)).data;
      if (!['running', 'stopping'].includes(run.status)) return run;
      await delay(10);
    }
    throw new Error('Run timed out');
  };
  return { request, finish, calls, directory };
}

for (const provider of ['claude', 'chatgpt'] as const) test(`${provider} native function calling traverses MCP and HTTP, returns results, isolates credentials`, async t => {
  let step = 0;
  const mock: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    assert(!body.tools.some((t: any) => t.name === 'filmcraft_ui_control'));
    if (provider === 'claude') {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal((options?.headers as any)['x-api-key'], key);
      if (step++ === 0) return Response.json({ content: [{ type: 'tool_use', id: 'call1', name: 'filmcraft_marker_add', input: { seconds: 1, name: 'Opening' } }], stop_reason: 'tool_use' });
      assert.equal(body.messages.at(-1).content[0].tool_use_id, 'call1');
      assert.match(body.messages.at(-1).content[0].content[0].text, /ok/);
      return Response.json({ content: [{ type: 'text', text: 'Added Opening at 1 second.' }], stop_reason: 'end_turn' });
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal((options?.headers as any).Authorization, `Bearer ${key}`);
    assert.equal(body.store, false);
    if (step++ === 0) return Response.json({ output: [{ type: 'function_call', call_id: 'call1', name: 'filmcraft_marker_add', arguments: '{"seconds":1,"name":"Opening"}' }], status: 'completed' });
    assert.equal(body.input.at(-1).type, 'function_call_output');
    assert.equal(body.input.at(-1).call_id, 'call1');
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Added Opening at 1 second.' }] }], status: 'completed' });
  };
  const { request, finish, calls, directory } = await setup(t, mock);
  assert.equal((await request('runs', { provider, message: 'Hi' })).status, 400);
  const configured = await request('config', { provider, apiKey: key });
  assert(!JSON.stringify(configured).includes(key));
  const started = await request('runs', { provider, message: 'Add a marker at 1 second named "Opening".' });
  assert.equal(started.status, 202);
  const run = await finish(started.data.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert(run.events.some((e: any) => e.kind === 'tool'));
  assert(run.events.some((e: any) => e.text === 'Added Opening at 1 second.'));
  assert.deepEqual(calls, [{ tool: 'command_run', args: { id: 'markers.add', params: { seconds: 1, name: 'Opening', target: 'program' } } }]);
  assert(!JSON.stringify(await request('providers')).includes(key));
  assert.equal(run.debug, undefined);
  await assert.rejects(stat(join(directory, 'debug')), { code: 'ENOENT' });
});

test('Jev uses System One Choice, experimental image header and grounded arguments through MCP', async t => {
  let action = 0;
  let images = 0;
  const mock: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal((options?.headers as any)['TypeSafe-Danger-Zone-Images'], 'true');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'jev-latest');
    if (body.questions.action) { assert(body.assets[body.state.image.frame].data_base64); images++; }
    else assert.equal(body.assets, undefined);
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries<any>(body.questions)) {
      const selected = key === 'progress' ? 'done' : key === 'action' ? (action++ === 0 ? 'filmcraft_marker_add' : 'done') :
        key === 'target' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'program')! :
        key.startsWith('present.') ? (['present.seconds', 'present.name'].includes(key) ? 'include' : 'omit') :
        key === 'seconds' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 1)! :
        key === 'name' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'Opening')! : '__omit__';
      assert(Object.hasOwn(q.criteria, selected));
      answers[key] = choice(q.criteria, selected);
    }
    return Response.json({ model: 'jev-latest', answers });
  };
  const { request, finish, calls } = await setup(t, mock);
  await request('config', { provider: 'jev', apiKey: key, debugLogging: true });
  const { data } = await request('runs', { provider: 'jev', message: 'Add a marker at 1 second named "Opening".' });
  const run = await finish(data.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(images, 1);
  assert.deepEqual(calls.find(c => c.args.id === 'markers.add')?.args.params, { seconds: 1, name: 'Opening', target: 'program' });
  assert.equal(run.debug.enabled, true);
  const log = await readFile(run.debug.path, 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].event, 'run.start');
  assert.equal(events.at(-1).event, 'run.finish');
  assert.equal(events.at(-1).data.status, 'done');
  assert.equal(events.filter(e => e.event === 'provider.response').length, 4);
  assert(events.some(e => e.event === 'jev.decision' && e.data.parameter === 'seconds' && e.data.selected.value === 1 && e.data.accepted));
  assert(events.some(e => e.event === 'tool.result' && e.data.name === 'filmcraft_marker_add'));
  assert(log.includes('[media omitted]'));
  assert(!log.includes(key));
  assert(!log.includes(token));
  assert(!log.includes('AAAA'));
});

test('debug trace preserves low-confidence responses and the rejected parameter', async t => {
  const { request, finish, calls } = await setup(t, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return Response.json({ answers: { action: { ...choice(body.questions.action.criteria, 'filmcraft_marker_add'), confidence: 0.25 } }, usage: { total_tokens: 123 } });
  });
  await request('config', { provider: 'jev', apiKey: key, debugLogging: true });
  const { data } = await request('runs', { provider: 'jev', message: 'Add a marker.' });
  const run = await finish(data.id);
  assert.equal(run.status, 'error');
  const entries = (await readFile(run.debug.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const response = entries.find(e => e.event === 'provider.response');
  assert.equal(response.data.body.answers.action.confidence, 0.25);
  assert.equal(response.data.body.usage.total_tokens, 123);
  assert(entries.some(e => e.event === 'jev.decision' && !e.data.accepted && e.data.parameter === 'action'));
  assert(!calls.some(c => c.tool === 'command_run'));
});

for (const invalidJson of [false, true]) test(`debug captures redacted provider errors (invalid JSON: ${invalidJson})`, async t => {
  const { request, finish } = await setup(t, async () => invalidJson
    ? new Response(`bad response ${key} Bearer ${token}`, { status: 502 })
    : Response.json({ error: { message: `Rejected ${key} ${token}`, apiKey: 'unknown-echoed-secret' } }, { status: 401 }));
  await request('config', { provider: 'jev', apiKey: key, debugLogging: true });
  const { data } = await request('runs', { provider: 'jev', message: 'Inspect the project.' });
  const run = await finish(data.id);
  assert.equal(run.status, 'error');
  const log = await readFile(run.debug.path, 'utf8');
  assert(log.includes('provider.response'));
  assert(log.includes('provider.error'));
  for (const secret of [key, token, 'unknown-echoed-secret']) assert(!log.includes(secret));
  assert(!JSON.stringify(run).includes('bad response'));
});

test('a logging filesystem failure is visible but does not fail the model run', async t => {
  const { request, finish } = await setup(t, async () => Response.json({ content: [{ type: 'text', text: 'Ready.' }], stop_reason: 'end_turn' }), true);
  await request('config', { provider: 'claude', apiKey: key, debugLogging: true });
  const { data } = await request('runs', { provider: 'claude', message: 'Hello.' });
  const run = await finish(data.id);
  assert.equal(run.status, 'done');
  assert.match(run.debug.error, /Could not create/);
  assert(run.events.some((e: any) => e.text === 'Ready.'));
});

test('cancel aborts provider calls and prevents later edits; no provider secrets in failures', async t => {
  const { request, finish, calls } = await setup(t, async (_url, options) => {
    await delay(10_000, undefined, { signal: options?.signal ?? undefined });
    throw new Error(key);
  });
  await request('config', { provider: 'chatgpt', apiKey: key, debugLogging: true });
  const { data } = await request('runs', { provider: 'chatgpt', message: 'Add a marker.' });
  assert.equal((await request('runs', { provider: 'chatgpt', message: 'Another edit' })).status, 409);
  assert.equal((await request('config', { provider: 'chatgpt', apiKey: 'new' })).status, 409);
  await request(`runs/${data.id}/cancel`, {});
  const run = await finish(data.id);
  assert.equal(run.status, 'stopped');
  assert.equal(calls.length, 0);
  assert(!JSON.stringify(run).includes(key));
  const log = await readFile(run.debug.path, 'utf8');
  assert(log.includes('run.finish'));
  assert(log.includes('stopped'));
  assert(!log.includes(key));
});

test('Jev refuses malformed/uncertain decisions; candidates keep explicit literals and types', () => {
  assert.throws(() => readChoice({ answers: { action: { ...choice({ stop: '' }, 'stop'), choice: 'unknown' } } }, 'action', { stop: '' }));
  assert.throws(() => readChoice({ answers: { action: { ...choice({ stop: '' }, 'stop'), confidence: 0.1 } } }, 'action', { stop: '' }));
  assert.deepEqual(candidates({ type: 'number', minimum: 0 }, 'seconds', 'at 1.5 seconds', []), [1.5]);
  assert.deepEqual(candidates({ type: 'object' }, 'props', '```json\n{"props":{"opacity":0.5}}\n```', []), [{ opacity: 0.5 }]);
  assert.deepEqual(candidates({ type: 'string', pattern: '^/' }, 'path', 'save somewhere', []), []);
});

for (const provider of ['claude', 'chatgpt'] as const) test(`${provider} Jev mode plans from real WAV helper observations and delegates exact cuts to Jev`, async t => {
  let round = 0;
  let jevCalls = 0;
  let audioCalls = 0;
  let edits = 0;
  let clips: any[] = [{ clip: 1, item: 7, startFrame: 0, durationFrames: 240, start: 0 }];
  const target = { clip: 1, track: 'V1', startFrame: 0, durationFrames: 240 };
  const plan = { version: 1, objective: 'Cut at the heard sentence boundary', sequence: 10, steps: [{ id: 'sentence', operation: 'split', target, atFrame: 48, outcome: 'Cut at the audio-model sentence boundary at absolute 2 seconds' }] };
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool, args) => {
    if (tool === 'doc_inspect') return textResult({ project: { activeSequence: 10 }, sequence: { id: 10, settings: { frame_rate: { num: 24, den: 1 } }, video: [{ id: 20, items: clips }], audio: [] } });
    if (args.id === 'audio.read') return textResult({ encoding: 'base64', format: 'pcm_s16le', data: Buffer.alloc(32000).toString('base64'), sampleRate: 16000, channels: 1, frameCount: 16000,
      sequence: { id: 10, name: 'Interview' }, track: null, requestedRange: { startSeconds: 1, durationSeconds: 1, endSeconds: 2 }, actualRange: { startSeconds: 1, durationSeconds: 1, endSeconds: 2 }, signalPath: 'sequence_mix', offlineMedia: [] });
    if (args.id === 'timeline.razor') {
      edits++;
      assert.deepEqual(args.params, { clip: 1, frame: 48 });
      clips = [{ ...clips[0], durationFrames: 48 }, { ...clips[0], clip: 2, startFrame: 48, start: 48 * 254016000000 / 24, durationFrames: 192 }];
    }
    return textResult({ ok: true });
  } };
  const mock: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    if (url === 'https://api.openai.com/v1/chat/completions') {
      audioCalls++;
      const input = body.messages[1].content.find((c: any) => c.type === 'input_audio');
      assert.equal(Buffer.from(input.input_audio.data, 'base64').toString('ascii', 0, 4), 'RIFF');
      return Response.json({ choices: [{ message: { content: 'The sentence ends at excerpt +1.0 second, absolute timeline 2.0 seconds.' } }] });
    }
    if (url === 'https://api.typesafe.ai/v1/systemone') {
      jevCalls++;
      assert.equal(body.assets, undefined); assert.equal(body.state.image, undefined);
      assert.equal(body.state.step.atFrame, 48);
      assert(!JSON.stringify(body).includes('input_audio'));
      return Response.json({ answers: { action: choice(body.questions.action.criteria, 'execute') } });
    }
    assert(body.tools.some((tool: any) => tool.name === 'filmcraft_execute_plan'));
    assert(!body.tools.some((tool: any) => ['filmcraft_clip_split', 'filmcraft_execute', 'filmcraft_batch', 'filmcraft_ui_control'].includes(tool.name)));
    assert.match(body.system ?? body.instructions, /You are the planner/);
    const calls = [
      { name: 'filmcraft_inspect', input: {} },
      { name: 'filmcraft_audio_analyze', input: { startSeconds: 1, durationSeconds: 1, question: 'Where does the sentence end?' } },
      { name: 'filmcraft_execute_plan', input: { plan } },
    ];
    if (round >= 2) assert.match(JSON.stringify(body), /audio-model/);
    const call = calls[round++];
    if (!call) return provider === 'claude' ? Response.json({ content: [{ type: 'text', text: 'The planned cut was verified.' }] }) : Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'The planned cut was verified.' }] }] });
    return provider === 'claude'
      ? Response.json({ content: [{ type: 'tool_use', id: `call${round}`, name: call.name, input: call.input }] })
      : Response.json({ output: [{ type: 'function_call', call_id: `call${round}`, name: call.name, arguments: JSON.stringify(call.input) }] });
  };
  const api = await startApi(new FilmcraftService(backend), { token, port: 0, chat: { env: { ANTHROPIC_API_KEY: 'claude-key', OPENAI_API_KEY: 'openai-key', TYPESAFE_API_KEY: 'jev-key' }, fetch: mock } });
  t.after(api.close);
  const response = await fetch(api.url + '/v1/chat/runs', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, execution: 'jev', message: 'Listen and cut at the end of the sentence.' }) });
  assert.equal(response.status, 202);
  const started = await response.json() as any;
  let run = started;
  for (let i = 0; run.status === 'running' && i < 100; i++) {
    await delay(10);
    run = await (await fetch(api.url + `/v1/chat/runs/${started.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  }
  assert.equal(run.execution, 'jev'); assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(edits, 1); assert.equal(jevCalls, 1); assert.equal(audioCalls, 1);
  assert(run.events.some((e: any) => e.kind === 'result' && e.text.includes('refreshedClipIds')));
  assert(!JSON.stringify(run).includes('UklGR'));
});

for (const provider of ['claude', 'chatgpt'] as const) test(`${provider} Jev mode rejects a hallucinated direct mutation at dispatch`, async t => {
  const { request, finish, calls } = await setup(t, async () => provider === 'claude'
    ? Response.json({ content: [{ type: 'tool_use', id: 'bad', name: 'filmcraft_clip_split', input: { clip: 1, frame: 1 } }] })
    : Response.json({ output: [{ type: 'function_call', call_id: 'bad', name: 'filmcraft_clip_split', arguments: '{"clip":1,"frame":1}' }] }));
  await request('config', { provider, apiKey: key });
  assert.equal((await request('runs', { provider, execution: 'jev', message: 'Cut.' })).data.error.code, 'MISSING_JEV_KEY');
  await request('config', { provider: 'jev', apiKey: 'jev-key' });
  const started = await request('runs', { provider, execution: 'jev', message: 'Cut.' });
  const run = await finish(started.data.id);
  assert.equal(run.status, 'error'); assert.match(run.events.at(-1).text, /Unavailable tool/);
  assert.equal(calls.length, 0);
});

test('native Apply and Clear callbacks configure provider/audio settings while their initiating sidebar clicks remain in flight', async t => {
  let apiUrl = '';
  const results: any[] = [];
  const patches: Record<string, unknown> = {
    'chat.settings.apply': { provider: 'claude', apiKey: 'reentrant-claude', model: 'reentrant-model' },
    'chat.audio.apply': { provider: 'audio', apiKey: 'reentrant-audio', model: 'audio-reentrant' },
    'chat.settings.clear': { provider: 'claude', apiKey: '' },
    'chat.audio.clear': { provider: 'audio', apiKey: '' },
  };
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async (tool, args) => {
    const id = (args.params as any)?.id;
    if (tool === 'ui_control' && args.method === 'ui.click' && patches[id]) {
      const response = await fetch(apiUrl + '/v1/chat/config', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patches[id]) });
      const data = await response.json(); results.push({ status: response.status, data });
      return textResult(data);
    }
    return textResult({});
  } };
  const service = new FilmcraftService(backend);
  const api = await startApi(service, { token, port: 0, chat: { env: {} } }); apiUrl = api.url; t.after(api.close);
  for (const id of Object.keys(patches)) {
    const result = await service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id } });
    assert(!result.isError);
    assert.equal(results.at(-1).status, 200, JSON.stringify(results.at(-1)));
    assert.equal(service.busy, false);
  }
  assert.equal(results[0].data.providers.find((p: any) => p.id === 'claude').configured, true);
  assert.equal(results[1].data.audio.configured, true);
  assert.equal(results[2].data.providers.find((p: any) => p.id === 'claude').configured, false);
  assert.equal(results[3].data.audio.configured, false);
});

test('native Send can reenter run creation, while active assistant inspection and Stop remain available', async t => {
  let apiUrl = '';
  let runId = '';
  let releaseClick!: () => void;
  const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
  let sent!: () => void;
  const runStarted = new Promise<void>(resolve => { sent = resolve; });
  let enteredProvider!: () => void;
  const providerStarted = new Promise<void>(resolve => { enteredProvider = resolve; });
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(apiUrl + '/v1/chat/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as any };
  };
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async (tool, args) => {
    if (tool === 'ui_control' && args.method === 'ui.click' && (args.params as any).id === 'chat.send') {
      const started = await request('runs', { provider: 'claude', message: 'Wait for Stop.' });
      assert.equal(started.status, 202, JSON.stringify(started));
      runId = started.data.id; sent(); await clickGate;
      return textResult({ started: runId });
    }
    if (tool === 'ui_control' && args.method === 'chat.inspect') return textResult((await request('runs/' + runId)).data);
    if (tool === 'ui_control' && args.method === 'ui.click' && (args.params as any).id === 'chat.stop') return textResult((await request(`runs/${runId}/cancel`, {})).data);
    throw new Error('Unexpected native edit');
  } };
  const service = new FilmcraftService(backend);
  const api = await startApi(service, { token, port: 0, chat: { env: { ANTHROPIC_API_KEY: 'test-claude' }, fetch: async (_url, options) => {
    enteredProvider();
    await delay(10_000, undefined, { signal: options?.signal ?? undefined });
    throw new Error('must be cancelled');
  } } }); apiUrl = api.url;
  t.after(async () => { releaseClick(); await api.close(); });
  const sending = service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'chat.send' } });
  await runStarted; await providerStarted;
  const inspected = await service.invoke('filmcraft_ui_control', { method: 'chat.inspect', params: {} });
  assert.match(JSON.stringify(inspected), /running/);
  assert.equal((await request('config', { provider: 'claude', apiKey: 'blocked' })).status, 409);
  await service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'chat.stop' } });
  for (let i = 0; service.busy && i < 100; i++) await delay(10);
  assert.equal((await request('runs/' + runId)).data.status, 'stopped');
  assert.equal(service.busy, false, 'The still-in-flight assistant Send click must not retain editor ownership');
  releaseClick(); await sending;
});

test('configuration atomically reserves shared editor ownership across suspended persistence and releases it after failure', async () => {
  let entered!: () => void, release!: () => void;
  const enteredPersistence = new Promise<void>(resolve => { entered = resolve; });
  const persistenceGate = new Promise<void>(resolve => { release = resolve; });
  const calls: Params[] = [];
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (_tool, args) => { calls.push(args); return textResult({}); } };
  const service = new FilmcraftService(backend);
  const { ChatService } = await import('../src/chat/service.js');
  const chat = new ChatService('http://127.0.0.1:9999', token, { ANTHROPIC_API_KEY: 'initial', TYPESAFE_API_KEY: 'jev' }, fetch, service, async () => { entered(); await persistenceGate; throw new Error('controlled persistence failure'); });
  const configuring = chat.configure({ provider: 'audio', apiKey: 'new-audio', persist: true });
  const rejected = assert.rejects(configuring, /controlled persistence failure/);
  await enteredPersistence;
  assert.equal(service.busy, true);
  await assert.rejects(service.invoke('filmcraft_project_new', { name: 'must wait' }), (e: any) => e.code === 'BUSY');
  await assert.rejects(service.invoke('filmcraft_execute_plan', { plan: { version: 1, objective: 'Split', sequence: 10, steps: [{ id: 'cut', operation: 'split', target: { clip: 1, track: 'V1', startFrame: 0, durationFrames: 24 }, atFrame: 12, outcome: 'Split at twelve' }] } }), (e: any) => e.code === 'BUSY');
  assert.throws(() => chat.start({ provider: 'claude', message: 'must wait' }), (e: any) => e.code === 'BUSY');
  await assert.rejects(chat.configure({ provider: 'claude', model: 'must wait' }), (e: any) => e.code === 'BUSY');
  assert.equal(calls.length, 0);
  release(); await rejected;
  assert.equal(service.busy, false);
  assert.equal(chat.providers().audio.configured, false, 'Failed persistence must not publish the candidate credential');
  await service.invoke('filmcraft_project_new', { name: 'available after failure' });
  assert.equal(calls.length, 1);
});

test('actual queued editor work and a running Jev plan prevent configuration reservations', async () => {
  let release!: () => void;
  const editGate = new Promise<void>(resolve => { release = resolve; });
  let enteredJev!: () => void;
  const jevEntered = new Promise<void>(resolve => { enteredJev = resolve; });
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool, args) => {
    if (tool === 'doc_inspect') return textResult({ project: { activeSequence: 10 }, sequence: { id: 10, settings: { frame_rate: { num: 24, den: 1 } }, video: [{ id: 20, items: [{ clip: 1, item: 7, startFrame: 0, durationFrames: 24 }] }], audio: [] } });
    if (args.id === 'file.newProject') await editGate;
    return textResult({});
  } };
  const service = new FilmcraftService(backend);
  const { ChatService } = await import('../src/chat/service.js');
  const chat = new ChatService('http://127.0.0.1:9999', token, { TYPESAFE_API_KEY: 'jev' }, async (_url, options) => {
    enteredJev(); await delay(10_000, undefined, { signal: options?.signal ?? undefined }); throw new Error('cancelled');
  }, service);
  const edit = service.invoke('filmcraft_project_new', { name: 'working' });
  const queued = service.invoke('filmcraft_project_new', { name: 'queued' });
  await assert.rejects(chat.configure({ provider: 'audio', apiKey: 'blocked' }), (e: any) => e.code === 'BUSY');
  release(); await Promise.all([edit, queued]);
  for (let i = 0; service.busy && i < 100; i++) await delay(1);
  const abort = new AbortController();
  const executing = service.invoke('filmcraft_execute_plan', { plan: { version: 1, objective: 'Split', sequence: 10, steps: [{ id: 'cut', operation: 'split', target: { clip: 1, track: 'V1', startFrame: 0, durationFrames: 24 }, atFrame: 12, outcome: 'Split at twelve' }] } }, { signal: abort.signal });
  await jevEntered;
  await assert.rejects(chat.configure({ provider: 'claude', apiKey: 'blocked' }), (e: any) => e.code === 'BUSY');
  abort.abort(); await executing;
  assert.equal(service.busy, false);
});

for (const provider of ['claude', 'chatgpt'] as const) test(`${provider} cannot use the assistant control bypass to change credentials`, async t => {
  const { request, finish, calls } = await setup(t, async () => provider === 'claude'
    ? Response.json({ content: [{ type: 'tool_use', id: 'bad', name: 'filmcraft_ui_control', input: { method: 'ui.click', params: { id: 'chat.settings.apply' } } }] })
    : Response.json({ output: [{ type: 'function_call', call_id: 'bad', name: 'filmcraft_ui_control', arguments: '{"method":"ui.click","params":{"id":"chat.settings.apply"}}' }] }));
  await request('config', { provider, apiKey: key });
  const started = await request('runs', { provider, message: 'Inspect the project.' });
  const run = await finish(started.data.id);
  assert.equal(run.status, 'error'); assert.match(run.events.at(-1).text, /Unavailable tool/); assert.equal(calls.length, 0);
});
