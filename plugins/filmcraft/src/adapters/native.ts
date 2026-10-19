import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PluginError, errorMessage } from '../core.js';
import type { Backend, Mode, Params } from '../core.js';

export interface NativeOptions {
  binary: string;
  mode: Mode;
  bridge?: string;
  project?: string;
  demo?: boolean;
  dataDir?: string;
  timeoutMs?: number;
}

/** The only module coupled to FilmCraft's native transport. One child = one persistent session. */
export class NativeBackend implements Backend {
  readonly mode: Mode;
  connected = false;
  private client = new Client({ name: 'jev-filmcraft-api', version: '0.1.0' });
  private transport: StdioClientTransport;
  private constructor(private options: NativeOptions) {
    this.mode = options.mode;
    if (options.mode === 'bridge' && (options.project || options.demo || options.dataDir)) {
      throw new PluginError('CONFIG', 'Bridge mode uses the desktop session; remove project/demo/dataDir options', 400);
    }
    if (options.demo && options.project) throw new PluginError('CONFIG', 'Choose project or demo, not both', 400);
    const args = ['mcp'];
    if (options.mode === 'bridge') args.push('--bridge', options.bridge ?? '127.0.0.1:9876');
    else {
      if (options.project) args.push('--project', options.project);
      if (options.demo) args.push('--demo');
      if (options.dataDir) args.push('--data-dir', options.dataDir);
    }
    this.transport = new StdioClientTransport({ command: options.binary, args, stderr: 'inherit' });
    this.client.onclose = () => { this.connected = false; };
    this.client.onerror = error => process.stderr.write(`[filmcraft backend] ${error.message}\n`);
  }

  static async connect(options: NativeOptions): Promise<NativeBackend> {
    const backend = new NativeBackend(options);
    try {
      await backend.client.connect(backend.transport, { timeout: options.timeoutMs ?? 120_000 });
      backend.connected = true;
      // Bridge mode must actually contact the desktop, not just initialize its CLI proxy.
      const probe = await backend.call('command_list', { filter: 'project.inspect' });
      if (probe.isError) throw new Error(JSON.stringify(probe.content));
      return backend;
    } catch (error) {
      await backend.close();
      throw new PluginError('BACKEND_UNAVAILABLE', `Cannot start FilmCraft: ${errorMessage(error)}. Build filmcraft-cli or set FILMCRAFT_BIN; bridge mode also needs the desktop --control port.`, 503);
    }
  }

  async call(tool: string, args: Params) {
    if (!this.connected) throw new PluginError('BACKEND_UNAVAILABLE', 'FilmCraft disconnected. The session is not automatically restarted; reopen your saved project explicitly.', 503);
    try {
      const result = await this.client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
        timeout: this.options.timeoutMs ?? 120_000,
      });
      return CallToolResultSchema.parse(result);
    } catch (error) {
      throw new PluginError('BACKEND_REQUEST_FAILED', `${errorMessage(error)}. The command may have executed; inspect the document/jobs before retrying.`, 502);
    }
  }

  async close() {
    this.connected = false;
    await this.client.close();
  }
}
