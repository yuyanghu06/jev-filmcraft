import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { repository } from '../config.js';
import { PluginError } from '../core.js';

const settings = z.strictObject({
  apiKey: z.string().trim().max(4096).refine(value => !/[\r\n]/.test(value)).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
const schema = z.strictObject({ claude: settings.optional(), chatgpt: settings.optional(), jev: settings.optional() });
export const defaultProviderConfig = join(repository, 'plugins/filmcraft/config/providers.local.json');
export function providerConfigPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FILMCRAFT_PROVIDERS_CONFIG ? resolve(env.FILMCRAFT_PROVIDERS_CONFIG) : defaultProviderConfig;
}

/** Load only provider settings; never mutate process.env or pass file credentials to FilmCraft. */
export async function loadProviderEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const path = providerConfigPath(env);
  let file;
  try { file = await open(path, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !env.FILMCRAFT_PROVIDERS_CONFIG) return { ...env };
    throw new PluginError('CONFIG', `Cannot read provider configuration at ${path}. Run npm run chat:config to create it.`, 400);
  }
  let value: unknown;
  try {
    if ((await file.stat()).size > 32 * 1024) throw new Error('Too large');
    value = JSON.parse(await file.readFile('utf8'));
  } catch {
    // JSON.parse and validation errors may contain fragments of a secret. Never forward them.
    throw new PluginError('CONFIG', `Invalid provider configuration at ${path}. Use valid JSON, at most 32 KiB.`, 400);
  } finally { await file.close(); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join('.') || 'root').join(', ');
    throw new PluginError('CONFIG', `Invalid provider configuration fields: ${fields}. Use claude/chatgpt/jev objects with apiKey and model strings.`, 400);
  }
  const config = parsed.data;
  // Explicit environment values (including empty keys) override the file. Either Jev key alias wins.
  return {
    ...env,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? config.claude?.apiKey,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? config.claude?.model,
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? config.chatgpt?.apiKey,
    OPENAI_MODEL: env.OPENAI_MODEL ?? config.chatgpt?.model,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? config.jev?.apiKey,
    JEV_MODEL: env.JEV_MODEL ?? config.jev?.model,
  };
}

/** Create an owner-only template without ever replacing a user's existing credentials. */
export async function initProviderConfig(env: NodeJS.ProcessEnv = process.env) {
  const path = providerConfigPath(env);
  const template = await readFile(join(repository, 'plugins/filmcraft/config/providers.example.json'), 'utf8');
  await mkdir(dirname(path), { recursive: true });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path, created: false };
    throw new PluginError('CONFIG', `Cannot create provider configuration at ${path}.`, 400);
  }
  try { await file.writeFile(template); } finally { await file.close(); }
  return { path, created: true };
}
