// Real desktop + MCP + engine. Provider replies are fixtures; no cloud credentials or charges.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDesktop, installCommands } from '../dist/chat/desktop.js';
import { repository } from '../dist/config.js';
import { resultData } from '../dist/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scratch = await mkdtemp(join(tmpdir(), 'filmcraft-chat-ui-'));
const providerConfig = join(scratch, 'providers.json');
await writeFile(providerConfig, '{}');
const out = join(repository, 'artifacts/chat');
await mkdir(out, { recursive: true });
const decision = (criteria, choice) => ({ type: 'choice', choice, confidence: 0.98, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === choice ? 1 : 0])) });
let action = 0;
let requests = 0;
const mock = async (url, options) => {
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true');
  const body = JSON.parse(options.body);
  assert(body.assets[body.state.image.frame]);
  requests++;
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    const selected = key === 'action' ? (action++ === 0 ? 'filmcraft_marker_add' : 'done') :
      key === 'seconds' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 1) :
      key === 'name' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'Jev UI test') : '__omit__';
    assert(Object.hasOwn(q.criteria, selected), key);
    answers[key] = decision(q.criteria, selected);
  }
  return Response.json({ model: 'jev-latest', answers });
};
const app = await launchDesktop({ env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', JEV_API_KEY: '', FILMCRAFT_PROVIDERS_CONFIG: providerConfig, FILMCRAFT_DATA_DIR: scratch, FILMCRAFT_PROJECT: join(repository, 'artifacts/demo/edit.fcproj') }, fetch: mock, controlInputOnly: true });
const call = async (name, args = {}) => {
  const result = await app.client.callTool(`filmcraft_${name}`, args);
  assert(!result.isError, JSON.stringify(result));
  return result;
};
const control = async (method, params = {}) => resultData(await call('ui_control', { method, params }));
const waitFor = async predicate => {
  for (let i = 0; i < 150; i++) { const state = await control('chat.inspect'); if (predicate(state)) return state; await delay(100); }
  throw new Error('UI state timed out: ' + JSON.stringify(await control('chat.inspect')));
};
const click = id => control('ui.click', { id });
const screenshot = async name => {
  const result = await call('ui_screenshot', { max_side: 1600 });
  const image = result.content.find(c => c.type === 'image');
  assert(image); await writeFile(join(out, name + '.png'), Buffer.from(image.data, 'base64'));
};
const select = async id => {
  await click('chat.provider');
  await click(`chat.provider.${id}`);
  await waitFor(s => s.provider === id);
};
try {
  await waitFor(s => s.status === 'Ready');
  await call('playhead_set', { seconds: 0.5 });
  await control('ui.set', { timeline: { fit: true } });
  await screenshot('chat-default');
  await click('chat.provider');
  const picker = resultData(await call('ui_elements', { prefix: 'chat.provider.' }));
  for (const id of ['claude', 'chatgpt', 'jev', 'codex', 'claude-code']) assert(JSON.stringify(picker).includes(`chat.provider.${id}`));
  await screenshot('provider-picker');
  await click('chat.provider.jev');
  await click('chat.settings');
  await click('chat.key');
  await control('ui.type', { text: 'fixture-only-not-a-real-api-key' });
  await screenshot('jev-settings');
  await click('chat.settings.apply');
  await waitFor(s => s.status === 'Settings saved for this session');
  await click('chat.settings');
  await click('chat.prompt');
  await control('ui.type', { text: 'Add a marker at 1 second named "Jev UI test".' });
  await click('chat.send');
  await waitFor(s => s.status === 'done' || s.status === 'error');
  const finished = await control('chat.inspect');
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.match(JSON.stringify(resultData(await call('sequence_inspect'))), /Jev UI test/);
  const external = new Client({ name: 'external-agent-install-test', version: '0.1.0' });
  try {
    await external.connect(new StdioClientTransport({ command: process.execPath, args: [join(repository, 'plugins/filmcraft/dist/cli.js'), 'desktop-mcp'], stderr: 'inherit' }));
    const shared = await external.callTool({ name: 'filmcraft_sequence_inspect', arguments: {} });
    assert.match(JSON.stringify(shared), /Jev UI test/, 'Installed external connector must share the sidebar project');
  } finally { await external.close(); }
  assert.equal(requests, 3);
  await screenshot('jev-tool-run');
  for (const theme of ['medium', 'light', 'dark']) {
    await control('ui.set', { theme });
    await screenshot(`chat-theme-${theme}`);
  }
  await control('ui.set', { theme: 'light' });
  await click('chat.settings');
  await screenshot('chat-settings-light');
  await click('chat.settings');
  await control('ui.set', { theme: 'dark' });
  await select('codex');
  await screenshot('codex-install');
  await click('chat.install.copy');
  await select('claude-code');
  await screenshot('claude-code-install');
  await select('chatgpt');
  await screenshot('chatgpt');
  await click('chat.close');
  await waitFor(s => !s.open);
  await click('chat.open');
  await waitFor(s => s.open);
  await writeFile(join(out, 'ui-report.json'), JSON.stringify({ providerResponses: 'deterministic fixtures, not live cloud inference', actualEngineEdit: 'Jev UI test marker at 1 second', requests, screenshotFiles: ['chat-default', 'provider-picker', 'jev-settings', 'jev-tool-run', 'chat-theme-dark', 'chat-theme-medium', 'chat-theme-light', 'chat-settings-light', 'codex-install', 'claude-code-install', 'chatgpt'], installCommands: installCommands() }, null, 2));
  console.log('Chat UI passed: five options, key settings, composer, Jev decision/image requests, real MCP edit, install copy, collapse/restore, screenshots. Cloud inference was stubbed.');
} finally {
  await app.close();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
