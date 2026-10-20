import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { PluginError, errorMessage } from '../core.js';
import { runClaude, runChatgpt, toolText } from './providers.js';
import type { ProviderId, ProviderConfig, Turn } from './providers.js';
import { runJev } from './jev.js';
import { saveProviderConfig } from './config.js';
import { DebugTrace, debugDirectory } from './debug.js';
import type { DebugInfo } from './debug.js';

const provider = z.enum(['claude', 'chatgpt', 'jev']);
const startSchema = z.strictObject({ provider, session: z.string().uuid().optional(), message: z.string().trim().min(1).max(16000) });
const configSchema = z.strictObject({ provider, apiKey: z.string().trim().max(4096).refine(value => !/[\r\n]/.test(value)).optional(), model: z.string().trim().min(1).max(200).optional(), persist: z.boolean().optional(), debugLogging: z.boolean().optional() });
type Event = { kind: 'user' | 'assistant' | 'tool' | 'result' | 'error'; text: string };
interface Run { id: string; session: string; provider: ProviderId; status: 'running' | 'done' | 'error' | 'stopping' | 'stopped'; events: Event[]; debug?: DebugInfo }
interface Session { provider: ProviderId; turns: Turn[] }

export class ChatService {
  private configs: Record<ProviderId, ProviderConfig>;
  private sessions = new Map<string, Session>();
  private runs = new Map<string, Run>();
  private active?: { abort: AbortController; task: Promise<void>; run: Run };
  private configuring = false;
  constructor(private url: string, private token: string, private env = process.env, private providerFetch: typeof fetch = fetch) {
    this.configs = {
      claude: { apiKey: env.ANTHROPIC_API_KEY ?? '', model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6', debugLogging: env.ANTHROPIC_DEBUG_LOGGING === '1' },
      chatgpt: { apiKey: env.OPENAI_API_KEY ?? '', model: env.OPENAI_MODEL ?? 'gpt-5.4', debugLogging: env.OPENAI_DEBUG_LOGGING === '1' },
      jev: { apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? '', model: env.JEV_MODEL ?? 'jev-latest', debugLogging: env.JEV_DEBUG_LOGGING === '1' },
    };
  }
  providers() {
    return { providers: Object.entries(this.configs).map(([id, config]) => ({ id, model: config.model, configured: !!config.apiKey, experimental: id === 'jev', debugLogging: !!config.debugLogging })), experimentalJevHeader: 'TypeSafe-Danger-Zone-Images: true' };
  }
  async configure(input: unknown) {
    const parsed = configSchema.safeParse(input);
    if (!parsed.success) throw new PluginError('INVALID_ARGUMENTS', 'Expected provider and optional apiKey/model/debugLogging', 400);
    if (this.active || this.configuring) throw new PluginError('BUSY', 'Wait for the active operation before changing credentials', 409);
    const { provider, persist, ...patch } = parsed.data;
    this.configuring = true;
    try {
      if (persist) await saveProviderConfig(provider, patch, this.env);
      Object.assign(this.configs[provider], patch);
      return { ...this.providers(), saved: !!persist };
    } finally { this.configuring = false; }
  }
  start(input: unknown) {
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) throw new PluginError('INVALID_ARGUMENTS', 'Expected provider, message (1–16000 characters), and optional session UUID', 400);
    if (this.active || this.configuring) throw new PluginError('BUSY', 'Another operation is running. Stop or wait for it first.', 409);
    const { provider, message } = parsed.data;
    const config = { ...this.configs[provider] };
    if (!config.apiKey) throw new PluginError('MISSING_KEY', `Add an API key for ${provider} in chat Settings`, 400);
    const sessionId = parsed.data.session ?? randomUUID();
    const session = this.sessions.get(sessionId) ?? { provider, turns: [] };
    if (session.provider !== provider) throw new PluginError('PROVIDER_MISMATCH', 'Start a new chat when switching provider', 400);
    if (session.turns.reduce((n, t) => n + t.text.length, 0) > 100_000) throw new PluginError('CONTEXT_LIMIT', 'Start a new chat; this conversation reached its context limit', 400);
    session.turns.push({ role: 'user', text: message });
    this.sessions.set(sessionId, session);
    while (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value!);
    const run: Run = { id: randomUUID(), session: sessionId, provider, status: 'running', events: [{ kind: 'user', text: message }] };
    this.runs.set(run.id, run);
    while (this.runs.size > 40) this.runs.delete(this.runs.keys().next().value!);
    const abort = new AbortController();
    const task = this.execute(run, session, config, abort.signal).finally(() => { this.active = undefined; });
    this.active = { abort, task, run };
    return run;
  }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new PluginError('NOT_FOUND', 'Chat run not found', 404);
    return run;
  }
  cancel(id: string) {
    const run = this.get(id);
    if (this.active?.run.id === id) {
      run.status = 'stopping';
      this.active.abort.abort();
    }
    return run;
  }
  async close() { this.active?.abort.abort(); await this.active?.task; }
  private async execute(run: Run, session: Session, config: ProviderConfig, signal: AbortSignal) {
    const client = new Client({ name: 'filmcraft-chat', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${this.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } });
    const trace = config.debugLogging ? new DebugTrace(debugDirectory(this.env), [this.token, ...Object.values(this.configs).map(c => c.apiKey)]) : undefined;
    if (trace) {
      run.debug = trace.info;
      await trace.start(run.id);
      await trace.write('run.start', { runId: run.id, session: run.session, provider: run.provider, model: config.model, turns: session.turns });
    }
    let count = 0;
    let status: Run['status'] = 'error';
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      // Chat never controls its own credentials, composer or run lifecycle through UI automation.
      const permitted = tools.filter(t => !['filmcraft_ui_control', 'filmcraft_ui_elements', 'filmcraft_ui_inspect'].includes(t.name));
      const emit = (kind: Event['kind'], text: string) => { run.events.push({ kind, text: text.slice(0, 6000) }); };
      const runner = { claude: runClaude, chatgpt: runChatgpt, jev: runJev }[run.provider];
      await runner({ config, turns: session.turns, tools: permitted, signal, fetch: this.providerFetch, trace: trace?.write,
        say: text => emit('assistant', text),
        call: async (name, args) => {
          signal.throwIfAborted();
          if (++count > 40) throw new Error('Stopped at the 40-tool limit. Review the project before continuing.');
          if (!permitted.some(t => t.name === name)) throw new Error(`Unavailable tool: ${name}`);
          emit('tool', `${name}\n${JSON.stringify(args)}`);
          const started = Date.now();
          await trace?.write('tool.call', { name, args });
          try {
            const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 130_000 });
            // Avoid including base64 in the transcript. Preserve complete results for the provider.
            const validated = (await import('@modelcontextprotocol/sdk/types.js')).CallToolResultSchema.parse(result);
            emit('result', toolText(validated));
            await trace?.write('tool.result', { name, elapsedMs: Date.now() - started, result: validated });
            return validated;
          } catch (error) {
            await trace?.write('tool.error', { name, elapsedMs: Date.now() - started, message: errorMessage(error) });
            throw error;
          }
        },
      });
      signal.throwIfAborted();
      status = 'done';
    } catch (error) {
      status = signal.aborted ? 'stopped' : 'error';
      const message = signal.aborted ? 'Stopped. Already completed edits remain; use Undo to revert. An in-flight tool or export may finish.' : errorMessage(error);
      // Tool/provider errors must not reveal configured credentials.
      run.events.push({ kind: 'error', text: config.apiKey ? message.replaceAll(config.apiKey, '[redacted]') : message });
    } finally {
      await trace?.write('run.finish', { status, toolCalls: count, events: run.events });
      await trace?.close();
      session.turns.push({ role: 'assistant', text: run.events.filter(e => e.kind !== 'user').map(e => `${e.kind}: ${e.text}`).join('\n').slice(-24000) || 'No response.' });
      await client.close().catch(() => {});
      run.status = status;
    }
  }
}
