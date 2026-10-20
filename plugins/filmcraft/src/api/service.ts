import { PluginError, checkNumbers, resultData, textResult } from '../core.js';
import type { Backend, Params } from '../core.js';
import { availableTools, describeTool, tools } from '../tools/catalog.js';
import { analyzeAudio, audioConfig, requireAudio, wavResult } from '../chat/audio.js';
import { executePlan } from '../chat/plan.js';
import type { EditPlan } from '../chat/plan.js';

export class FilmcraftService {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private planActive = false;
  private attemptedPlans = new Set<string>();
  private chatOwner?: symbol;
  private configurationOwner?: symbol;
  private env: NodeJS.ProcessEnv;
  private providerFetch: typeof fetch;
  constructor(readonly backend: Backend, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.env = options.env ?? process.env; this.providerFetch = options.fetch ?? fetch;
  }
  configureRuntime(env: NodeJS.ProcessEnv, providerFetch: typeof fetch = fetch) { this.env = env; this.providerFetch = providerFetch; }
  get busy() { return this.planActive || !!this.chatOwner || !!this.configurationOwner || this.pending > 0; }
  beginChat() {
    if (this.busy) throw new PluginError('BUSY', 'Another editor operation is running. Wait for it before starting chat.', 409);
    this.chatOwner = Symbol('chat'); return this.chatOwner;
  }
  endChat(owner: symbol) { if (this.chatOwner === owner) this.chatOwner = undefined; }
  beginConfiguration() {
    if (this.busy) throw new PluginError('BUSY', 'Wait for the active operation before changing credentials', 409);
    this.configurationOwner = Symbol('configuration'); return this.configurationOwner;
  }
  endConfiguration(owner: symbol) { if (this.configurationOwner === owner) this.configurationOwner = undefined; }
  listTools() { return availableTools(this.backend.mode).map(describeTool); }

  async invoke(name: string, args: unknown, options: { signal?: AbortSignal; owner?: symbol } = {}) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new PluginError('UNKNOWN_TOOL', `Unknown tool ${name}`, 404);
    if (tool.bridgeOnly && this.backend.mode !== 'bridge') throw new PluginError('BRIDGE_REQUIRED', `${name} requires FILMCRAFT_MODE=bridge and a desktop control server`, 409);
    checkNumbers(args);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new PluginError('INVALID_ARGUMENTS', parsed.error.message, 400);
    const params = parsed.data as Params;
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    // Sidebar controls can synchronously call back into chat HTTP routes. Counting the initiating
    // Apply/Send click as an editor operation would reject its own callback and prevent Stop.
    // Only exact assistant IDs qualify: coordinates, fractions, modifiers and other overrides
    // stay in the normal editor queue and remain excluded while chat/configuration owns it.
    if (name === 'filmcraft_ui_control') {
      const control = params.params as Params;
      const keys = Object.keys(control);
      const inspect = params.method === 'chat.inspect' && keys.length === 0;
      const click = params.method === 'ui.click' && keys.length === 1 && keys[0] === 'id' &&
        typeof control.id === 'string' && /^chat\.[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/.test(control.id);
      if (inspect || click) return this.callNative(name, params);
    }
    const nativeId = tool.command ?? (name === 'filmcraft_execute' ? params.id : undefined);
    const jobControl = nativeId === 'jobs.list' || nativeId === 'jobs.cancel';
    if (!jobControl && (this.configurationOwner || this.planActive || (this.chatOwner && this.chatOwner !== options.owner))) throw new PluginError('BUSY', 'A settings update, chat or Jev plan owns the editor. Wait for completion or cancel that run first.', 409);
    if (name === 'filmcraft_execute_plan') {
      if (this.pending) throw new PluginError('BUSY', 'Wait for queued editor operations before executing a plan.', 409);
      if (!(this.env.TYPESAFE_API_KEY ?? this.env.JEV_API_KEY)) throw new PluginError('MISSING_JEV_KEY', 'Jev execution requires a Jev API key in Settings or TYPESAFE_API_KEY/JEV_API_KEY.', 400);
      const signature = JSON.stringify(params.plan);
      if (this.attemptedPlans.has(signature)) throw new PluginError('PLAN_REPLAY', 'This plan was already attempted. Inspect current state and create a revised plan; completed edits may remain.', 409);
      this.attemptedPlans.add(signature);
      while (this.attemptedPlans.size > 128) this.attemptedPlans.delete(this.attemptedPlans.values().next().value!);
      this.planActive = true;
      try {
        return await executePlan(params.plan as EditPlan, { config: { apiKey: this.env.TYPESAFE_API_KEY ?? this.env.JEV_API_KEY ?? '', model: this.env.JEV_MODEL ?? 'jev-latest' },
          fetch: this.providerFetch, signal, call: (name, args) => this.callNative(name, args) });
      } finally { this.planActive = false; }
    }
    const run = async () => {
      signal.throwIfAborted();
      if (name === 'filmcraft_audio_analyze') {
        const config = audioConfig(this.env); requireAudio(config);
        const { question, ...range } = params;
        const result = wavResult(await this.backend.call('command_run', { id: 'audio.read', params: range }));
        return analyzeAudio(result, config, String(question), signal, this.providerFetch);
      }
      const result = await this.callNative(name, params);
      return name === 'filmcraft_audio_read' ? wavResult(result) : result;
    };
    if (jobControl) return run();
    if (this.pending >= 128) throw new PluginError('BUSY', 'Request queue is full', 429);
    this.pending++;
    const result = this.queue.then(run);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  /** Plan orchestration already holds exclusive ownership. Calling the public queue here would deadlock. */
  private async callNative(name: string, params: Params) {
    const tool = tools.find(t => t.name === name)!;
    if (!tool || ['filmcraft_execute_plan', 'filmcraft_audio_analyze'].includes(name)) throw new PluginError('INVALID_PLAN_TOOL', 'Unavailable nested plan tool', 400);
    if (name === 'filmcraft_commands') {
      const { offset, limit, ...query } = params;
      const result = await this.backend.call('command_list', query);
      if (result.isError) return result;
      const commands = resultData(result);
      if (!Array.isArray(commands)) throw new PluginError('BACKEND_PROTOCOL', 'Expected an array from FilmCraft command_list', 502);
      return textResult({ total: commands.length, offset, commands: commands.slice(offset as number, (offset as number) + (limit as number)) });
    }
    return this.backend.call(tool.native ?? 'command_run', tool.command ? { id: tool.command, params } : params);
  }
}
