import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repository } from '../config.js';

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
const KEEP_RUNS = 20;
const secretField = /^(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|set-cookie)$/i;
const binaryField = /^(data_base64|base64|blob)$/i;

export interface DebugInfo { enabled: true; path?: string; error?: string; truncated?: boolean }
export type Trace = (event: string, data: unknown) => Promise<void>;

export function debugDirectory(env: NodeJS.ProcessEnv) {
  return join(env.FILMCRAFT_STATE_DIR ? resolve(env.FILMCRAFT_STATE_DIR) : join(repository, 'artifacts/chat'), 'debug');
}

/** Redact before serialization, including JSON embedded in tool-result strings. */
export function debugRedactor(secrets: string[]) {
  const variants = [...new Set(secrets.filter(Boolean).flatMap(s => [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(Buffer.from(s).toString('utf8'))]))].sort((a, b) => b.length - a.length);
  const text = (value: string) => {
    for (const secret of variants) value = value.replaceAll(secret, '[redacted]');
    return value.replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [redacted]')
      .replace(/data:(?:image|audio|video)\/[^\s"']+/gi, '[media omitted]');
  };
  return function sanitize(value: unknown): unknown {
    const seen = new WeakSet<object>();
    let nodes = 0;
    const visit = (v: unknown, depth: number): unknown => {
      if (++nodes > 100_000 || depth > 24) return '[structure truncated]';
      if (typeof v === 'string') {
        // Nested JSON commonly occurs in MCP content and provider function arguments.
        if (/^\s*[\[{]/.test(v)) {
          try { return JSON.stringify(visit(JSON.parse(v), depth + 1)); } catch { /* Preserve malformed response text. */ }
        }
        return text(v).replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"');
      }
      if (!v || typeof v !== 'object') return v;
      if (seen.has(v)) return '[circular reference]';
      seen.add(v);
      const result = Array.isArray(v) ? v.map(x => visit(x, depth + 1)) : Object.fromEntries(Object.entries(v).map(([key, item]) => [text(key), secretField.test(key) ? '[redacted]' :
        binaryField.test(key) || (key === 'data' && (['image', 'audio', 'base64'].includes(String((v as any).type)) || (v as any).format === 'wav' || (v as any).encoding === 'base64')) ? '[media omitted]' : visit(item, depth + 1)]));
      seen.delete(v);
      return result;
    };
    return visit(value, 0);
  };
}

/** Local, bounded JSONL traces. Logging failures never interrupt an edit. */
export class DebugTrace {
  readonly info: DebugInfo = { enabled: true };
  private file?: FileHandle;
  private bytes = 0;
  private sequence = 0;
  private capped = false;
  private sanitize: ReturnType<typeof debugRedactor>;
  constructor(private directory: string, secrets: string[]) { this.sanitize = debugRedactor(secrets); }

  async start(runId: string) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const name = `${new Date().toISOString().replaceAll(':', '-')}_${runId}.jsonl`;
      this.file = await open(join(this.directory, name), 'wx', 0o600);
      this.info.path = join(this.directory, name);
      const files = (await readdir(this.directory)).filter(n => /^\d{4}-.*_[a-f0-9-]{36}\.jsonl$/.test(n)).sort().reverse();
      for (const old of files.slice(KEEP_RUNS)) await unlink(join(this.directory, old));
    } catch { this.info.error = 'Could not create or rotate the local debug log. Check available disk space and directory permissions.'; }
  }

  readonly write: Trace = async (event, data) => {
    if (!this.file || this.info.error || this.capped) return;
    try {
      const envelope = { version: 1, sequence: ++this.sequence, at: new Date().toISOString(), event };
      let safe = this.sanitize(data);
      const encoded = JSON.stringify(safe) ?? 'null';
      if (Buffer.byteLength(encoded) > MAX_ENTRY_BYTES) {
        this.info.truncated = true;
        safe = { truncated: true, originalBytes: Buffer.byteLength(encoded), preview: encoded.slice(0, MAX_ENTRY_BYTES / 4) };
      }
      let line = JSON.stringify({ ...envelope, data: safe }) + '\n';
      if (this.bytes + Buffer.byteLength(line) > MAX_RUN_BYTES) {
        this.capped = true;
        this.info.truncated = true;
        line = JSON.stringify({ ...envelope, event: 'trace.limit', data: { message: '16 MiB run limit reached; further events omitted.' } }) + '\n';
      }
      await this.file.writeFile(line);
      this.bytes += Buffer.byteLength(line);
    } catch { this.info.error = 'Debug logging stopped because the local log could not be written.'; }
  };

  async close() {
    try { await this.file?.close(); }
    catch { this.info.error = 'The local debug log could not be closed cleanly.'; }
  }
}
