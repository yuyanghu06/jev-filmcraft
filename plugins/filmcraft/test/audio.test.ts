import test from 'node:test';
import assert from 'node:assert/strict';
import { FilmcraftService } from '../src/api/service.js';
import { audioReadSchema, audioAnalyzeSchema, audioReadiness, wavResult, analyzeAudio } from '../src/chat/audio.js';
import { runClaude, runChatgpt, toolText } from '../src/chat/providers.js';
import { debugRedactor } from '../src/chat/debug.js';
import { resultData, textResult } from '../src/core.js';
import type { AgentContext } from '../src/chat/providers.js';
import type { Backend } from '../src/core.js';

const key = 'private-audio-fixture-key';
function pcm(extra: Record<string, unknown> = {}) {
  return textResult({ encoding: 'base64', mimeType: 'audio/pcm', format: 'pcm_s16le', data: Buffer.from([0, 0, 255, 127, 0, 128]).toString('base64'), sampleRate: 16000, channels: 1, frameCount: 3,
    sequence: { id: 10, name: 'Spoken interview' }, requestedRange: { startSeconds: 2, durationSeconds: 1, endSeconds: 3 }, actualRange: { startSeconds: 2, durationSeconds: 3 / 16000, endSeconds: 2 + 3 / 16000 }, track: { id: 3, label: 'A1', name: 'Interview' }, signalPath: 'track_input_pre_mixer', offlineMedia: [], ...extra });
}
const sourceMetadata = { sequence: undefined, track: undefined, source: { item: 31, name: 'Imported interview', durationSeconds: 12 },
  audioStream: { index: 1, sampleRate: 48000, channels: 2, codec: 'pcm' }, availableAudioStreams: [{ index: 0 }, { index: 1 }],
  timeBasis: 'source', signalPath: 'source_original', mediaStatus: { original: 'online', proxyUsed: false } };

test('imported audio selectors reject ambiguous or invalid requests for both read and analyze', () => {
  for (const schema of [audioReadSchema, audioAnalyzeSchema]) {
    assert.equal(schema.parse({ item: 31, audioStream: 1, startSeconds: 2, durationSeconds: 1 }).audioStream, 1);
    assert.equal(schema.parse({ item: 31, startSeconds: 2, durationSeconds: 1 }).sampleRate, 16000);
    for (const selector of [{ item: 31, track: 'A1' }, { audioStream: 0 }, { item: 0 }, { item: 1.5 }, { item: '31' }, { item: 31, audioStream: -1 }, { item: 31, audioStream: 0.5 }]) {
      assert.equal(schema.safeParse({ ...selector, startSeconds: 2, durationSeconds: 1 }).success, false, JSON.stringify(selector));
    }
  }
});

test('source helper hears exact WAV and attributes excerpt and absolute source offsets without timeline claims', async () => {
  const wav = wavResult(pcm(sourceMetadata));
  const audio = wav.content.find(c => c.type === 'audio')!;
  const result = await analyzeAudio(wav, { apiKey: key, model: 'source-helper' }, 'Find a sentence ending', new AbortController().signal, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.match(body.messages[0].content, /absolute source-media seconds/);
    assert.match(body.messages[0].content, /not timeline positions/);
    assert(!body.messages[0].content.includes('absolute timeline'));
    const text = body.messages[1].content[0].text;
    assert.match(text, /"item":31/); assert.match(text, /"index":1/); assert.match(text, /"startSeconds":2/);
    assert.equal(body.messages[1].content[1].input_audio.data, (audio as any).data);
    return Response.json({ choices: [{ message: { content: 'Imported item 31, stream 1: excerpt +0.5 s, absolute source 2.5 s. Moderate confidence.' } }] });
  });
  const data = resultData(result) as any;
  assert.equal(data.source, 'audio-model');
  assert.equal(data.metadata.source.item, 31); assert.equal(data.metadata.audioStream.index, 1);
  assert.equal(data.metadata.timeBasis, 'source'); assert.equal(data.metadata.actualRange.startSeconds, 2);
  assert.match(data.observation, /absolute source 2.5/);
});

