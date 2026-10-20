import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const id = z.number().int().positive().safe();
export const index = z.number().int().nonnegative().safe();
export const seconds = z.number().finite().nonnegative();
export const ticks = z.number().int().safe().describe('Exact FilmCraft ticks; 254016000000 per second. Use seconds/frame for long timelines.');
export const track = z.union([id, z.string().regex(/^[VACSM]\d+$|^Mix$/)]);
export const object = z.record(z.string(), z.unknown());
export const path = z.string().min(1).refine(isAbsolute, 'Use an absolute filesystem path').describe('Absolute file path supplied by the user on the FilmCraft host.');
export const clips = z.array(id).min(1).max(1000).describe('Existing timeline clip IDs from inspection, not project media IDs, track IDs, durations or frame counts.');
export const time = {
  seconds: seconds.describe('Timeline position in seconds. Supply when the requested position is in seconds; omit frame, timecode and time.').optional(),
  frame: index.describe('Absolute timeline frame number. Supply only for a position explicitly expressed in frames; omit other position units.').optional(),
  timecode: z.string().describe('Timeline position as a timecode string such as 00:00:02:00. Omit for positions given in seconds or frames.').optional(),
  time: ticks.describe('Timeline position in exact ticks (254016000000 per second). Omit when using seconds, frame or timecode.').optional(),
};
export const empty = z.strictObject({});
export const command = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(160);

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', io: 'input' });
}
