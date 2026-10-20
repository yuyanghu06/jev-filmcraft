import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PluginError, errorMessage } from '../core.js';
import { FilmcraftService } from './service.js';
import { openapi } from './openapi.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server.js';
import { FilmcraftApiClient } from './client.js';
import { ChatService } from '../chat/service.js';

const MAX_BODY = 4 * 1024 * 1024;
function respond(res: ServerResponse, status: number, body: unknown) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(encoded);
}

async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new PluginError('CONTENT_TYPE', 'Use Content-Type: application/json', 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PluginError('BODY_TOO_LARGE', 'Body exceeds 4 MiB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PluginError('INVALID_JSON', 'Body must contain valid JSON', 400); }
}

export async function startApi(service: FilmcraftService, options: { token: string; port?: number; chat?: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; installs?: Record<string, string> } }) {
  if (options.token.length < 24) throw new PluginError('CONFIG', 'FILMCRAFT_API_TOKEN must be at least 24 characters', 400);
  const expected = Buffer.from(`Bearer ${options.token}`);
  let apiUrl = '';
  let chat: ChatService | undefined;
  const mcpRequests = new Map<string, Set<AbortController>>();
  const mcpClosers = new Set<() => Promise<void>>();
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    req.once('aborted', () => abort.abort());
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      // No browser-origin requests, CORS, or wildcard binding: these tools have local file access.
      if (req.headers.origin) throw new PluginError('ORIGIN_FORBIDDEN', 'Browser-origin requests are not supported', 403);
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) throw new PluginError('HOST_FORBIDDEN', 'Use the 127.0.0.1 API address', 403);
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) throw new PluginError('UNAUTHORIZED', 'A valid bearer token is required', 401);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname;
      if (route.startsWith('/v1/chat/')) {
        if (!chat) throw new PluginError('CHAT_DISABLED', 'Start the desktop chat launcher to enable chat', 404);
        if (req.method === 'GET' && route === '/v1/chat/providers') return respond(res, 200, { ...chat.providers(), installs: options.chat?.installs ?? {} });
        if (req.method === 'POST' && route === '/v1/chat/config') return respond(res, 200, await chat.configure(await body(req)));
        if (req.method === 'POST' && route === '/v1/chat/runs') return respond(res, 202, chat.start(await body(req)));
        const match = route.match(/^\/v1\/chat\/runs\/([a-f0-9-]+)(\/cancel)?$/);
        if (match && req.method === 'GET' && !match[2]) return respond(res, 200, chat.get(match[1]!));
        if (match && req.method === 'POST' && match[2]) return respond(res, 200, chat.cancel(match[1]!));
        throw new PluginError('NOT_FOUND', 'Unknown chat endpoint', 404);
      }
      if (route === '/mcp') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Stateless Streamable HTTP uses POST; SSE and DELETE sessions are not supported' } });
        }
        if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new PluginError('BODY_TOO_LARGE', 'Body exceeds 4 MiB', 413);
        const message = await body(req);
        // Stateless MCP notifications use a separate POST; bridge cancellation to the original request.
        if (message?.method === 'notifications/cancelled' && ['number', 'string'].includes(typeof message.params?.requestId)) {
          for (const active of mcpRequests.get(JSON.stringify(message.params.requestId)) ?? []) active.abort();
        }
        const requestKey = message?.method === 'tools/call' && ['number', 'string'].includes(typeof message.id) ? JSON.stringify(message.id) : undefined;
        if (requestKey) {
          const active = mcpRequests.get(requestKey) ?? new Set<AbortController>();
          active.add(abort); mcpRequests.set(requestKey, active);
        }
        // MCP always calls the public API, including when served on the same port.
        const mcp = await createMcpServer(new FilmcraftApiClient(apiUrl, options.token), { signal: abort.signal });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const close = async () => {
          mcpClosers.delete(close);
          if (requestKey) { const active = mcpRequests.get(requestKey); active?.delete(abort); if (!active?.size) mcpRequests.delete(requestKey); }
          await mcp.close();
        };
        mcpClosers.add(close);
        res.once('close', () => { void close().catch(error => process.stderr.write(`MCP close: ${errorMessage(error)}\n`)); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, message);
        return;
      }
      let result;
      if (req.method === 'GET') {
        if (route === '/v1/health') return respond(res, service.backend.connected ? 200 : 503, { connected: service.backend.connected, mode: service.backend.mode, version: '0.1.0' });
        if (route === '/v1/tools') return respond(res, 200, { tools: service.listTools() });
        if (route === '/v1/openapi.json') return respond(res, 200, openapi(service.backend.mode));
        if (route === '/v1/document') result = await service.invoke('filmcraft_inspect', {});
        else if (route === '/v1/commands') {
          const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
          for (const field of ['offset', 'limit']) if (field in args) args[field] = Number(args[field]);
          if ('enabled_only' in args) {
            if (!['true', 'false'].includes(String(args.enabled_only))) throw new PluginError('INVALID_ARGUMENTS', 'enabled_only must be true or false', 400);
            args.enabled_only = args.enabled_only === 'true';
          }
          result = await service.invoke('filmcraft_commands', args);
        }
      } else if (req.method === 'POST') {
        if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new PluginError('BODY_TOO_LARGE', 'Body exceeds 4 MiB', 413);
        if (route.startsWith('/v1/tools/')) result = await service.invoke(decodeURIComponent(route.slice('/v1/tools/'.length)), await body(req), { signal: abort.signal });
        else if (route.startsWith('/v1/commands/')) result = await service.invoke('filmcraft_execute', { id: decodeURIComponent(route.slice('/v1/commands/'.length)), params: await body(req) });
        else if (route === '/v1/batch') result = await service.invoke('filmcraft_batch', await body(req));
        else if (route === '/v1/render') result = await service.invoke('filmcraft_render_preview', await body(req));
      }
      if (!result) throw new PluginError('NOT_FOUND', 'Unknown endpoint or method', 404);
      respond(res, result.isError ? 422 : 200, { result });
    } catch (error) {
      const err = error instanceof PluginError ? error : new PluginError('INTERNAL', errorMessage(error));
      if (!res.headersSent && !res.destroyed) respond(res, err.status, { error: { code: err.code, message: err.message } });
    }
  });
  server.requestTimeout = 30_000; // Limit incoming uploads; does not interrupt running engine commands.
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8765, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new PluginError('LISTEN_FAILED', 'No TCP address');
  apiUrl = `http://127.0.0.1:${address.port}`;
  if (options.chat) {
    const runtimeEnv = options.chat.env ?? process.env;
    service.configureRuntime(runtimeEnv, options.chat.fetch);
    chat = new ChatService(apiUrl, options.token, runtimeEnv, options.chat.fetch, service);
  }
  return {
    url: apiUrl,
    close: async () => {
      await chat?.close();
      await Promise.allSettled([...mcpClosers].map(close => close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    },
  };
}