test('native PCM becomes a valid RIFF PCM16 WAV with exact samples and provenance, while transcript excludes binary', () => {
  const result = wavResult(pcm());
  const audio = result.content.find(c => c.type === 'audio')!;
  assert.equal(audio.type, 'audio');
  const bytes = Buffer.from((audio as any).data, 'base64');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8); assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000); assert.equal(bytes.readUInt16LE(34), 16); assert.equal(bytes.readUInt32LE(40), 6);
  assert.deepEqual([...bytes.subarray(44)], [0, 0, 255, 127, 0, 128]);
  assert.equal((resultData(result) as any).track.label, 'A1');
  assert.equal((resultData(result) as any).signalPath, 'track_input_pre_mixer');
  assert(!toolText(result).includes((audio as any).data));
  for (const extra of [{ frameCount: 4 }, { sampleRate: 44100 }, { channels: 2 }, { data: 'not base64!' }, { frameCount: 16000 * 31 }]) assert.throws(() => wavResult(pcm(extra)), /PCM/);
});

test('audio analyzer sends actual WAV to fixed Chat Completions endpoint and returns attributed text without binary', async () => {
  let calls = 0;
  const result = await analyzeAudio(wavResult(pcm()), { apiKey: key, model: 'fixture-audio-model' }, 'Find the first sentence end', new AbortController().signal, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal((options?.headers as any).Authorization, `Bearer ${key}`);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'fixture-audio-model'); assert.deepEqual(body.modalities, ['text']); assert.equal(body.store, false);
    assert.match(body.messages[0].content, /untrusted/);
    const input = body.messages[1].content.find((c: any) => c.type === 'input_audio').input_audio;
    assert.equal(input.format, 'wav'); assert.equal(Buffer.from(input.data, 'base64').toString('ascii', 0, 4), 'RIFF');
    assert.match(body.messages[1].content[0].text, /startSeconds/);
    return Response.json({ choices: [{ message: { content: 'Speech ends at excerpt +0.5 seconds, absolute 2.5 seconds; moderate confidence.' } }] });
  });
  assert.equal(calls, 1);
  const data = resultData(result) as any;
  assert.equal(data.source, 'audio-model'); assert.equal(data.model, 'fixture-audio-model'); assert.equal(data.metadata.actualRange.startSeconds, 2);
  assert.match(data.observation, /2.5 seconds/);
  assert(!JSON.stringify(result).includes(key)); assert(!result.content.some(c => c.type === 'audio'));
});

test('audio helper refuses missing credentials before native read, rejects offline audio, and validates request bounds', async () => {
  let reads = 0;
  const backend: Backend = { mode: 'headless', connected: true, close: async () => {}, call: async () => { reads++; return pcm(); } };
  const service = new FilmcraftService(backend, { env: {} });
  await assert.rejects(service.invoke('filmcraft_audio_analyze', { startSeconds: 0, durationSeconds: 1 }), (e: any) => e.code === 'MISSING_AUDIO_KEY');
  assert.equal(reads, 0);
  for (const args of [{ startSeconds: -1, durationSeconds: 1 }, { startSeconds: 0, durationSeconds: 31 }, { startSeconds: 0, durationSeconds: 0 }, { startSeconds: 0, durationSeconds: 1, track: 'V1' }]) await assert.rejects(service.invoke('filmcraft_audio_read', args), (e: any) => e.code === 'INVALID_ARGUMENTS');
  assert.equal(reads, 0);
  await assert.rejects(analyzeAudio(wavResult(pcm({ offlineMedia: [{ item: 8, name: 'Missing audio' }] })), { apiKey: key, model: 'audio' }, 'Describe', new AbortController().signal, async () => { throw new Error('must not contact provider'); }), (e: any) => e.code === 'OFFLINE_MEDIA');
});

