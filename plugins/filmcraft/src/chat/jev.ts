import { randomUUID } from 'node:crypto';
import { resultData } from '../core.js';
import type { Params } from '../core.js';
import { instructions, post, toolText } from './providers.js';
import type { AgentContext } from './providers.js';

type Schema = Record<string, any>;
const OMIT = '__omit__';
const MISSING = '__missing__';
const unique = (values: unknown[]) => [...new Map(values.filter(v => v !== undefined).map(v => [JSON.stringify(v), v])).values()].slice(0, 80);

/** Closed-set arguments are grounded in literals supplied by the user and inspected project data.
 * Jev does not generate strings or JSON. Complex objects can be provided in a JSON code block. */
export function candidates(schema: Schema, key: string, prompt: string, observed: unknown[]): unknown[] {
  if (schema.const !== undefined) return [schema.const];
  if (schema.enum) return schema.enum;
  if (schema.anyOf || schema.oneOf) return unique((schema.anyOf ?? schema.oneOf).flatMap((s: Schema) => candidates(s, key, prompt, observed)));
  const literals: unknown[] = [];
  for (const match of prompt.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    try {
      const value = JSON.parse(match[1]!);
      if (value && typeof value === 'object' && key in value) literals.push(value[key]);
    } catch { /* Non-JSON prose is not an argument. */ }
  }
  const strings = [...prompt.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)].map(m => m[1] ?? m[2] ?? m[3]);
  const numbers = [...prompt.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].map(m => Number(m[0])).filter(Number.isSafeInteger);
  const decimals = [...prompt.matchAll(/(?<![\w.])-?\d+\.\d+(?![\w.])/g)].map(m => Number(m[0]));
  const fromProject: unknown[] = [];
  const visit = (v: unknown, depth = 0) => {
    if (depth > 12 || fromProject.length > 1000 || !v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      if (k === key || (['clip', 'item', 'caption', 'job', 'parent', 'left', 'right'].includes(key) && k === 'id')) fromProject.push(child);
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  observed.forEach(v => visit(v));
  let pool: unknown[] = [...literals, schema.default, ...fromProject];
  if (schema.type === 'boolean') pool.push(true, false);
  if (schema.type === 'string') pool.push(...strings, ...prompt.match(/\/(?:[^\s"'`]+\/)*[^\s"'`]+/g) ?? []);
  if (['number', 'integer'].includes(schema.type)) pool.push(...numbers, ...decimals);
  if (schema.type === 'array' && schema.items) {
    const values = candidates(schema.items, key === 'clips' ? 'clip' : key === 'paths' ? 'path' : key, prompt, observed);
    pool.push(...values.slice(0, 30).map(v => [v]));
  }
  return unique(pool).filter(v => {
    if (schema.type === 'integer' && !Number.isSafeInteger(v)) return false;
    if (schema.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return false;
    if (schema.type === 'string' && typeof v !== 'string') return false;
    if (schema.type === 'boolean' && typeof v !== 'boolean') return false;
    if (schema.type === 'array' && !Array.isArray(v)) return false;
    if (schema.type === 'object' && (!v || typeof v !== 'object' || Array.isArray(v))) return false;
    if (typeof v === 'number' && ((schema.minimum !== undefined && v < schema.minimum) || (schema.maximum !== undefined && v > schema.maximum) || (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum))) return false;
    if (typeof v === 'string' && ((schema.minLength && v.length < schema.minLength) || (schema.pattern && !new RegExp(schema.pattern).test(v)))) return false;
    return true;
  });
}

export function readChoice(response: any, key: string, criteria: Record<string, unknown>): string {
  const answer = response.answers?.[key];
  const probabilities = answer?.probabilities;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice) ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !probabilities ||
      Object.keys(probabilities).length !== Object.keys(criteria).length ||
      Object.keys(criteria).some(k => !Number.isFinite(probabilities[k]) || probabilities[k] < 0 || probabilities[k] > 1) ||
      Math.abs(Object.values(probabilities).reduce<number>((sum, v) => sum + Number(v), 0) - 1) > 0.02) {
    throw new Error('Jev returned an invalid Choice response; no further tools were executed.');
  }
  if (answer.confidence < 0.6) throw new Error('Jev needs a more specific request (confidence below 0.6). Include exact clip IDs, numbers or quoted text.');
  return answer.choice;
}

export async function runJev(ctx: AgentContext) {
  const observed: unknown[] = [];
  const completed: unknown[] = [];
  let assets: Record<string, unknown> = {};
  let imageRef: unknown;
  const capture = async (name: string, args: Params = {}) => {
    const result = await ctx.call(name, args);
    const data = resultData(result);
    observed.push(data);
    for (const image of result.content) {
      if (image.type !== 'image' || image.mimeType !== 'image/png') continue;
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length < 24 || bytes.length > 16 * 1024 * 1024) continue;
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (width < 280 || height < 280 || width > 1568 || height > 1568) continue;
      const id = randomUUID();
      assets = { [id]: { type: 'image', format: 'png', data_base64: image.data } };
      imageRef = { frame: id, width, height };
    }
    return result;
  };
  await capture('filmcraft_inspect');
  // The desktop image supplies visual context without touching the project's playhead.
  if (ctx.tools.some(t => t.name === 'filmcraft_ui_screenshot')) await capture('filmcraft_ui_screenshot', { max_side: 1200 });
  const ask = (questions: Record<string, unknown>) => post(ctx, 'https://api.typesafe.ai/v1/systemone', {
    Authorization: `Bearer ${ctx.config.apiKey}`,
    // Explicitly requested experimental Jev vision support. Never substitute a chat-completions API.
    'TypeSafe-Danger-Zone-Images': 'true',
  }, { model: ctx.config.model, state: { conversation: ctx.turns, project: JSON.stringify(observed).slice(-80_000), completed, image: imageRef }, questions, ...(imageRef ? { assets } : {}) });
  const prompt = ctx.turns.filter(t => t.role === 'user').map(t => t.text).join('\n');
  for (let step = 0; step < 12; step++) {
    ctx.signal.throwIfAborted();
    const criteria: Record<string, unknown> = {
      done: 'The latest user request has been fulfilled; completed tool results verify it.',
      need_input: 'The request cannot be resolved from the supplied state, or requires arbitrary text generation.',
      ...Object.fromEntries(ctx.tools.map(t => [t.name, { description: t.description, arguments: t.inputSchema }])),
    };
    const decision = await ask({ action: { type: 'choice', instructions: `${instructions} Select the next tool for the latest user request, or done/need_input. Do not repeat completed actions.`, criteria } });
    const action = readChoice(decision, 'action', criteria);
    if (action === 'done') { ctx.say('Jev finished its tool sequence. Review the tool results and the timeline.'); return; }
    if (action === 'need_input') { ctx.say('Jev needs a more specific edit. Supply exact numbers, quoted title/caption text, clip IDs, or a JSON code block containing tool arguments. Jev selects structured actions; it does not generate prose.'); return; }
    const tool = ctx.tools.find(t => t.name === action)!;
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
    const required = (tool.inputSchema.required ?? []) as string[];
    const choices: Record<string, Record<string, unknown>> = {};
    const values: Record<string, unknown[]> = {};
    const questions: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(properties)) {
      values[key] = candidates(schema, key, prompt, observed);
      const options: Record<string, unknown> = { [MISSING]: 'The needed value is unavailable. Ask the user; never guess.' };
      if (!required.includes(key)) options[OMIT] = 'Do not set this optional parameter; leave the native default unchanged.';
      values[key].forEach((v, i) => { options[`v${i}`] = { value: v }; });
      choices[key] = options;
      questions[key] = { type: 'choice', instructions: { task: `Select parameter ${key} for ${action}. Only use a value supported by the user's request and project. Omit unrelated optional fields.`, tool: tool.description, schema }, criteria: options };
    }
    const args: Params = {};
    if (Object.keys(questions).length) {
      const answers = await ask(questions);
      for (const key of Object.keys(questions)) {
        const choice = readChoice(answers, key, choices[key]!);
        if (choice === MISSING) { ctx.say(`Jev needs an explicit value for ${action}.${key}. Put complex arguments in a JSON code block.`); return; }
        if (choice !== OMIT) args[key] = values[key]![Number(choice.slice(1))];
      }
    }
    const signature = JSON.stringify({ action, args });
    if (completed.some(v => (v as any).signature === signature)) throw new Error('Jev repeated a completed action. Stopped to prevent duplicate edits.');
    const result = await capture(action, args);
    completed.push({ signature, result: toolText(result) });
    if (result.isError) { ctx.say(`FilmCraft rejected ${action}. Review the tool error and refine the request.`); return; }
  }
  throw new Error('Stopped after 12 Jev actions. Review the results before continuing.');
}
