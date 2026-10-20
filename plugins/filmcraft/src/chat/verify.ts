import type { Params } from '../core.js';

const TICKS_PER_SECOND = 254016000000;
type Check = { property: string; expected: unknown; actual: unknown; passed: boolean };
export interface Verification { scope: string; passed: boolean; checks: Check[] }

/** Verify supported tool arguments against fresh native state, independently of model confidence.
 * This verifies the executed arguments, not whether those arguments express the whole user request. */
export function verifyEdit(action: string, args: Params, before: any, after: any): Verification | undefined {
  const fps = after?.sequence?.settings?.frame_rate;
  if (!before?.sequence || !after?.sequence || !(fps?.num > 0) || !(fps?.den > 0)) return;
  const clips = (document: any) => ['video', 'audio'].flatMap(kind => (document.sequence[kind] ?? []).flatMap((track: any, index: number) =>
    (track.items ?? []).map((clip: any) => ({ ...clip, trackId: track.id, trackIndex: index, trackKind: kind }))));
  const previous = clips(before), current = clips(after);
  const checks: Check[] = [];
  const check = (property: string, expected: unknown, actual: unknown, tolerance = 0) => checks.push({ property, expected, actual,
    passed: typeof expected === 'number' && typeof actual === 'number' ? Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance : JSON.stringify(expected) === JSON.stringify(actual) });
  if (['filmcraft_transition_video', 'filmcraft_transition_audio'].includes(action) && ['in', 'out'].includes(String(args.edge))) {
    const kind = action === 'filmcraft_transition_video' ? 'video' : 'audio';
    const transitions = (after.sequence[kind] ?? []).flatMap((track: any) => track.transitions ?? []);
    const matches = transitions.filter((t: any) => args.edge === 'in' ? t.to === args.clip && t.align === 'start' : t.from === args.clip && t.align === 'end');
    check('transition at requested clip edge', 1, matches.length);
    const transition = matches[0];
    if (args.effect !== undefined) check('transition effect', args.effect, transition?.effect);
    if (args.frames !== undefined) check('transition duration frames', Number(args.frames), transition ? Number(transition.duration) * fps.num / fps.den / TICKS_PER_SECOND : undefined, 0.0001);
    if (args.reverse !== undefined) check('transition reversed', args.reverse, transition?.reverse);
    check('clip count', previous.length, current.length);
    for (const clip of previous) {
      check(`clip ${clip.clip} start frame`, clip.startFrame, current.find(c => c.clip === clip.clip)?.startFrame);
      check(`clip ${clip.clip} duration frames`, clip.durationFrames, current.find(c => c.clip === clip.clip)?.durationFrames);
    }
  } else if (action === 'filmcraft_clip_split' && args.clip !== undefined && !args.timecode) {
    const was = previous.find(c => c.clip === args.clip);
    if (!was) check('target clip exists', true, false);
    else {
      const frame = args.frame !== undefined ? Number(args.frame) : Math.round((args.seconds !== undefined ? Number(args.seconds) : Number(args.time ?? before.sequence.playhead) / TICKS_PER_SECOND) * fps.num / fps.den);
      const pieces = current.filter(c => c.trackKind === was.trackKind && c.trackIndex === was.trackIndex && c.item === was.item &&
        c.startFrame >= was.startFrame && c.startFrame + c.durationFrames <= was.startFrame + was.durationFrames);
      check('pieces after split', 2, pieces.length);
      check('left piece duration frames', frame - was.startFrame, pieces.find(c => c.startFrame === was.startFrame)?.durationFrames);
      check('right piece duration frames', was.startFrame + was.durationFrames - frame, pieces.find(c => c.startFrame === frame)?.durationFrames);
      check('total retained frames', was.durationFrames, pieces.reduce((n, c) => n + c.durationFrames, 0));
      for (const clip of previous.filter(c => c.clip !== args.clip && (!was.link || c.link !== was.link))) check(`clip ${clip.clip} start frame`, clip.startFrame, current.find(c => c.clip === clip.clip)?.startFrame);
    }
  } else if (action === 'filmcraft_clip_move' && args.copy !== true && Array.isArray(args.moves)) {
    for (const move of args.moves as any[]) {
      const was = previous.find(c => c.clip === move.clip), now = current.find(c => c.clip === move.clip);
      check(`clip ${move.clip} position ticks`, Number(move.time), now ? Number(now.start) : undefined, 1);
      if (typeof move.track === 'number') check(`clip ${move.clip} track ID`, move.track, now?.trackId);
      else if (/^[VA]\d+$/.test(String(move.track))) check(`clip ${move.clip} track`, move.track, now ? `${now.trackKind === 'video' ? 'V' : 'A'}${now.trackIndex + 1}` : undefined);
      if (was && args.linked !== false) for (const partner of previous.filter(c => was.link && c.link === was.link && !(args.moves as any[]).some(m => m.clip === c.clip))) {
        const actual = current.find(c => c.clip === partner.clip);
        check(`linked clip ${partner.clip} position ticks`, Number(partner.start) + Number(move.time) - Number(was.start), actual ? Number(actual.start) : undefined, 1);
      }
    }
  } else if (['filmcraft_selection_delete', 'filmcraft_selection_ripple_delete'].includes(action) && Array.isArray(args.clips)) {
    const ids = args.clips;
    const links = args.linked === false ? [] : previous.filter(c => ids.includes(c.clip) && c.link).map(c => c.link);
    const removed = previous.filter(c => ids.includes(c.clip) || links.includes(c.link));
    check('target clips exist before deletion', true, args.clips.every(id => previous.some(c => c.clip === id)));
    for (const clip of removed) check(`clip ${clip.clip} removed`, true, !current.some(c => c.clip === clip.clip));
    check('remaining clip count', previous.length - removed.length, current.length);
    if (action === 'filmcraft_selection_delete') for (const clip of previous.filter(c => !removed.includes(c))) check(`clip ${clip.clip} start frame`, clip.startFrame, current.find(c => c.clip === clip.clip)?.startFrame);
  } else if (action === 'filmcraft_clip_trim' && (!args.mode || args.mode === 'regular')) {
    const was = previous.find(c => c.clip === args.clip), now = current.find(c => c.clip === args.clip);
    if (!was || !now) check('target clip exists', true, false);
    else {
      const delta = Number(args.deltaFrames);
      check('duration change in frames', args.edge === 'in' ? -delta : delta, now.durationFrames - was.durationFrames);
      check('start frame', was.startFrame + (args.edge === 'in' ? delta : 0), now.startFrame);
      check('clip count', previous.length, current.length);
      for (const clip of previous.filter(c => c.clip !== args.clip && (!was.link || c.link !== was.link))) {
        check(`clip ${clip.clip} start frame`, clip.startFrame, current.find(c => c.clip === clip.clip)?.startFrame);
      }
    }
  } else if (action === 'filmcraft_audio_gain' && ['set', 'adjust'].includes(String(args.mode)) && Array.isArray(args.clips)) {
    for (const id of args.clips) {
      const was = previous.find(c => c.clip === id), now = current.find(c => c.clip === id);
      check(`clip ${id} gain dB`, (args.mode === 'adjust' ? was?.gainDb : 0) + Number(args.db), now?.gainDb, 0.0001);
    }
  } else if (action === 'filmcraft_marker_add' && (!args.target || args.target === 'program') && !args.timecode) {
    const added = (after.sequence.markers ?? []).filter((m: any) => !(before.sequence.markers ?? []).some((p: any) => p.id === m.id));
    check('new marker count', 1, added.length);
    const marker = added[0];
    if (args.name !== undefined) check('marker name', args.name, marker?.name);
    const ticks = args.time !== undefined ? Number(args.time) : args.seconds !== undefined ? Math.round(Number(args.seconds) * TICKS_PER_SECOND) :
      args.frame !== undefined ? Math.round(Number(args.frame) * TICKS_PER_SECOND * fps.den / fps.num) : Number(before.sequence.playhead);
    check('marker position ticks', ticks, marker ? Number(marker.start) : undefined, 1);
  } else if (action === 'filmcraft_title_create' && args.newClip === true) {
    const added = current.filter(c => !previous.some(p => p.clip === c.clip));
    check('new title clip count', 1, added.length);
    const clip = added[0];
    const encoded = clip?.effects?.find((e: any) => e.effect === 'graphic_text')?.params?.text?.value;
    let text: unknown;
    if (typeof encoded === 'string' && encoded.startsWith('Text(') && encoded.endsWith(')')) {
      try { text = JSON.parse(encoded.slice(5, -1)); } catch { /* An unrecognized native value cannot verify the title. */ }
    }
    check('title text', args.text, text);
    if (args.track !== undefined) check('video track index', args.track, clip?.trackKind === 'video' ? clip.trackIndex : undefined);
    if (args.seconds !== undefined) check('title duration frames', Math.round(Number(args.seconds) * fps.num / fps.den), clip?.durationFrames);
    check('title start ticks', Number(args.time ?? before.sequence.playhead), clip ? Number(clip.start) : undefined, 1);
  } else return;
  return { scope: 'Executed tool arguments checked against fresh native timeline state; whole-request completion is assessed separately.', passed: checks.every(c => c.passed), checks };
}
