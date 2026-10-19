import { z } from 'zod';
import type { Mode, Params } from '../core.js';
import { clips, command, empty, id, index, jsonSchema, object, path, seconds, ticks, time, track } from './schema.js';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  group: string;
  native?: string;
  command?: string;
  bridgeOnly?: boolean;
  readOnly?: boolean;
  map?: (args: Params) => Params;
}

const engine = (name: string, group: string, cmd: string, description: string, schema: z.ZodType, readOnly = false): ToolDefinition =>
  ({ name: `filmcraft_${name}`, group, command: cmd, description, schema, readOnly });
const native = (name: string, group: string, tool: string, description: string, schema: z.ZodType, readOnly = false, bridgeOnly = false): ToolDefinition =>
  ({ name: `filmcraft_${name}`, group, native: tool, description, schema, readOnly, bridgeOnly });
const effect = z.union([z.string().min(1), index]);
const delta = { deltaFrames: z.number().int().safe() };
const transition = z.strictObject({ clip: id, effect: z.string().optional(), frames: index.positive().optional(), edge: z.enum(['in', 'out']).optional(), params: object.optional(), reverse: z.boolean().optional() });

/** One registry drives HTTP validation, OpenAPI, and MCP schemas. No editing logic lives here. */
export const tools: ToolDefinition[] = [
  native('commands', 'discovery', 'command_list', 'Search the complete live FilmCraft command catalog, including parameter documentation and enabled state. Discover advanced editing, multicam, proxies, masks, LUTs, audio automation, interchange, and every other engine command here; use filmcraft_execute to run it. Results are paginated.', z.strictObject({ filter: z.string().optional(), enabled_only: z.boolean().optional(), offset: index.default(0), limit: index.positive().max(500).default(50) }), true),
  native('execute', 'discovery', 'command_run', 'Execute any FilmCraft command by its exact id and params from filmcraft_commands. Preserves native undo and validation. Explicit clip/item IDs avoid reliance on selection. For exports use wait:false and poll jobs. Never retry an ambiguous transport failure without inspection.', z.strictObject({ id: command, params: object.default({}) })),
  native('batch', 'discovery', 'command_batch', 'Run up to 100 ordered engine commands. Stops on error by default. NOT atomic: successful steps remain applied and each edit has its own undo entry. Returns partial results on failure.', z.strictObject({ steps: z.array(z.strictObject({ id: command, params: object.optional() })).min(1).max(100), stop_on_error: z.boolean().default(true) })),
  native('inspect', 'project', 'doc_inspect', 'Inspect the persistent project and active sequence, including bins, media IDs, clips, tracks, effects, markers, selection and playhead. Start here before editing.', empty, true),
  engine('project_new', 'project', 'file.newProject', 'Create an empty project in this session. Save existing work first.', z.strictObject({ name: z.string().min(1) })),
  engine('project_open', 'project', 'file.open', 'Open a .fcproj file in this session. Save existing work first.', z.strictObject({ path })),
  engine('project_save', 'project', 'file.save', 'Save the project atomically. Provide an absolute path on the first save.', z.strictObject({ path: path.optional() })),
  engine('bin_create', 'project', 'file.newBin', 'Create a named project bin; optional parent bin ID.', z.strictObject({ name: z.string().min(1), parent: id.optional() })),
  native('media_import', 'media', 'media_import', 'Import video, audio, stills or numbered image sequences from absolute paths on the FilmCraft host. Returns native item IDs for placement.', z.strictObject({ paths: z.array(path).min(1).max(1000), bin: id.optional(), image_sequence: z.boolean().optional() })),
  engine('media_status', 'media', 'media.status', 'Inspect media availability and proxy status. Use filmcraft_commands with media. for relinking, proxies and missing-media operations.', empty, true),
  engine('sequence_create', 'sequence', 'file.newSequence', 'Create and activate a sequence. fromItem/fromItems can derive settings from imported media and assemble clips automatically.', z.strictObject({ name: z.string().min(1), width: index.positive().max(16384).optional(), height: index.positive().max(16384).optional(), fps: z.number().positive().max(240).optional(), sampleRate: index.positive().optional(), video: index.max(256).optional(), audio: index.max(256).optional(), mix: z.enum(['Stereo', 'Mono', '5.1', 'Adaptive']).optional(), trackType: z.enum(['Standard', 'Mono', '5.1', 'Adaptive']).optional(), fromItem: id.optional(), fromItems: clips.optional() })),
  engine('sequence_open', 'sequence', 'sequence.open', 'Activate an existing sequence by its project item ID.', z.strictObject({ item: id })),
  engine('sequence_inspect', 'sequence', 'sequence.inspect', 'Inspect the active sequence or one named by item ID.', z.strictObject({ item: id.optional() }), true),
  engine('tracks_add', 'sequence', 'sequence.addTracks', 'Add video/audio tracks to the active sequence.', z.strictObject({ video: index.max(256).optional(), audio: index.max(256).optional() })),
  engine('clip_place', 'timeline', 'timeline.place', 'Place an imported item onto the timeline, preserving linked audio/video by default. seconds/frame/timecode locate the destination; sourceIn and duration are exact ticks. insert:true ripples following material.', z.strictObject({ item: id, track: z.union([track, z.literal('new')]).optional(), audioTrack: z.union([track, z.literal('new')]).optional(), ...time, insert: z.boolean().optional(), sourceIn: ticks.nonnegative().optional(), duration: ticks.positive().optional(), video: z.boolean().optional(), audio: z.boolean().optional() })),
  engine('clip_select', 'timeline', 'timeline.select', 'Select timeline clip IDs; an empty list clears selection. linked defaults to true.', z.strictObject({ clips: z.array(id).max(1000), add: z.boolean().optional(), toggle: z.boolean().optional(), linked: z.boolean().optional() })),
  engine('clip_move', 'timeline', 'timeline.move', 'Move or copy clips to explicit tracks and exact tick positions. Linked partners move together unless linked:false. insert:true ripples; default overwrites.', z.strictObject({ moves: z.array(z.strictObject({ clip: id, track: z.union([track, z.literal('new')]), time: ticks.nonnegative() })).min(1).max(1000), insert: z.boolean().optional(), linked: z.boolean().optional(), copy: z.boolean().optional() })),
  engine('clip_split', 'timeline', 'timeline.razor', 'Split at a timeline time, optionally on one track or clip. Follow with sequence_inspect to discover new clip IDs.', z.strictObject({ ...time, clip: id.optional(), track: track.optional() })),
  engine('clip_trim', 'timeline', 'timeline.trim', 'Trim a clip edge by a signed number of sequence frames. Regular changes the edge; ripple shifts following material.', z.strictObject({ clip: id, edge: z.enum(['in', 'out']), mode: z.enum(['regular', 'ripple']).default('regular'), ...delta })),
  engine('clip_roll', 'timeline', 'timeline.roll', 'Roll the shared edit between left and right clips by signed sequence frames.', z.strictObject({ left: id, right: id, ...delta, followLinks: z.boolean().optional() })),
  engine('clip_slip', 'timeline', 'timeline.slip', 'Shift source content inside a clip without moving its timeline placement.', z.strictObject({ clip: id, ...delta })),
  engine('clip_slide', 'timeline', 'timeline.slide', 'Slide a clip and adjust its neighboring edit points.', z.strictObject({ clip: id, ...delta })),
  engine('clip_speed', 'timeline', 'clip.speedDuration', 'Set speed as a percentage (100 = normal), reverse playback and optional ripple/interpolation.', z.strictObject({ clips, speed: z.number().positive(), reverse: z.boolean().optional(), ripple: z.boolean().optional(), interpolation: z.enum(['frameSampling', 'frameBlending', 'opticalFlow']).optional() })),
  engine('selection_delete', 'timeline', 'edit.clear', 'Delete the current selection, leaving a gap. Use clip_select with explicit IDs first.', empty),
  engine('selection_ripple_delete', 'timeline', 'edit.rippleDelete', 'Delete the selected clips/captions and close the gap. Use clip_select with explicit IDs first.', empty),
  engine('playhead_set', 'timeline', 'playhead.set', 'Seek the program playhead by seconds, frame, timecode or ticks.', z.strictObject(time)),
  engine('undo', 'history', 'edit.undo', 'Undo the last engine edit.', empty),
  engine('redo', 'history', 'edit.redo', 'Redo the last undone engine edit.', empty),
  engine('effects_list', 'effects', 'effects.list', 'List native effect IDs for video, audio, color, motion and transitions. detail:true includes parameter definitions; filter by kind/folder to keep output manageable.', z.strictObject({ kind: z.enum(['Video', 'Audio', 'VideoTransition', 'AudioTransition']).optional(), folder: z.string().optional(), detail: z.boolean().optional() }), true),
  engine('effect_apply', 'effects', 'effects.apply', 'Apply an effect by ID or name to explicit clips. Use effects_list first. Lumetri is lumetri; audio effects target audio clips or linked audio.', z.strictObject({ clips, effect: z.string().min(1) })),
  engine('effect_set', 'effects', 'effects.setParam', 'Set an effect parameter, including motion, opacity, Lumetri color or audio DSP. keyframe:true animates at timeline time in ticks. Use effect IDs/names or instance indices from inspection.', z.strictObject({ clip: id, effect, param: z.string().min(1), value: z.unknown(), time: ticks.optional(), keyframe: z.boolean().optional(), mask: index.optional() })),
  engine('effect_remove', 'effects', 'effects.remove', 'Remove an effect instance by its index on the clip.', z.strictObject({ clip: id, index })),
  engine('transition_video', 'effects', 'sequence.applyVideoTransition', 'Apply a video transition (default cross dissolve) to a clip edge.', transition),
  engine('transition_audio', 'audio', 'sequence.applyAudioTransition', 'Apply an audio transition (default constant power) to a clip edge.', transition),
  engine('audio_gain', 'audio', 'clip.audioGain', 'Set/adjust clip gain in dB or normalize audio peaks.', z.strictObject({ clips, mode: z.enum(['set', 'adjust', 'normalizeMax', 'normalizeAll']), db: z.number().finite() })),
  engine('mixer_inspect', 'audio', 'mixer.inspect', 'Inspect audio tracks, submixes, inserts, sends and automation.', empty, true),
  engine('mixer_set', 'audio', 'mixer.setStrip', 'Set an audio mixer strip. volumeDb is dB; pan is -1..1. More routing and automation commands are discoverable under mixer.', z.strictObject({ strip: track, volumeDb: z.number().finite().optional(), pan: z.number().min(-1).max(1).optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), mode: z.enum(['Off', 'Read', 'Latch', 'Touch', 'Write']).optional() })),
  engine('title_create', 'graphics', 'graphics.newText', 'Create a title/text graphic. Here seconds is DURATION, time is timeline start in ticks (default playhead), and track is a zero-based video track index. Returns clip/layer IDs for graphic_set.', z.strictObject({ text: z.string(), track: index.optional(), time: ticks.nonnegative().optional(), seconds: seconds.positive().optional(), position: z.tuple([z.number().finite(), z.number().finite()]).optional(), size: z.number().positive().optional(), font: z.string().optional(), fontStyle: z.string().optional(), newClip: z.boolean().optional() })),
  engine('graphic_set', 'graphics', 'graphics.set', 'Style a graphic layer with native props: font, font_style, size, fill_color, position, scale, rotation, opacity, stroke, shadow and more. Discover all graphics operations with commands filter graphics.', z.strictObject({ clip: id, layer: z.union([index, z.string()]).optional(), props: object, time: ticks.optional() })),
  engine('captions_list', 'captions', 'captions.list', 'Inspect caption tracks and caption IDs/timings.', z.strictObject({ track: track.optional() }), true),
  engine('caption_add', 'captions', 'captions.add', 'Add a caption, creating a subtitle track if necessary.', z.strictObject({ text: z.string(), track: track.optional(), seconds: seconds.optional(), durationSeconds: seconds.positive().default(3) })),
  engine('caption_set_text', 'captions', 'captions.setText', 'Edit caption text and optional speaker.', z.strictObject({ caption: id, text: z.string(), speaker: z.string().nullable().optional() })),
  engine('captions_import', 'captions', 'captions.import', 'Import an SRT, WebVTT or SCC caption file.', z.strictObject({ path, name: z.string().optional() })),
  engine('captions_export', 'captions', 'captions.export', 'Export captions to a subtitle file; native format is inferred from path unless supplied.', z.strictObject({ path, track: track.optional(), format: z.enum(['srt', 'vtt', 'scc']).optional() })),
  engine('marker_add', 'markers', 'markers.add', 'Add a named marker/comment at a program/source time.', z.strictObject({ ...time, target: z.enum(['program', 'source']).default('program'), name: z.string().optional(), comment: z.string().optional(), color: z.string().optional(), durationFrames: index.optional() })),
  engine('export_start', 'export', 'file.exportMedia', 'Start a background export and return its job ID. Poll filmcraft_jobs_list until done/failed/cancelled; inspect offlineMedia and errors before calling delivery successful. settings accepts native ExportSettings. No automatic retry.', z.strictObject({ path, format: z.enum(['h264', 'hevc', 'prores', 'dnxhr', 'apv', 'mjpeg', 'mxf-op1a', 'mxf-opatom', 'png', 'tiff', 'bmp', 'jpg', 'tga', 'dpx', 'exr', 'gif', 'wav', 'aiff', 'aac', 'flac']).optional(), preset: z.string().optional(), settings: object.optional(), width: index.positive().optional(), height: index.positive().optional(), fps: z.number().positive().optional(), scale: z.number().positive().max(4).optional(), audio: z.boolean().optional(), quality: z.number().min(0).max(100).optional(), burnCaptions: z.boolean().optional(), range: z.enum(['entire', 'inOut', 'workArea', 'custom']).optional(), startSeconds: seconds.optional(), endSeconds: seconds.optional(), wait: z.literal(false).default(false) })),
  engine('jobs_list', 'export', 'jobs.list', 'Inspect background jobs, progress, output, failures and cancellation status.', empty, true),
  engine('jobs_cancel', 'export', 'jobs.cancel', 'Request cancellation of a background job by ID; poll jobs_list for its final status.', z.strictObject({ job: id })),
  engine('interchange_export', 'interchange', 'file.exportInterchange', 'Export an editing timeline to a native interchange format. Discover available formats and options through commands filter file.exportInterchange.', z.strictObject({ path, format: z.string().optional() })),
  native('render_preview', 'preview', 'render_preview', 'Return an actual PNG image of the active timeline at seconds (or current playhead). Preserves playhead and selection. Use after edits for visual feedback; bridge mode needs a visible desktop window.', z.strictObject({ seconds: seconds.optional(), max_side: index.positive().max(4096).default(960) }), true),
  native('ui_inspect', 'desktop', 'ui_inspect', 'Inspect the running FilmCraft desktop.', empty, true, true),
  native('ui_elements', 'desktop', 'ui_elements', 'Discover visible UI automation IDs, labels and positions.', z.strictObject({ prefix: z.string().optional() }), true, true),
  native('ui_control', 'desktop', 'ui_control', 'Call any desktop control API: ui.set, ui.click, ui.drag, ui.key, ui.type, ui.playback, ui.scroll, ui.panel.show, etc. Discover IDs with ui_elements. Only available in bridge mode.', z.strictObject({ method: command, params: object.default({}) }), false, true),
  native('ui_screenshot', 'desktop', 'ui_screenshot', 'Return a PNG screenshot of the desktop or one named panel.', z.strictObject({ panel: z.string().optional(), max_side: index.positive().max(4096).default(1600) }), true, true),
];

export function availableTools(mode: Mode) {
  return tools.filter(tool => !tool.bridgeOnly || mode === 'bridge');
}

export function describeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    title: tool.name.replace('filmcraft_', '').replaceAll('_', ' '),
    description: tool.description,
    inputSchema: jsonSchema(tool.schema),
    annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !tool.readOnly, idempotentHint: !!tool.readOnly, openWorldHint: true },
  };
}
