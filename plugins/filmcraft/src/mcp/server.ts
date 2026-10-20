import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { FilmcraftApiClient } from '../api/client.js';
import { failure, errorMessage, resultData } from '../core.js';

const instructions = `FilmCraft video editing through a persistent HTTP API. First filmcraft_inspect, then import media/create sequence/edit using returned IDs. filmcraft_commands searches every native command and its parameter docs; filmcraft_execute covers the complete catalog. Use filmcraft_render_preview to see real PNG frames. Use filmcraft_audio_read for actual bounded WAV audio and filmcraft_audio_analyze for attributed listening/transcription from the configured audio model. Imported audio and video audio can be read/analyzed before placement using item IDs from filmcraft_inspect bin or filmcraft_media_import and optional zero-based audioStream (default 0). item and track are exclusive; audioStream requires item. Item excerpts use source seconds and preserve source identity/stream/offset, not timeline positions. No active sequence or source monitor is needed. You decide cuts and can execute version 1 structured split/trim/remove-range/move plans with filmcraft_execute_plan through Jev; inspect exact target snapshots first and use refreshed clip IDs after every edit. Plan failures preserve applied edits and must never be replayed. Time is exact ticks (254016000000/s), or seconds/frame/timecode where documented. graphics.newText's seconds means duration. Save explicitly with filmcraft_project_save. Exports are asynchronous: poll filmcraft_jobs_list and check errors/offlineMedia. Batches stop on error but do not roll back. Do not automatically retry ambiguous failures. Local paths refer to the FilmCraft host. Desktop tools only exist in bridge mode.`;

export async function createMcpServer(api: FilmcraftApiClient, options: { signal?: AbortSignal } = {}) {
  const catalog = await api.listTools();
  const server = new Server({ name: 'jev-filmcraft', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!catalog.some(t => t.name === request.params.name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${request.params.name}`);
    try { return await api.callTool(request.params.name, request.params.arguments ?? {}, { signal: options.signal ? AbortSignal.any([options.signal, extra.signal]) : extra.signal }); }
    catch (error) { return failure(errorMessage(error)); }
  });
  const resources = [
    { uri: 'filmcraft://document', name: 'Current FilmCraft document', mimeType: 'application/json', description: 'Live project and active sequence' },
    { uri: 'filmcraft://capabilities', name: 'FilmCraft API capabilities', mimeType: 'application/json', description: 'Available typed tools and schemas; discover native commands with filmcraft_commands' },
  ];
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const uri = request.params.uri;
    let data: unknown;
    if (uri === 'filmcraft://document') {
      const result = await api.callTool('filmcraft_inspect');
      if (result.isError) throw new McpError(ErrorCode.InternalError, JSON.stringify(result.content));
      data = resultData(result);
    } else if (uri === 'filmcraft://capabilities') data = catalog;
    else throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${uri}`);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] };
  });
  return server;
}

export async function startStdio(api: FilmcraftApiClient) {
  const server = await createMcpServer(api);
  await server.connect(new StdioServerTransport());
  return server;
}
