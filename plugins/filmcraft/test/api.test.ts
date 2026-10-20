import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Backend, Params } from '../src/core.js';
import { PluginError, textResult, failure, resultData } from '../src/core.js';
import { FilmcraftService } from '../src/api/service.js';
import { startApi } from '../src/api/server.js';
import { FilmcraftApiClient } from '../src/api/client.js';
import { tools, describeTool } from '../src/tools/catalog.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = 'test-token-that-is-long-enough-for-local-tests';
class Stub implements Backend {
  mode = 'headless' as const;
  connected = true;
  calls: { tool: string; args: Params }[] = [];
  async call(tool: string, args: Params) {
    this.calls.push({ tool, args });
    if (args.id === 'bad.command') return failure('No such command');
    if (tool === 'command_list') return textResult([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
    if (tool === 'render_preview') return { content: [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }] };
    return textResult({ tool, args });
  }
  async close() { this.connected = false; }
}

test('HTTP API validates/authenticates requests and preserves engine errors and images', async t => {
  const backend = new Stub();
  const api = await startApi(new FilmcraftService(backend), { token, port: 0 });
  t.after(api.close);
  const client = new FilmcraftApiClient(api.url, token);
  const post = (route: string, raw: string, headers = {}) => fetch(api.url + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: raw });
  assert.equal((await fetch(api.url + '/v1/health')).status, 401);
  assert.equal((await fetch(api.url + '/v1/health', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } })).status, 403);
  const badHost = await new Promise<number | undefined>(resolve => {
    const req = request(api.url + '/v1/health', { headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await client.health()).mode, 'headless');
  assert(!(await client.listTools()).some(t => t.name.startsWith('filmcraft_ui_')));
  assert.equal((await post('/v1/tools/filmcraft_project_new', '{')).status, 400);
  assert.equal((await post('/v1/tools/filmcraft_project_new', '{"name":"x","typo":1}')).status, 400);
  assert.equal((await post('/v1/tools/filmcraft_clip_trim', '{"clip":1,"edge":"out","deltaFrames":"three"}')).status, 400);
  assert.equal((await post('/v1/commands/project.inspect', '[]')).status, 400);
  assert.equal((await post('/v1/commands/playhead.set', '{"time":9007199254740993}')).status, 400);
  assert.equal((await post('/v1/tools/filmcraft_project_open', '{"path":"relative.fcproj"}')).status, 400);
  assert.equal((await post('/v1/tools/filmcraft_ui_inspect', '{}')).status, 409);
  assert.equal((await post('/v1/tools/no_such', '{}')).status, 404);
  assert.equal((await post('/v1/commands/project.inspect', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/v1/commands/project.inspect', JSON.stringify({ data: 'a'.repeat(4 * 1024 * 1024) }))).status, 413);
  const failed = await client.callTool('filmcraft_execute', { id: 'bad.command' });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0]?.type, 'text');
  const image = await client.callTool('filmcraft_render_preview');
  assert.equal(image.content[0]?.type, 'image');
  const commands = resultData(await client.callTool('filmcraft_commands', { offset: 1, limit: 1 }));
  assert.deepEqual(commands, { total: 3, offset: 1, commands: [{ id: 'two' }] });
  const success = await post('/v1/commands/file.newBin', '{"name":"Footage"}');
  assert.equal(success.status, 200);
  assert.deepEqual(backend.calls.at(-1), { tool: 'command_run', args: { id: 'file.newBin', params: { name: 'Footage' } } });
  const spec = await (await fetch(api.url + '/v1/openapi.json', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(spec.openapi, '3.1.0');
  assert(spec.paths['/v1/tools/filmcraft_clip_trim'].post.requestBody);
  backend.connected = false;
  assert.equal((await fetch(api.url + '/v1/health', { headers: { Authorization: `Bearer ${token}` } })).status, 503);
});

test('serialized requests cannot interleave a batch; job controls bypass the queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const calls: string[] = [];
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool, args) => {
    const name = tool === 'command_batch' ? 'batch' : String(args.id);
    calls.push(name);
    if (name === 'batch') await gate;
    return textResult({});
  } };
  const service = new FilmcraftService(backend);
  const batch = service.invoke('filmcraft_batch', { steps: [{ id: 'file.newBin' }] });
  const later = service.invoke('filmcraft_project_new', { name: 'Later' });
  await new Promise(r => setImmediate(r));
  await service.invoke('filmcraft_jobs_cancel', { job: 1 });
  assert.deepEqual(calls, ['batch', 'jobs.cancel']);
  release();
  await Promise.all([batch, later]);
  assert.deepEqual(calls, ['batch', 'jobs.cancel', 'file.newProject']);
});

