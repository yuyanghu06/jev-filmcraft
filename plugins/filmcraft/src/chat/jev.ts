import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resultData } from '../core.js';
import type { Params } from '../core.js';
import { instructions, post, toolText } from './providers.js';
import type { AgentContext } from './providers.js';
import { verifyEdit } from './verify.js';
import { jevTools, nativeMoveArguments } from './jev-tools.js';

type Schema = Record<string, any>;
const MISSING = '__missing__';
const unique = (values: unknown[]) => [...new Map(values.filter(v => v !== undefined).map(v => [JSON.stringify(v), v])).values()].slice(0, 80);

export function literalArguments(prompt: string): Params {
  const values: Params = Object.create(null);
  for (const match of prompt.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    try {
      const value = JSON.parse(match[1]!);
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(values, value);
    } catch { /* Prose/code is not a structured argument. */ }
  }
  return values;
}

function objects(observed: unknown[]): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 16 || found.length >= 10000 || !value || typeof value !== 'object') return;
    if (!Array.isArray(value)) found.push(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  observed.forEach(value => visit(value));
  return found;
}

function referenceValues(key: string, observed: unknown[], tool: string): unknown[] | undefined {
  const nodes = objects(observed);
  if (['clip', 'left', 'right'].includes(key)) return nodes.filter(n => Number.isSafeInteger(n.clip)).map(n => n.clip);
  if (['item', 'fromItem'].includes(key)) return nodes.filter(n => Number.isSafeInteger(n.item) &&
    (!['filmcraft_sequence_inspect', 'filmcraft_sequence_open'].includes(tool) || n.type === 'Sequence')).map(n => n.item);
  if (['track', 'audioTrack'].includes(key) && ['filmcraft_clip_move', 'filmcraft_clip_place', 'filmcraft_clip_split'].includes(tool)) {
    return observed.flatMap((doc: any) => ['video', 'audio'].flatMap(kind => (doc?.sequence?.[kind] ?? []).flatMap((track: any, index: number) => [track.id, `${kind === 'video' ? 'V' : 'A'}${index + 1}`])));
  }
  return undefined;
}

function numericLiterals(key: string, prompt: string, tool: string): number[] {
  const number = '([+-]?\\d+(?:\\.\\d+)?)';
  const patterns: string[] = [`\\b${key}\\s*[:=]?\\s*${number}\\b`];
  if (key === 'seconds' || key === 'durationSeconds') patterns.push(`${number}\\s*(?:seconds?|secs?)\\b`);
  if (key === 'db' || key === 'volumeDb') patterns.push(`${number}\\s*dB\\b`);
  if (key === 'time') patterns.push(`\\bticks?\\s+${number}\\b`, `${number}\\s+ticks?\\b`);
  if (key === 'track' && tool === 'filmcraft_title_create') patterns.push(`\\btrack\\s+index\\s+${number}\\b`);
  const matched = patterns.flatMap(pattern => [...prompt.matchAll(new RegExp(pattern, 'gi'))].flatMap(m => {
    const value = Number(m[1]);
    // "Lower by 2 dB" supplies an unsigned magnitude; the model selects the
    // negative adjustment. Preserve an explicitly written + or - sign.
    return key === 'db' && tool === 'filmcraft_audio_gain' && !/^[+-]/.test(m[1]!) ? [value, -value] : [value];
  }));
  if (key === 'track' && tool === 'filmcraft_title_create') {
    for (const match of prompt.matchAll(/\bV(\d+)\b/gi)) matched.push(Number(match[1]) - 1);
  }
  // A natural-language frame amount supplies a magnitude; the model still chooses direction.
  if (key === 'deltaFrames' && !matched.length) {
    for (const match of prompt.matchAll(/([+-]?\d+)\s+frames?\b/gi)) {
      const value = Number(match[1]);
      matched.push(value);
      if (!/^[+-]/.test(match[1]!)) matched.push(-value);
    }
  }
  return unique(matched) as number[];
}

