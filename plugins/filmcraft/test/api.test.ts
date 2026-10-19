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