test('large tick values in native JSON content are lossless and schemas are unique', () => {
  assert.deepEqual(resultData({ content: [{ type: 'text', text: '{"ticks":9223372036854775807}' }] }), { ticks: '9223372036854775807' });
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  for (const tool of tools) {
    const schema = describeTool(tool).inputSchema;
    assert.equal(schema.type, 'object', tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
  }
  assert.throws(() => new FilmcraftApiClient('http://example.com', token), PluginError);
});

test('Streamable HTTP MCP goes through the authenticated API and returns MCP results', async t => {
  const backend = new Stub();
  const api = await startApi(new FilmcraftService(backend), { token, port: 0 });
  const client = new Client({ name: 'http-mcp-test', version: '1' });
  t.after(async () => { await client.close(); await api.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(api.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert((await client.listTools()).tools.some(t => t.name === 'filmcraft_inspect'));
  await client.callTool({ name: 'filmcraft_bin_create', arguments: { name: 'HTTP MCP bin' } });
  assert.deepEqual(backend.calls.at(-1), { tool: 'command_run', args: { id: 'file.newBin', params: { name: 'HTTP MCP bin' } } });
  const failed = await client.callTool({ name: 'filmcraft_execute', arguments: { id: 'bad.command' } });
  assert.equal(failed.isError, true);
  const preview = await client.callTool({ name: 'filmcraft_render_preview' });
  assert.equal(preview.content[0]?.type, 'image');
  assert.equal((await client.listResources()).resources.length, 2);
  assert.equal((await fetch(api.url + '/mcp', { headers: { Authorization: `Bearer ${token}` } })).status, 405);
});

test('caller cancellation is optional; a pre-aborted API tool call never dispatches', async t => {
  const backend = new Stub();
  const api = await startApi(new FilmcraftService(backend), { token, port: 0 });
  t.after(api.close);
  const client = new FilmcraftApiClient(api.url, token);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.callTool('filmcraft_project_new', { name: 'Must not dispatch' }, { signal: aborted.signal }));
  assert.equal(backend.calls.length, 0);
  const result = await client.callTool('filmcraft_project_new', { name: 'Legacy caller' });
  assert(!result.isError);
  assert.equal(backend.calls.length, 1);
});

test('stateless external MCP cancellation aborts Jev inference, preserves an in-flight edit, keeps busy until settled, and blocks replay', { timeout: 10_000 }, async t => {
  let entered!: () => void;
  const nativeEntered = new Promise<void>(r => { entered = r; });
  let release!: () => void;
  const nativeGate = new Promise<void>(r => { release = r; });
  const target = { clip: 1, track: 'V1', startFrame: 0, durationFrames: 240 };
  let clips: any[] = [{ ...target, item: 7, start: 0 }];
  let edits = 0;
  let inferenceCalls = 0;
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool, args) => {
    if (tool === 'doc_inspect') return textResult({ project: { activeSequence: 10 }, sequence: { id: 10, settings: { frame_rate: { num: 24, den: 1 } }, video: [{ id: 20, items: clips }], audio: [] } });
    if (args.id === 'timeline.razor') {
      edits++;
      clips = [{ ...clips[0], durationFrames: 96 }, { ...clips[0], clip: 2, startFrame: 96, start: 96 * 254016000000 / 24, durationFrames: 144 }];
      entered(); await nativeGate;
    }
    return textResult({ ok: true });
  } };
  const providerFetch: typeof fetch = async (_url, options) => {
    inferenceCalls++;
    const body = JSON.parse(String(options?.body));
    return Response.json({ answers: { action: { type: 'choice', choice: 'execute', confidence: 0.99, probabilities: Object.fromEntries(Object.keys(body.questions.action.criteria).map(k => [k, k === 'execute' ? 1 : 0])) } } });
  };
  const service = new FilmcraftService(backend, { env: { TYPESAFE_API_KEY: 'test-jev-key' }, fetch: providerFetch });
  const api = await startApi(service, { token, port: 0 });
  const client = new Client({ name: 'cancel-plan-mcp', version: '1' });
  t.after(async () => { release(); await client.close(); await api.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(api.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const args = { plan: { version: 1, objective: 'Split then trim', sequence: 10, steps: [
    { id: 'cut', operation: 'split', target, atFrame: 96, outcome: 'Split at frame 96' },
    { id: 'trim', operation: 'trim', target: { stepId: 'cut', segment: 'right' }, edge: 'out', deltaFrames: -24, outcome: 'Shorten right part' },
  ] } };
  const abort = new AbortController();
  const running = client.callTool({ name: 'filmcraft_execute_plan', arguments: args }, undefined, { signal: abort.signal, timeout: 5000 });
  const rejected = assert.rejects(running);
  await nativeEntered;
  abort.abort();
  await rejected;
  await new Promise(r => setTimeout(r, 30));
  await assert.rejects(service.invoke('filmcraft_clip_trim', { clip: 1, edge: 'out', deltaFrames: -1 }), (e: any) => e.code === 'BUSY');
  assert.equal(service.busy, true);
  release();
  for (let i = 0; service.busy && i < 200; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(service.busy, false);
  assert.equal(edits, 1); assert.equal(inferenceCalls, 1);
  const inspected = resultData(await service.invoke('filmcraft_inspect', {})) as any;
  assert.equal(inspected.sequence.video[0].items.length, 2);
  await assert.rejects(service.invoke('filmcraft_execute_plan', args), (e: any) => e.code === 'PLAN_REPLAY');
});

test('external HTTP tool abort reaches a blocked Jev provider request and prevents edits', { timeout: 5000 }, async t => {
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { entered = resolve; });
  let providerAborted = false;
  let writes = 0;
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async (tool) => {
    if (tool === 'doc_inspect') return textResult({ project: { activeSequence: 10 }, sequence: { id: 10, settings: { frame_rate: { num: 24, den: 1 } }, video: [{ id: 20, items: [{ clip: 1, item: 7, startFrame: 0, durationFrames: 240 }] }], audio: [] } });
    writes++; return textResult({});
  } };
  const service = new FilmcraftService(backend, { env: { TYPESAFE_API_KEY: 'test-jev-key' }, fetch: async (_url, options) => {
    entered();
    await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => { providerAborted = true; reject(new Error('aborted')); }, { once: true }));
    throw new Error('unreachable');
  } });
  const api = await startApi(service, { token, port: 0 }); t.after(api.close);
  const client = new FilmcraftApiClient(api.url, token, 1000);
  const abort = new AbortController();
  const request = client.callTool('filmcraft_execute_plan', { plan: { version: 1, objective: 'Split', sequence: 10, steps: [{ id: 'cut', operation: 'split', target: { clip: 1, track: 'V1', startFrame: 0, durationFrames: 240 }, atFrame: 96, outcome: 'Split at 96' }] } }, { signal: abort.signal });
  const rejected = assert.rejects(request);
  await gate; abort.abort(); await rejected;
  for (let i = 0; service.busy && i < 200; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(providerAborted, true); assert.equal(service.busy, false); assert.equal(writes, 0);
});

test('only exact assistant inspection and ID-only clicks bypass editor ownership and queue accounting', async () => {
  const calls: Params[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async (_tool, args) => {
    calls.push(args);
    if ((args.params as any)?.id === 'chat.settings.apply') await gate;
    return textResult({ ok: true });
  } };
  const service = new FilmcraftService(backend);
  const applying = service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'chat.settings.apply' } });
  assert.equal(service.busy, false, 'An initiating assistant click must not count as a pending editor command');
  const configuration = service.beginConfiguration();
  await service.invoke('filmcraft_ui_control', { method: 'chat.inspect', params: {} });
  await service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'chat.settings.clear' } });
  const bypassAttempts = [
    { method: 'ui.click', params: { id: 'timeline.clip.1' } },
    { method: 'ui.click', params: { id: 'chat.send', x: 0, y: 0 } },
    { method: 'ui.click', params: { id: 'chat.send', fx: 0, fy: 0 } },
    { method: 'ui.click', params: { id: 'chat.send', modifiers: { shift: true } } },
    { method: 'ui.click', params: { id: 'chat.send', ctrl: true } },
    { method: 'ui.click', params: { id: 'chat.send', button: 'secondary' } },
    { method: 'ui.click', params: { id: 'chat.send', count: 2 } },
    { method: 'chat.inspect', params: { id: 'chat.send' } },
    { method: 'ui.type', params: { id: 'chat.prompt', text: 'run' } },
    { method: 'ui.set', params: { theme: 'dark' } },
    { method: 'command_run', params: { id: 'file.newProject' } },
  ];
  for (const args of bypassAttempts) await assert.rejects(service.invoke('filmcraft_ui_control', args), (e: any) => e.code === 'BUSY');
  await assert.rejects(service.invoke('filmcraft_execute', { id: 'chat.inspect' }), (e: any) => e.code === 'BUSY');
  await assert.rejects(service.invoke('filmcraft_audio_read', { startSeconds: 0, durationSeconds: 1 }), (e: any) => e.code === 'BUSY');
  assert.equal(calls.length, 3, 'Rejected bypass attempts must never reach the backend');
  release(); await applying;
  service.endConfiguration(configuration);
  const chat = service.beginChat();
  await service.invoke('filmcraft_ui_control', { method: 'chat.inspect', params: {} });
  await service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'chat.stop' } });
  await assert.rejects(service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'timeline.clip.1' } }), (e: any) => e.code === 'BUSY');
  service.endChat(chat);
  assert.equal(service.busy, false);
});

test('generic UI commands continue to count as editor work until their backend calls settle', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async () => { await gate; return textResult({}); } };
  const service = new FilmcraftService(backend);
  const click = service.invoke('filmcraft_ui_control', { method: 'ui.click', params: { id: 'timeline.clip.1' } });
  assert.equal(service.busy, true);
  assert.throws(() => service.beginConfiguration(), (e: any) => e.code === 'BUSY');
  assert.throws(() => service.beginChat(), (e: any) => e.code === 'BUSY');
  release(); await click;
});