function timelineChanges(before: any, after: any) {
  const clips = (document: any) => ['video', 'audio'].flatMap(kind => (document?.sequence?.[kind] ?? []).flatMap((track: any, index: number) =>
    (track.items ?? []).map((clip: any) => ({ ...clip, trackKind: kind, trackIndex: index }))));
  const previous = new Map(clips(before).map((c: any) => [c.clip, c]));
  const current = new Map(clips(after).map((c: any) => [c.clip, c]));
  const summarize = (c: any) => c && Object.fromEntries(['clip', 'item', 'link', 'name', 'trackKind', 'trackIndex', 'startFrame', 'durationFrames', 'gainDb'].map(k => [k, c[k]]));
  const changes = [...new Set([...previous.keys(), ...current.keys()])].flatMap(id => {
    const was = summarize(previous.get(id)), now = summarize(current.get(id));
    return JSON.stringify(was) === JSON.stringify(now) ? [] : [{ before: was, after: now,
      ...(was && now ? { durationDeltaFrames: now.durationFrames - was.durationFrames, startDeltaFrames: now.startFrame - was.startFrame, gainDeltaDb: now.gainDb - was.gainDb } : {}),
    }];
  });
  const items = (doc: any) => objects([doc?.project?.root]).filter(n => Number.isSafeInteger(n.item)).map(n => ({ item: n.item, name: n.name, type: n.type }));
  const previousItems = items(before), currentItems = items(after);
  const projectItems = currentItems.filter(n => !previousItems.some(p => JSON.stringify(p) === JSON.stringify(n)));
  const transitions = (doc: any) => [...doc?.sequence?.video ?? [], ...doc?.sequence?.audio ?? []].map((track: any) => ({ track: track.id, transitions: track.transitions }));
  return { clips: changes, markersBefore: before?.sequence?.markers, markersAfter: after?.sequence?.markers,
    addedOrChangedProjectItems: projectItems, selectionBefore: before?.sequence?.selection, selectionAfter: after?.sequence?.selection,
    ...(JSON.stringify(transitions(before)) !== JSON.stringify(transitions(after)) ? { transitionsBefore: transitions(before), transitionsAfter: transitions(after) } : {}),
  };
}

function argumentContext(document: any) {
  const tracks = (kind: 'video' | 'audio') => (document?.sequence?.[kind] ?? []).map((track: any, index: number) => ({
    index, id: track.id, label: `${kind === 'video' ? 'V' : 'A'}${index + 1}`, name: track.name,
    clips: (track.items ?? []).map((clip: any) => Object.fromEntries(
      ['clip', 'item', 'name', 'startFrame', 'durationFrames', 'gainDb'].map(key => [key, clip[key]]))),
  }));
  return { activeSequence: document?.project?.activeSequence, video: tracks('video'), audio: tracks('audio') };
}

/** Closed-set arguments are grounded in literals supplied by the user and inspected project data.
 * Jev does not generate strings or JSON. Complex objects can be provided in a JSON code block. */
