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
