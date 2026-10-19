import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { editDemo } from './workflow.mjs';

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../artifacts/demo', import.meta.url)));
const client = new Client({ name: 'jev-evaluation-client', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'], stderr: 'inherit' }));
  const report = await editDemo(client, directory);
  console.log(JSON.stringify({ ...report, events: `${report.events.length} calls recorded in report.json` }, null, 2));
} finally { await client.close(); }