export function candidates(schema: Schema, key: string, prompt: string, observed: unknown[], tool = ''): unknown[] {
  if (schema.const !== undefined) return [schema.const];
  if (schema.enum) return schema.enum;
  if (schema.anyOf || schema.oneOf) return unique((schema.anyOf ?? schema.oneOf).flatMap((s: Schema) => candidates(s, key, prompt, observed, tool)));
  const explicit = literalArguments(prompt);
  const literals = Object.hasOwn(explicit, key) ? [explicit[key]] : [];
  const strings = [...prompt.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g)].map(m => m[1] ?? m[2] ?? m[3]);
  const numbers = [...prompt.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].map(m => Number(m[0])).filter(Number.isSafeInteger);
  const decimals = [...prompt.matchAll(/(?<![\w.])-?\d+\.\d+(?![\w.])/g)].map(m => Number(m[0]));
  const references = referenceValues(key, observed, tool);
  // Inspection serializes effect parameters differently from command input.
  // Never treat arbitrary result objects or unrelated effect IDs as ready-to-run arguments.
  const fromProject = schema.type === 'object' || (key === 'effect' && tool.startsWith('filmcraft_transition_')) ? [] :
    objects(observed).filter(n => Object.hasOwn(n, key)).map(n => n[key]);
  let pool: unknown[] = [...literals, schema.default, ...fromProject];
  if (schema.type === 'boolean') pool.push(true, false);
  if (schema.type === 'string') pool.push(...strings, ...prompt.match(/\/(?:[^\s"'`]+\/)*[^\s"'`]+/g) ?? []);
  if (['number', 'integer'].includes(schema.type)) pool.push(...numbers, ...decimals);
  const numeric = ['number', 'integer'].includes(schema.type) ? numericLiterals(key, prompt, tool) : [];
  if (numeric.length && !references) pool = [...literals, ...numeric];
  if (schema.type === 'array' && schema.items) {
    const values = candidates(schema.items, key === 'clips' ? 'clip' : key === 'paths' ? 'path' : key === 'fromItems' ? 'fromItem' : key, prompt, observed, tool);
    pool.push(...values.slice(0, 30).map(v => [v]));
    if (key === 'clips') {
      const ids = referenceValues('clip', observed, tool) ?? [];
      pool = pool.filter(v => Array.isArray(v) && v.every(id => ids.includes(id)));
    }
  }
  // Timeline IDs are references, not arbitrary numbers from durations or other entity IDs.
  if (references) {
    const named = numericLiterals(key, prompt, tool);
    // A specifically named but nonexistent target must not turn into another clip
    // just because its ID happens to equal a duration elsewhere in the request.
    pool = [...literals, ...(named.length ? named : [...numbers.filter(n => references.includes(n)), ...references])].filter(v => references.includes(v));
    if (['track', 'audioTrack'].includes(key)) {
      const labels = [...prompt.matchAll(/\b[VA]\d+\b/g)].map(m => m[0]);
      if (labels.length && !literals.length) pool = labels.filter(v => references.includes(v));
      else if (!named.length && !literals.length) pool = references.filter(v => typeof v === 'string');
    }
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
  const choose = async (response: any, key: string, criteria: Record<string, unknown>) => {
    try {
      const choice = readChoice(response, key, criteria);
      await ctx.trace?.('jev.decision', { parameter: key, choice, selected: criteria[choice], confidence: response.answers?.[key]?.confidence, accepted: true });
      return choice;
    } catch (error) {
      await ctx.trace?.('jev.decision', { parameter: key, answer: response.answers?.[key], accepted: false, reason: error instanceof Error ? error.message : String(error) });
      if (key === 'progress') throw new Error('Edits were applied and inspected, but Jev could not confirm that the entire request is complete. Review the timeline before retrying; completed edits remain.');
      throw error;
    }
  };
  const observed = new Map<string, unknown>();
  const completed: Record<string, unknown>[] = [];
  let assets: Record<string, unknown> = {};
  let imageRef: unknown;
  const capture = async (name: string, args: Params = {}) => {
    const result = await ctx.call(name, args);
    const data = resultData(result);
    observed.set(name, data);
    if (result.isError) throw new Error(`FilmCraft rejected ${name}: ${toolText(result)}`);
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
  const initial = await capture('filmcraft_inspect');
  completed.push({ name: 'filmcraft_inspect', purpose: 'Initial read of the current project and active timeline; already fulfills a request only to inspect them.', result: toolText(initial) });
  // The desktop image supplies visual context without touching the project's playhead.
  if (ctx.tools.some(t => t.name === 'filmcraft_ui_screenshot')) await capture('filmcraft_ui_screenshot', { max_side: 1200 });
  const prompt = ctx.turns.findLast(t => t.role === 'user')?.text ?? '';
  const ask = (questions: Record<string, unknown>, phase: 'action' | 'arguments' | 'progress' = 'action') => post(ctx, 'https://api.typesafe.ai/v1/systemone', {
    Authorization: `Bearer ${ctx.config.apiKey}`,
    // Explicitly requested experimental Jev vision support. Never substitute a chat-completions API.
    'TypeSafe-Danger-Zone-Images': 'true',
  }, { model: ctx.config.model, state: phase === 'arguments' ? { request: prompt, timeline: argumentContext(observed.get('filmcraft_inspect')) } :
    phase === 'progress' ? { request: prompt, completed: completed.map(({ signature, result, ...step }) => ({ ...step,
      // Old full-project snapshots obscure the fresh state changes. Retain results for other reads.
      ...(step.name !== 'filmcraft_inspect' ? { result } : {}),
    })) } :
    { conversation: ctx.turns, project: JSON.stringify(Object.fromEntries(observed)).slice(-80_000), completed, image: imageRef },
    questions, ...(phase === 'action' && imageRef ? { assets } : {}) });
  const explicit = literalArguments(prompt);
  // Jev selects supplied values; it cannot synthesize a nested command list.
  // Ordinary multi-step requests must use the individual tools in this loop.
  const selectableTools = jevTools(ctx.tools, explicit).filter(t => t.name !== 'filmcraft_batch' || Array.isArray(explicit.steps));
  for (let step = 0; step < 12; step++) {
    ctx.signal.throwIfAborted();
    if (step > 0) {
      const progress = { done: 'Every requested action has run successfully and was checked.', remaining: 'One or more requested actions or checks have not completed.' };
      const response = await ask({ progress: { type: 'choice', instructions: {
        question: 'Does completed contain every edit requested in request, with successful inspection or verification of each? If anything requested is absent, choose remaining. Native linked changes belong to their action.',
        request: prompt,
      }, criteria: progress } }, 'progress');
      if (await choose(response, 'progress', progress) === 'done') { ctx.say('Jev finished its tool sequence. Review the tool results and the timeline.'); return; }
    }
    const criteria: Record<string, unknown> = {
      ...(step === 0 ? { done: 'The latest user request is already fulfilled by the initial inspection, which covers only the current project and active timeline. No requested edits remain.' } : {}),
      need_input: 'The request cannot be resolved from the supplied state, or requires arbitrary text generation.',
      ...Object.fromEntries(selectableTools.filter(t => t.name !== 'filmcraft_execute' || Object.hasOwn(explicit, 'id') || observed.has('filmcraft_commands')).map(t => [t.name, { description: t.description, arguments: t.inputSchema }])),
    };
    const decision = await ask({ action: { type: 'choice', instructions: { rules: instructions, request: prompt, question: 'What remains to fulfill this request? For multiple edits, choose one remaining action at a time. Choose done only if the latest inspected state and recorded stateChanges already prove the whole requested result. Do not repeat edits. Read-only verification may repeat if needed.' }, criteria } });
    const action = await choose(decision, 'action', criteria);
    if (action === 'done') { ctx.say('Jev finished its tool sequence. Review the tool results and the timeline.'); return; }
    if (action === 'need_input') throw new Error('Jev needs more information to finish this edit. Supply the missing target, value, or quoted text.');
    const tool = selectableTools.find(t => t.name === action)!;
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
    const required = (tool.inputSchema.required ?? []) as string[];
    const choices: Record<string, Record<string, unknown>> = {};
    const values: Record<string, unknown[]> = {};
    const questions: Record<string, unknown> = {};
    const presence: Record<string, any> = {};
    const exact = Object.keys(explicit).length > 0 && /\b(?:exact(?:ly)? (?:these )?(?:arguments|settings|JSON)|these exact (?:arguments|settings))\b/i.test(prompt);
    const defaultChoices = Object.entries(properties).filter(([, schema]) => schema.default !== undefined).map(([key]) => key);
    for (const [key, schema] of Object.entries(properties)) {
      if (required.includes(key) || defaultChoices.includes(key) || Object.hasOwn(explicit, key) || exact) continue;
      presence[`present.${key}`] = { type: 'choice', instructions: {
        question: 'Does the request specify a concrete value for this particular setting? Mentioning a related concept is not enough. Omit unmentioned settings and requests to keep defaults. Explicit positive or negative boolean requests, such as without audio, do specify true or false.',
        request: prompt, parameter: key, meaning: schema.description ?? key, action,
        timing: 'seconds, frame, timecode and time are alternative units for a position: include only the unit the user stated. Title seconds is duration; title time is start in ticks.',
      }, criteria: { include: 'The request specifies this setting; resolve its value.', omit: 'The request leaves this setting unspecified or asks to keep its default.' } };
    }
    const included = new Set([...required, ...(exact ? [] : defaultChoices)]);
    if (Object.keys(presence).length) {
      const response = await ask(presence, 'arguments');
      for (const key of Object.keys(properties)) {
        const question = presence[`present.${key}`];
        if (question && await choose(response, `present.${key}`, question.criteria) === 'include') included.add(key);
      }
    }
    let args: Params = {};
    const grounded = ['filmcraft_inspect', 'filmcraft_jobs_list', 'filmcraft_captions_list', 'filmcraft_commands', 'filmcraft_effects_list'].map(name => observed.get(name)).filter(v => v !== undefined);
    for (const [key, schema] of Object.entries(properties)) {
      if (!included.has(key) && !Object.hasOwn(explicit, key)) continue;
      values[key] = candidates(schema, key, prompt, grounded, action);
      if (Object.hasOwn(explicit, key)) {
        if (!values[key]!.some(v => JSON.stringify(v) === JSON.stringify(explicit[key]))) throw new Error(`The explicit ${action}.${key} value does not match its type or a known project target.`);
        args[key] = explicit[key];
        await ctx.trace?.('jev.literal', { action, parameter: key, value: args[key] });
        continue;
      }
      if (schema.const !== undefined) {
        args[key] = schema.const;
        continue;
      }
      // An exact, unambiguous user-supplied reference is already resolved once
      // inspection confirms it. Do not ask a classifier to reinterpret the ID.
      const namedReferences = referenceValues(key, grounded, action) ? numericLiterals(key, prompt, action) : [];
      const labels = ['track', 'audioTrack'].includes(key) ? unique([...prompt.matchAll(/\b[VA]\d+\b/g)].map(m => m[0])) : [];
      const exactTrack = labels.length === 1 && values[key]!.includes(labels[0]) ? labels[0] : undefined;
      if (exactTrack !== undefined || (values[key]!.length === 1 && namedReferences.length === 1)) {
        args[key] = exactTrack ?? values[key]![0];
        await ctx.trace?.('jev.literal', { action, parameter: key, value: args[key], source: 'inspected user reference' });
        continue;
      }
      const options: Record<string, unknown> = { [MISSING]: 'The needed value is unavailable. Ask the user; never guess.' };
      values[key].forEach((v, i) => {
        const entity = objects(grounded).find(n => (['clip', 'left', 'right'].includes(key) ? n.clip : key === 'item' ? n.item : undefined) === v && n.name);
        options[`v${i}`] = { value: v, ...(v === schema.default ? { default: 'Use this value when the request leaves this setting unspecified or asks for the default.' } : {}), ...(entity ? { name: entity.name, type: entity.type } : {}) };
      });
      choices[key] = options;
      questions[key] = { type: 'choice', instructions: { question: `Which value should ${key} use for ${action}? ${schema.description ?? ''}`, request: prompt,
        ...(schema.default !== undefined ? { defaultRule: `Use ${JSON.stringify(schema.default)} if no different behavior is requested. Equivalent natural-language descriptions count as specifying a value.` } : {}),
      }, criteria: options };
    }
    if (Object.keys(questions).length) {
      const answers = await ask(questions, 'arguments');
      for (const key of Object.keys(questions)) {
        const choice = await choose(answers, key, choices[key]!);
        if (choice === MISSING) throw new Error(`Jev needs an explicit value for ${action}.${key}. Put complex arguments in a JSON code block.`);
        args[key] = values[key]![Number(choice.slice(1))];
      }
    }
    if ('frame' in properties && ['seconds', 'frame', 'timecode', 'time'].filter(key => key in args).length > 1) throw new Error('Specify a timeline position in exactly one unit: seconds, frame, timecode or ticks.');
    if (action === 'filmcraft_clip_move' && properties.clip) args = nativeMoveArguments(args, observed.get('filmcraft_inspect'));
    const signature = JSON.stringify({ action, args });
    if (!tool.annotations?.readOnlyHint && completed.some(v => (v as any).signature === signature)) throw new Error('Jev repeated a completed edit. Stopped to prevent duplicate edits.');
    const targetedDelete = ['filmcraft_selection_delete', 'filmcraft_selection_ripple_delete'].includes(action) && Array.isArray(args.clips);
    if (targetedDelete) await capture('filmcraft_clip_select', { clips: args.clips, linked: args.linked ?? true });
    const result = await capture(action, targetedDelete ? {} : args);
    const completedStep: Record<string, unknown> = { name: action, description: tool.description, args, signature, result: resultData(result) };
    completed.push(completedStep);
    if (action === 'filmcraft_export_start') {
      const started = resultData(result) as any;
      if (!Number.isSafeInteger(started?.job)) throw new Error('Export did not return a job ID; inspect jobs before retrying.');
      let finished = false;
      for (let poll = 0; poll < 20; poll++) {
        ctx.signal.throwIfAborted();
        const jobs = resultData(await capture('filmcraft_jobs_list')) as any;
        const job = Array.isArray(jobs) ? jobs.find(j => j.id === started.job) : undefined;
        if (job?.finished === true) {
          if (!job.result || job.result.error || job.offlineMedia?.length) throw new Error(`Export job ${started.job} finished with an error or offline media. Inspect its job report.`);
          const { result: output, ...jobStatus } = job;
          const frameRate = (observed.get('filmcraft_inspect') as any)?.sequence?.settings?.frame_rate;
          const fps = Number(args.fps ?? (frameRate?.num / frameRate?.den));
          completed.push({ name: 'filmcraft_jobs_list', purpose: 'The controller waited for this export to finish and checked for errors and offline media. wait:false controls only the initial API call. Render elapsed time is not media duration.', exportJob: started.job, verified: true, job: jobStatus,
            output: { path: output.path, frames: output.frames, bytes: output.bytes, renderElapsedSeconds: output.seconds,
              ...(Number.isFinite(fps) && fps > 0 && Number.isFinite(output.frames) ? { mediaDurationSeconds: output.frames / fps } : {}),
            },
          });
          ctx.say(`Export job ${started.job} completed: ${job.result.path ?? started.path}`);
          finished = true;
          break;
        }
        await delay(Math.min(1000 * (poll + 1), 5000), undefined, { signal: ctx.signal });
      }
      if (!finished) throw new Error(`Export job ${started.job} is still running. Check jobs; do not start another export.`);
    }
    if (!tool.annotations?.readOnlyHint) {
      const before = observed.get('filmcraft_inspect');
      await capture('filmcraft_inspect');
      completedStep.inspection = { tool: 'filmcraft_inspect', completed: true, evidence: 'stateChanges compares native state immediately before and after this action.' };
      completedStep.stateChanges = timelineChanges(before, observed.get('filmcraft_inspect'));
      await ctx.trace?.('jev.state_changes', completedStep.stateChanges);
      if (action.startsWith('filmcraft_caption')) completedStep.captions = resultData(await capture('filmcraft_captions_list'));
      const verification = verifyEdit(action, args, before, observed.get('filmcraft_inspect'));
      if (verification) {
        completedStep.verification = verification;
        await ctx.trace?.('jev.verification', verification);
        if (!verification.passed) throw new Error(`The ${action} call returned, but its timeline result did not match: ${verification.checks.filter(c => !c.passed).map(c => c.property).join(', ')}. Inspect the changes before retrying.`);
      }
      if (ctx.tools.some(t => t.name === 'filmcraft_ui_screenshot')) await capture('filmcraft_ui_screenshot', { max_side: 1200 });
    }
  }
  throw new Error('Stopped after 12 Jev actions. Review the results before continuing.');
}
