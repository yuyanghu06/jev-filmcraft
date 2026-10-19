import { PluginError, checkNumbers, resultData, textResult } from '../core.js';
import type { Backend, Params } from '../core.js';
import { availableTools, describeTool, tools } from '../tools/catalog.js';

export class FilmcraftService {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(readonly backend: Backend) {}

  listTools() { return availableTools(this.backend.mode).map(describeTool); }

  async invoke(name: string, args: unknown) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new PluginError('UNKNOWN_TOOL', `Unknown tool ${name}`, 404);
    if (tool.bridgeOnly && this.backend.mode !== 'bridge') throw new PluginError('BRIDGE_REQUIRED', `${name} requires FILMCRAFT_MODE=bridge and a desktop control server`, 409);
    checkNumbers(args);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) throw new PluginError('INVALID_ARGUMENTS', parsed.error.message, 400);
    const params = parsed.data as Params;
    const run = async () => {
      if (name === 'filmcraft_commands') {
        const { offset, limit, ...query } = params;
        const result = await this.backend.call('command_list', query);
        if (result.isError) return result;
        const commands = resultData(result);
        if (!Array.isArray(commands)) throw new PluginError('BACKEND_PROTOCOL', 'Expected an array from FilmCraft command_list', 502);
        return textResult({ total: commands.length, offset, commands: commands.slice(offset as number, (offset as number) + (limit as number)) });
      }
      return this.backend.call(tool.native ?? 'command_run', tool.command ? { id: tool.command, params } : params);
    };
    // Jobs remain queryable/cancellable even while an explicit wait:true export is running.
    const nativeId = tool.command ?? (name === 'filmcraft_execute' ? params.id : undefined);
    if (nativeId === 'jobs.list' || nativeId === 'jobs.cancel') return run();
    // No interleaving batches or bridge previews (which temporarily seek the desktop playhead).
    if (this.pending >= 128) throw new PluginError('BUSY', 'Request queue is full', 429);
    this.pending++;
    const result = this.queue.then(run);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
}