for (const sourceTime of [false, true]) for (const provider of ['claude', 'chatgpt'] as const) test(`${provider} adapts ${sourceTime ? 'imported source' : 'timeline'} actual audio to attributed helper observations and preserves visual inputs`, async () => {
  let round = 0;
  let audioRequests = 0;
  const waveform = wavResult(pcm(sourceTime ? sourceMetadata : {}));
  waveform.content.push({ type: 'image', mimeType: 'image/png', data: 'iVBORfixture' });
  const ctx: AgentContext = { config: { apiKey: 'planner-key', model: 'planner' }, turns: [{ role: 'user', text: 'Listen to the interview and locate a cut.' }], tools: [], signal: new AbortController().signal,
    say: () => {}, call: async () => waveform,
    audioObservation: result => analyzeAudio(result, { apiKey: key, model: 'audio-helper' }, 'Transcribe', new AbortController().signal, async () => { audioRequests++; return Response.json({ choices: [{ message: { content: 'A sentence ends at +0.5 seconds.' } }] }); }),
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert(!String(options?.body).includes('input_audio'));
      if (round++ === 0) return provider === 'claude'
        ? Response.json({ content: [{ type: 'tool_use', id: 'read', name: 'filmcraft_audio_read', input: { startSeconds: 2, durationSeconds: 1 } }] })
        : Response.json({ output: [{ type: 'function_call', call_id: 'read', name: 'filmcraft_audio_read', arguments: '{"startSeconds":2,"durationSeconds":1}' }] });
      assert.match(JSON.stringify(body), /iVBORfixture/);
      if (sourceTime) {
        const envelopeText = provider === 'claude'
          ? body.messages.at(-1).content.find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'read').content.find((block: any) => block.type === 'text').text
          : body.input.find((block: any) => block.type === 'function_call_output' && block.call_id === 'read').output;
        const envelope = JSON.parse(envelopeText);
        const observation = JSON.parse(envelope.content.find((block: any) => block.type === 'text').text);
        assert.equal(observation.source, 'audio-model'); assert.equal(observation.model, 'audio-helper');
        assert.equal(observation.metadata.source.item, 31); assert.equal(observation.metadata.source.name, 'Imported interview');
        assert.equal(observation.metadata.audioStream.index, 1); assert.equal(observation.metadata.timeBasis, 'source');
        assert.equal(observation.metadata.signalPath, 'source_original');
        assert.deepEqual(observation.metadata.availableAudioStreams, sourceMetadata.availableAudioStreams);
        assert.deepEqual(observation.metadata.actualRange, (resultData(waveform) as any).actualRange);
      }
      assert.match(JSON.stringify(body), /audio-model/); assert.match(JSON.stringify(body), /audio-helper/); assert.match(JSON.stringify(body), /sentence ends/);
      assert(!JSON.stringify(body).includes((waveform.content[1] as any).data));
      return provider === 'claude' ? Response.json({ content: [{ type: 'text', text: 'The audio model found a boundary.' }] }) : Response.json({ output: [] });
    } };
  await (provider === 'claude' ? runClaude : runChatgpt)(ctx);
  assert.equal(audioRequests, 1);
});

test('audio readiness uses explicit helper settings before OpenAI fallback and debug redacts both WAV and raw PCM encodings', () => {
  assert.deepEqual(audioReadiness({}), { provider: 'openai', model: 'gpt-audio-1.5', configured: false, keySource: 'none' });
  assert.equal(audioReadiness({ OPENAI_API_KEY: key }).keySource, 'openai');
  assert.deepEqual(audioReadiness({ OPENAI_API_KEY: 'fallback', FILMCRAFT_AUDIO_API_KEY: key, FILMCRAFT_AUDIO_MODEL: 'configured', FILMCRAFT_AUDIO_KEY_SOURCE: 'settings' }), { provider: 'openai', model: 'configured', configured: true, keySource: 'settings' });
  const binary = 'private-binary-content';
  const log = JSON.stringify(debugRedactor([key])({ request: { input_audio: { format: 'wav', data: binary } }, response: pcm({ data: binary }), tool: { type: 'audio', data: binary }, apiKey: key }));
  assert(!log.includes(binary)); assert(!log.includes(key)); assert(log.includes('[media omitted]'));
});


test('audio provider transport failures never echo the helper credential through external tools', async () => {
  await assert.rejects(analyzeAudio(wavResult(pcm()), { apiKey: key, model: 'audio' }, 'Listen', new AbortController().signal, async () => { throw new Error(`request failed ${key}`); }), (error: Error) => {
    assert.match(error.message, /Audio model request failed/); assert(!error.message.includes(key)); return true;
  });
});
