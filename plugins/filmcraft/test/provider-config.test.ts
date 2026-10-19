import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProviderConfig, loadProviderEnvironment } from '../src/chat/config.js';
import { ChatService } from '../src/chat/service.js';

async function configFile(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'filmcraft-provider-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { FILMCRAFT_PROVIDERS_CONFIG: join(dir, 'providers.local.json') };
}

test('provider config creation is private and never overwrites existing credentials', async t => {
  const env = await configFile(t);
  const created = await initProviderConfig(env);
  assert.equal(created.created, true);
  const template = JSON.parse(await readFile(created.path, 'utf8'));
  for (const provider of ['claude', 'chatgpt', 'jev']) assert.equal(template[provider].apiKey, '');
  if (process.platform !== 'win32') assert.equal((await stat(created.path)).mode & 0o777, 0o600);
  const existing = '{"jev":{"apiKey":"fixture-secret"}}';
  await writeFile(created.path, existing);
  assert.equal((await initProviderConfig(env)).created, false);
  assert.equal(await readFile(created.path, 'utf8'), existing);
});

test('file keys/models reach chat configuration without appearing in provider responses', async t => {
  const env = await configFile(t);
  const config = {
    claude: { apiKey: ' fixture-claude-secret ', model: 'claude-test' },
    chatgpt: { apiKey: 'fixture-openai-secret', model: 'openai-test' },
    jev: { apiKey: 'fixture-jev-secret', model: 'jev-test' },
  };
  await writeFile(env.FILMCRAFT_PROVIDERS_CONFIG, JSON.stringify(config));
  const loaded = await loadProviderEnvironment(env);
  assert.equal(loaded.ANTHROPIC_API_KEY, 'fixture-claude-secret');
  assert.equal(loaded.OPENAI_API_KEY, config.chatgpt.apiKey);
  assert.equal(loaded.TYPESAFE_API_KEY, config.jev.apiKey);
  assert.equal(Object.keys(env).length, 1, 'Loading must not mutate the source environment');
  const publicConfig = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', loaded).providers();
  assert(publicConfig.providers.every(p => p.configured));
  assert.deepEqual(publicConfig.providers.map(p => p.model), ['claude-test', 'openai-test', 'jev-test']);
  assert(!JSON.stringify(publicConfig).includes('secret'));
  assert.equal(publicConfig.experimentalJevHeader, 'TypeSafe-Danger-Zone-Images: true');
});

test('environment overrides file values, including empty keys and the Jev alias', async t => {
  const env = await configFile(t);
  await writeFile(env.FILMCRAFT_PROVIDERS_CONFIG, JSON.stringify({ claude: { apiKey: 'file-claude' }, jev: { apiKey: 'file-jev', model: 'file-model' } }));
  const loaded = await loadProviderEnvironment({ ...env, ANTHROPIC_API_KEY: '', JEV_API_KEY: 'alias-key', JEV_MODEL: 'environment-model' });
  assert.equal(loaded.ANTHROPIC_API_KEY, '');
  assert.equal(loaded.TYPESAFE_API_KEY, 'alias-key');
  assert.equal(loaded.JEV_MODEL, 'environment-model');
  assert.equal((await loadProviderEnvironment({ ...env, TYPESAFE_API_KEY: 'primary-key', JEV_API_KEY: 'alias-key' })).TYPESAFE_API_KEY, 'primary-key');
});

test('missing custom files and malformed settings fail without echoing secrets', async t => {
  const env = await configFile(t);
  await assert.rejects(loadProviderEnvironment(env), /Cannot read provider configuration/);
  for (const contents of ['{"jev":{"apiKey":"fixture-secret"', '{"jev":{"apiKey":{"fixture-secret":true}}}', '{"jev":{"apiKey":"fixture-secret","typo":true}}', 'fixture-secret'.repeat(3000)]) {
    await writeFile(env.FILMCRAFT_PROVIDERS_CONFIG, contents);
    await assert.rejects(loadProviderEnvironment(env), (error: Error) => {
      assert.match(error.message, /Invalid provider configuration/);
      assert(!error.message.includes('fixture-secret'));
      return true;
    });
  }
});
