import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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
async function setup(t: any, mock: typeof fetch) {
  const calls: { tool: string; args: Params }[] = [];
  const backend: Backend = { mode: 'bridge', connected: true, close: async () => {}, call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'ui_screenshot') {
      const bytes = Buffer.alloc(24); bytes.writeUInt32BE(1200, 16); bytes.writeUInt32BE(800, 20);
      return { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] };
    }
    return textResult({ ok: true, clip: 12 });
  } };
  const api = await startApi(new FilmcraftService(backend), { token, port: 0, chat: { env: {}, fetch: mock } });
  t.after(api.close);
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
  return { request, finish, calls };
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
  const { request, finish, calls } = await setup(t, mock);
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
});

test('Jev uses System One Choice, experimental image header and grounded arguments through MCP', async t => {
  let action = 0;
  let images = 0;
  const mock: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal((options?.headers as any)['TypeSafe-Danger-Zone-Images'], 'true');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'jev-latest');
    assert(body.assets[body.state.image.frame].data_base64);
    images++;
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries<any>(body.questions)) {
      const selected = key === 'action' ? (action++ === 0 ? 'filmcraft_marker_add' : 'done') :
        key === 'seconds' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 1)! :
        key === 'name' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'Opening')! : '__omit__';
      assert(Object.hasOwn(q.criteria, selected));
      answers[key] = choice(q.criteria, selected);
    }
    return Response.json({ model: 'jev-latest', answers });
  };
  const { request, finish, calls } = await setup(t, mock);
  await request('config', { provider: 'jev', apiKey: key });
  const { data } = await request('runs', { provider: 'jev', message: 'Add a marker at 1 second named "Opening".' });
  const run = await finish(data.id);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.equal(images, 3);
  assert.equal(calls.at(-1)?.args.id, 'markers.add');
  assert.deepEqual(calls.at(-1)?.args.params, { seconds: 1, name: 'Opening', target: 'program' });
});

test('cancel aborts provider calls and prevents later edits; no provider secrets in failures', async t => {
  const { request, finish, calls } = await setup(t, async (_url, options) => {
    await delay(10_000, undefined, { signal: options?.signal ?? undefined });
    throw new Error(key);
  });
  await request('config', { provider: 'chatgpt', apiKey: key });
  const { data } = await request('runs', { provider: 'chatgpt', message: 'Add a marker.' });
  assert.equal((await request('runs', { provider: 'chatgpt', message: 'Another edit' })).status, 409);
  assert.equal((await request('config', { provider: 'chatgpt', apiKey: 'new' })).status, 409);
  await request(`runs/${data.id}/cancel`, {});
  const run = await finish(data.id);
  assert.equal(run.status, 'stopped');
  assert.equal(calls.length, 0);
  assert(!JSON.stringify(run).includes(key));
});

test('Jev refuses malformed/uncertain decisions; candidates keep explicit literals and types', () => {
  assert.throws(() => readChoice({ answers: { action: { ...choice({ stop: '' }, 'stop'), choice: 'unknown' } } }, 'action', { stop: '' }));
  assert.throws(() => readChoice({ answers: { action: { ...choice({ stop: '' }, 'stop'), confidence: 0.1 } } }, 'action', { stop: '' }));
  assert.deepEqual(candidates({ type: 'number', minimum: 0 }, 'seconds', 'at 1.5 seconds', []), [1.5]);
  assert.deepEqual(candidates({ type: 'object' }, 'props', '```json\n{"props":{"opacity":0.5}}\n```', []), [{ opacity: 0.5 }]);
  assert.deepEqual(candidates({ type: 'string', pattern: '^/' }, 'path', 'save somewhere', []), []);
});
