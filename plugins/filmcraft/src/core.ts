import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type Params = Record<string, unknown>;
export type Mode = 'headless' | 'bridge';

export interface Backend {
  readonly mode: Mode;
  readonly connected: boolean;
  call(tool: string, args: Params): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class PluginError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Keep exact large integers from upstream text as decimal strings, never rounded numbers. */
export function resultData(result: CallToolResult): unknown {
  const text = result.content.find(c => c.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    return JSON.parse(text.text, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (!context?.source) throw new Error('Lossless JSON parsing requires Node 22+');
        return context.source;
      }
      return value;
    });
  } catch { return text.text; }
}

/** Reject ambiguous numbers before passing arbitrary command params through the JS bridge. */
export function checkNumbers(value: unknown, depth = 0): void {
  if (depth > 64) throw new PluginError('INVALID_ARGUMENTS', 'Arguments exceed 64 levels of nesting', 400);
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new PluginError('INVALID_ARGUMENTS', 'Use safe integer ticks, or FilmCraft seconds/frame/timecode parameters', 400);
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) checkNumbers(child, depth + 1);
  }
}
