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

test('remembered UI settings survive restart, preserve other providers, and clear saved keys', async t => {
  const env = await configFile(t);
  await initProviderConfig(env);
  const service = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', env);
  await service.configure({ provider: 'claude', apiKey: 'fixture-claude', persist: true });
  const response = await service.configure({ provider: 'jev', apiKey: 'fixture-jev', model: 'fixture-model', debugLogging: true, persist: true });
  assert.equal(response.saved, true);
  assert(!JSON.stringify(response).includes('fixture-jev'));
  let loaded = await loadProviderEnvironment(env);
  assert.equal(loaded.TYPESAFE_API_KEY, 'fixture-jev');
  assert.equal(loaded.ANTHROPIC_API_KEY, 'fixture-claude');
  assert.equal(loaded.JEV_MODEL, 'fixture-model');
  assert.equal(loaded.JEV_DEBUG_LOGGING, '1');
  assert.equal((await loadProviderEnvironment({ ...env, JEV_DEBUG_LOGGING: '0' })).JEV_DEBUG_LOGGING, '0');
  if (process.platform !== 'win32') assert.equal((await stat(env.FILMCRAFT_PROVIDERS_CONFIG)).mode & 0o777, 0o600);
  const restarted = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', loaded);
  assert(restarted.providers().providers.find(p => p.id === 'jev')?.configured);
  assert.equal(restarted.providers().providers.find(p => p.id === 'jev')?.debugLogging, true);
  await service.configure({ provider: 'jev', debugLogging: false, persist: true });
  assert.equal((await loadProviderEnvironment(env)).JEV_DEBUG_LOGGING, '0');
  await service.configure({ provider: 'jev', apiKey: 'session-only' });
  assert.equal((await loadProviderEnvironment(env)).TYPESAFE_API_KEY, 'fixture-jev');
  await service.configure({ provider: 'jev', apiKey: '', persist: true });
  loaded = await loadProviderEnvironment(env);
  assert.equal(loaded.TYPESAFE_API_KEY, '');
  assert.equal(loaded.ANTHROPIC_API_KEY, 'fixture-claude');
});

test('failed settings saves preserve the file and the current session configuration', async t => {
  const env = await configFile(t);
  const service = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', env);
  await writeFile(env.FILMCRAFT_PROVIDERS_CONFIG, '{"broken":"fixture-secret"');
  await assert.rejects(service.configure({ provider: 'jev', apiKey: 'fixture-new-key', persist: true }), /Invalid provider configuration/);
  assert.equal((await readFile(env.FILMCRAFT_PROVIDERS_CONFIG, 'utf8')), '{"broken":"fixture-secret"');
  assert.equal(service.providers().providers.find(p => p.id === 'jev')?.configured, false);
});

test('dedicated Audio settings persist independently, honor env priority, and fall back to the saved OpenAI key', async t => {
  const env = await configFile(t);
  await initProviderConfig(env);
  const service = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', env);
  await service.configure({ provider: 'chatgpt', apiKey: 'saved-openai', persist: true });
  await service.configure({ provider: 'audio', apiKey: 'saved-audio', model: 'audio-configured', persist: true });
  const loaded = await loadProviderEnvironment(env);
  assert.equal(loaded.FILMCRAFT_AUDIO_API_KEY, 'saved-audio');
  assert.equal(loaded.FILMCRAFT_AUDIO_MODEL, 'audio-configured');
  const readiness = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', loaded).providers().audio;
  assert.deepEqual(readiness, { provider: 'openai', model: 'audio-configured', configured: true, keySource: 'settings' });
  const overridden = await loadProviderEnvironment({ ...env, FILMCRAFT_AUDIO_API_KEY: 'env-audio', FILMCRAFT_AUDIO_MODEL: 'env-model' });
  assert.equal(overridden.FILMCRAFT_AUDIO_API_KEY, 'env-audio'); assert.equal(overridden.FILMCRAFT_AUDIO_MODEL, 'env-model');
  assert.equal(overridden.FILMCRAFT_AUDIO_KEY_SOURCE, 'environment');
  await service.configure({ provider: 'audio', apiKey: '', persist: true });
  const fallback = new ChatService('http://127.0.0.1:9999', 'unused-private-token-123456789', await loadProviderEnvironment(env)).providers().audio;
  assert.equal(fallback.configured, true); assert.equal(fallback.keySource, 'openai');
  assert(!JSON.stringify(fallback).includes('saved-openai'));
});
