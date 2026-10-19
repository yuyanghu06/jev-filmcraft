import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PluginError, errorMessage } from '../core.js';
import type { Params } from '../core.js';

/** HTTP is the sole dependency of the Jev-facing MCP layer. */
export class FilmcraftApiClient {
  constructor(readonly url: string, private token: string, private timeoutMs = 130_000) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) throw new PluginError('CONFIG', 'Use a plain HTTP(S) API URL with no credentials/query/fragment', 400);
    if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new PluginError('CONFIG', 'Remote API URLs require HTTPS; use an SSH tunnel for this local API', 400);
    if (token.length < 24) throw new PluginError('CONFIG', 'An API token of at least 24 characters is required', 400);
  }

  private async request(route: string, args?: Params): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url.replace(/\/$/, '')}${route}`, {
        method: args ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.token}`, ...(args ? { 'Content-Type': 'application/json' } : {}) },
        body: args ? JSON.stringify(args) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new PluginError('API_UNAVAILABLE', `${errorMessage(error)}. The command may have executed; inspect the document/jobs before retrying.`, 503);
    }
    const data = await response.json() as { error?: { code: string; message: string }; result?: unknown };
    if (!response.ok && !(response.status === 422 && data.result)) {
      throw new PluginError(data.error?.code ?? 'HTTP_ERROR', data.error?.message ?? `HTTP ${response.status}`, response.status);
    }
    return data;
  }

  async health() { return this.request('/v1/health') as Promise<{ connected: boolean; mode: 'headless' | 'bridge'; version: string }>; }
  async listTools() { return ListToolsResultSchema.parse(await this.request('/v1/tools')).tools; }
  async callTool(name: string, args: Params = {}) {
    const data = await this.request(`/v1/tools/${encodeURIComponent(name)}`, args) as { result: unknown };
    return CallToolResultSchema.parse(data.result);
  }
}
