import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const id = z.number().int().positive().safe();
export const index = z.number().int().nonnegative().safe();
export const seconds = z.number().finite().nonnegative();
export const ticks = z.number().int().safe().describe('Exact FilmCraft ticks; 254016000000 per second. Use seconds/frame for long timelines.');
export const track = z.union([id, z.string().regex(/^[VACSM]\d+$|^Mix$/)]);
export const object = z.record(z.string(), z.unknown());
export const path = z.string().min(1).refine(isAbsolute, 'Use an absolute filesystem path');
export const clips = z.array(id).min(1).max(1000);
export const time = { seconds: seconds.optional(), frame: index.optional(), timecode: z.string().optional(), time: ticks.optional() };
export const empty = z.strictObject({});
export const command = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(160);

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', io: 'input' });
}
