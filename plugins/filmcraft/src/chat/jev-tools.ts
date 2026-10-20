import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Params } from '../core.js';

/** A single move is a common edit. Jev selects its scalar arguments; this adapter
 * builds the native moves array without asking the model to generate JSON. */
export function jevTools(tools: Tool[], explicit: Params): Tool[] {
  return tools.map(tool => {
    if (['filmcraft_selection_delete', 'filmcraft_selection_ripple_delete'].includes(tool.name)) {
      return { ...tool, description: `Delete the specified timeline clips and their linked audio/video partners. ${tool.name.endsWith('ripple_delete') ? 'Close the resulting gap by rippling later clips.' : 'Leave the gap and preserve later clip positions.'} The controller selects these exact IDs before deleting.`,
        inputSchema: { type: 'object', additionalProperties: false, required: ['clips'], properties: {
          clips: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'integer', minimum: 1 }, description: 'Explicit timeline clip IDs to delete.' },
          linked: { type: 'boolean', default: true, description: 'Also delete linked audio/video partners. Set false only when the request excludes linked partners.' },
        } } };
    }
    const properties = tool.inputSchema.properties as Record<string, any> | undefined;
    const move = properties?.moves?.items?.properties;
    if (tool.name !== 'filmcraft_clip_move' || !move || Object.hasOwn(explicit, 'moves')) return tool;
    return { ...tool, description: 'Move or copy one existing timeline clip. Linked audio/video partners move with it unless linked:false. Omitted track or position preserves the current value. seconds is the new absolute timeline position; time is exact ticks. insert:true ripples; default overwrites.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['clip'], properties: {
        clip: { ...move.clip, description: 'Existing timeline clip ID to move, from inspection.' },
        track: { ...move.track, description: 'Destination track label such as V2 or A1, or its inspected track ID. Use new only when the user requests a new track.' },
        seconds: { type: 'number', minimum: 0, description: 'New absolute timeline position in seconds. Omit time when using seconds.' },
        time: { ...move.time, description: 'New absolute timeline position in exact ticks. Omit when the position is given in seconds.' },
        linked: { ...properties!.linked, default: true, description: 'Move linked audio/video partners too. False only when explicitly excluded.' },
        insert: { ...properties!.insert, default: false, description: 'True for ripple insertion; false for normal placement.' },
        copy: { ...properties!.copy, default: false, description: 'True to create a duplicate; false to move the original clip.' },
      } } };
  });
}

export function nativeMoveArguments(args: Params, document: any): Params {
  const tracks = [...document?.sequence?.video ?? [], ...document?.sequence?.audio ?? []];
  const sourceTrack = tracks.find((track: any) => track.items?.some((clip: any) => clip.clip === args.clip));
  const source = sourceTrack?.items.find((clip: any) => clip.clip === args.clip);
  if (!source) throw new Error('The clip to move is no longer present. Inspect the timeline before retrying.');
  if (args.seconds !== undefined && args.time !== undefined) throw new Error('Specify a move position in seconds or ticks, not both.');
  const time = args.seconds !== undefined ? Math.round(Number(args.seconds) * 254016000000) : Number(args.time ?? source.start);
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('The move position is outside the supported safe tick range.');
  const { clip, track, seconds, time: ignoredTime, ...options } = args;
  return { moves: [{ clip, track: track ?? sourceTrack.id, time }], ...options };
}
