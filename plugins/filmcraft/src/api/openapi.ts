import type { Mode } from '../core.js';
import { availableTools, describeTool } from '../tools/catalog.js';

export function openapi(mode: Mode) {
  const paths: Record<string, unknown> = {};
  const response = { description: 'MCP-compatible result, preserving text and image content.', content: { 'application/json': { schema: { type: 'object', properties: { result: { type: 'object', additionalProperties: true } }, required: ['result'] } } } };
  for (const tool of availableTools(mode)) {
    paths[`/v1/tools/${tool.name}`] = { post: {
      operationId: tool.name, summary: tool.description, tags: [tool.group],
      requestBody: { required: true, content: { 'application/json': { schema: describeTool(tool).inputSchema } } },
      responses: { '200': response, '400': { description: 'Invalid arguments' }, '422': { ...response, description: 'Engine error or partially failed batch; result.isError is true' }, '502': { description: 'Transport failure; inspect state before retrying' } },
    } };
  }
  for (const route of ['/v1/health', '/v1/tools', '/v1/document', '/v1/commands', '/v1/openapi.json']) {
    paths[route] = { get: { summary: route, responses: { '200': { description: 'JSON response' } }, ...(route === '/v1/commands' ? { parameters: [
      { name: 'filter', in: 'query', schema: { type: 'string' } },
      { name: 'enabled_only', in: 'query', schema: { type: 'boolean' } },
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ] } : {}) } };
  }
  paths['/v1/commands/{id}'] = { post: { summary: 'Run any native command; request body is its params object', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { '200': response, '422': response } } };
  for (const [route, name] of [['/v1/batch', 'filmcraft_batch'], ['/v1/render', 'filmcraft_render_preview']]) {
    paths[route!] = paths[`/v1/tools/${name}`];
  }
  return { openapi: '3.1.0', info: { title: 'Jev FilmCraft API', version: '0.1.0', description: 'One persistent editing session per API process. Paths refer to files on the FilmCraft host. Batches are ordered, not atomic.' }, security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, paths };
}
