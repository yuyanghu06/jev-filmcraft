import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DebugTrace, debugRedactor } from '../src/chat/debug.js';

test('debug redaction covers nested JSON, credentials and all provider image forms', () => {
  const key = 'secret-with-"quote';
  const sanitize = debugRedactor([key, 'local-token']);
  const value = {
    text: `echo ${key} ${encodeURIComponent(key)} Bearer local-token`,
    apiKey: 'unknown-key',
    content: [{ type: 'image', data: 'PIXELS' }, { type: 'text', text: JSON.stringify({ access_token: 'nested-secret' }) }],
    source: { type: 'base64', data: 'CLAUDE_PIXELS' },
    assets: { frame: { data_base64: 'JEV_PIXELS' } },
    image_url: 'data:image/png;base64,OPENAI_PIXELS',
    arguments: JSON.stringify({ headers: { Authorization: 'Bearer unrelated-secret' }, seconds: 2 }),
    malformed: `{"token":"malformed-secret", broken ${key}`,
    confidence: 0.25,
  };
  const log = JSON.stringify(sanitize(value));
  for (const secret of [key, encodeURIComponent(key), 'local-token', 'unknown-key', 'nested-secret', 'PIXELS', 'unrelated-secret', 'malformed-secret']) assert(!log.includes(secret), secret);
  assert(log.includes('0.25'));
  assert.equal(value.apiKey, 'unknown-key', 'Redaction must not mutate the provider response');
  const shared = { description: 'Same schema in two places' };
  assert.deepEqual(sanitize({ a: shared, b: shared }), { a: shared, b: shared });
  assert.doesNotThrow(() => debugRedactor(['invalid-\uD800-key']));
});

test('traces are private, rotate only trace files and expose explicit size limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'filmcraft-debug-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 21; i++) await writeFile(join(dir, `2020-01-01T00-00-00.000Z_${randomUUID()}.jsonl`), '{}\n');
  await writeFile(join(dir, 'keep-me.jsonl'), 'unrelated');
  const trace = new DebugTrace(dir, []);
  await trace.start(randomUUID());
  assert.equal((await readdir(dir)).length, 21);
  assert.equal(await readFile(join(dir, 'keep-me.jsonl'), 'utf8'), 'unrelated');
  await trace.write('large', 'x'.repeat(3 * 1024 * 1024));
  for (let i = 0; i < 18; i++) await trace.write('response', { text: 'y'.repeat(1024 * 1024) });
  await trace.close();
  const entries = (await readFile(trace.info.path!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries[0].data.truncated, true);
  assert.equal(entries.at(-1).event, 'trace.limit');
  assert.equal(trace.info.truncated, true);
  if (process.platform !== 'win32') assert.equal((await stat(trace.info.path!)).mode & 0o777, 0o600);
  assert((await stat(trace.info.path!)).size < 17 * 1024 * 1024);
});
