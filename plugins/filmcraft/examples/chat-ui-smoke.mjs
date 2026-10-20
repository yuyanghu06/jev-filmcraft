// Real desktop + MCP + engine. Provider replies are fixtures; no cloud credentials or charges.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDesktop, installCommands } from '../dist/chat/desktop.js';
import { repository } from '../dist/config.js';
import { resultData } from '../dist/core.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scratch = await mkdtemp(join(tmpdir(), 'filmcraft-chat-ui-'));
const { values: options } = parseArgs({ options: { out: { type: 'string' }, project: { type: 'string' } } });
const providerConfig = join(scratch, 'providers.json');
await writeFile(providerConfig, '{}');
const out = options.out || process.env.FILMCRAFT_UI_OUTPUT_DIR
  ? resolve(options.out || process.env.FILMCRAFT_UI_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), 'filmcraft-chat-ui-output-'));
await mkdir(out, { recursive: true });
// User-supplied fixtures are copied before opening. No existing desktop session or demo is edited.
const sourceProject = options.project || process.env.FILMCRAFT_UI_PROJECT;
const project = sourceProject ? join(scratch, 'fixture.fcproj') : undefined;
if (sourceProject) await copyFile(resolve(sourceProject), project);
const smokeEnv = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', JEV_API_KEY: '', FILMCRAFT_AUDIO_API_KEY: '', FILMCRAFT_PROVIDERS_CONFIG: providerConfig, FILMCRAFT_STATE_DIR: scratch, FILMCRAFT_DATA_DIR: scratch, FILMCRAFT_PROJECT: project };
const decision = (criteria, choice) => ({ type: 'choice', choice, confidence: 0.98, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === choice ? 1 : 0])) });
let action = 0;
let requests = 0;
const mock = async (url, options) => {
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true');
  const body = JSON.parse(options.body);
  if (body.questions.action) assert(body.assets[body.state.image.frame]);
  else assert.equal(body.assets, undefined);
  requests++;
  const answers = {};
  for (const [key, q] of Object.entries(body.questions)) {
    const selected = key === 'progress' ? 'done' : key === 'action' ? (action++ === 0 ? 'filmcraft_marker_add' : 'done') :
      key === 'target' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'program') :
      key.startsWith('present.') ? (['present.seconds', 'present.name'].includes(key) ? 'include' : 'omit') :
      key === 'seconds' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 1) :
      key === 'name' ? Object.keys(q.criteria).find(k => q.criteria[k]?.value === 'Jev UI test') : '__omit__';
    assert(Object.hasOwn(q.criteria, selected), key);
    answers[key] = decision(q.criteria, selected);
  }
  return Response.json({ model: 'jev-latest', answers });
};
const app = await launchDesktop({ env: smokeEnv, fetch: mock, controlInputOnly: true });
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
  if (!project) await call('execute', { id: 'file.openDemoProject', params: {} });
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
  await click('chat.settings.debug');
  await screenshot('jev-settings');
  await click('chat.settings.apply');
  await waitFor(s => s.status === 'Settings saved for this session');
  await click('chat.settings');
  await click('chat.prompt');
  await control('ui.type', { text: 'Add a marker at 1 second named "Jev UI test".\nKeep all existing clips unchanged.\nUse a point marker.\nUse the default color.\nKeep the default target.\nVerify the marker after creating it.\nDo not change any audio gain, clip durations, or track settings.' });
  const composer = resultData(await call('ui_elements', { prefix: 'chat.' }));
  const send = composer.find(e => e.id === 'chat.send');
  const window = (await control('ui.inspect')).window;
  assert(send && send.rect[1] + send.rect[3] < window[1], 'Long prompts must keep Send inside the window');
  await click('chat.send');
  await waitFor(s => s.status === 'done' || s.status === 'error');
  const finished = await control('chat.inspect');
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.equal(finished.debugLogging, true);
  assert(finished.debugPath);
  assert.equal(finished.debugError, '');
  const debugLog = await readFile(finished.debugPath, 'utf8');
  const trace = debugLog.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(trace.filter(e => e.event === 'provider.response').length, 4);
  assert(trace.some(e => e.event === 'jev.decision' && e.data.accepted));
  assert(!debugLog.includes('fixture-only-not-a-real-api-key'));
  await click('chat.debug.copy');
  assert.match(JSON.stringify(resultData(await call('sequence_inspect'))), /Jev UI test/);
  const external = new Client({ name: 'external-agent-install-test', version: '0.1.0' });
  try {
    await external.connect(new StdioClientTransport({ command: process.execPath, args: [join(repository, 'plugins/filmcraft/dist/cli.js'), 'desktop-mcp'], env: Object.fromEntries(Object.entries(smokeEnv).filter(([, value]) => value !== undefined)), stderr: 'inherit' }));
    const shared = await external.callTool({ name: 'filmcraft_sequence_inspect', arguments: {} });
    assert.match(JSON.stringify(shared), /Jev UI test/, 'Installed external connector must share the sidebar project');
  } finally { await external.close(); }
  assert.equal(requests, 4);
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
  assert.equal((await control('chat.inspect')).audio.configured, false);
  await click('chat.execution');
  await click('chat.execution.jev');
  await waitFor(s => s.execution === 'jev');
  await screenshot('chatgpt-jev-executor');
  await click('chat.execution');
  await click('chat.execution.direct');
  await waitFor(s => s.execution === 'direct');
  await screenshot('chatgpt');
  await click('chat.settings');
  await control('ui.scroll', { id: 'chat.model', dy: -500 });
  await delay(200);
  await click('chat.audio.key');
  await control('ui.type', { text: 'audio-fixture-only-not-a-real-api-key' });
  await screenshot('audio-helper-settings');
  await click('chat.audio.apply');
  await waitFor(s => s.audio.configured === true);
  assert.equal((await control('chat.inspect')).audio.provider, 'openai');
  await click('chat.settings');
  await click('chat.close');
  await waitFor(s => !s.open);
  await click('chat.open');
  await waitFor(s => s.open);
  await writeFile(join(out, 'ui-report.json'), JSON.stringify({ providerResponses: 'deterministic fixtures, not live cloud inference', actualEngineEdit: 'Jev UI test marker at 1 second', requests, screenshotFiles: ['chat-default', 'provider-picker', 'jev-settings', 'jev-tool-run', 'chat-theme-dark', 'chat-theme-medium', 'chat-theme-light', 'chat-settings-light', 'codex-install', 'claude-code-install', 'chatgpt', 'chatgpt-jev-executor', 'audio-helper-settings'], installCommands: installCommands(smokeEnv) }, null, 2));
  console.log(`Chat UI passed: five options, executor selection, key settings, composer, Jev decision/image requests, real MCP edit, install copy, collapse/restore. Cloud inference was stubbed. Output: ${out}`);
} finally {
  await app.close();
  await delay(500);
  await rm(scratch, { recursive: true, force: true });
}
