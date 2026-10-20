import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEdit } from '../src/chat/verify.js';

function project() {
  return { sequence: { settings: { frame_rate: { num: 30, den: 1 } }, playhead: 0, markers: [] as any[],
    video: [{ items: [{ clip: 12, start: 0, startFrame: 0, durationFrames: 100, gainDb: 0, link: 5 }] }, { items: [] as any[] }],
    audio: [{ items: [{ clip: 13, start: 0, startFrame: 0, durationFrames: 100, gainDb: -3, link: 5 }] }],
  } };
}

test('trim verification measures the actual frame delta and rejects a no-op success', () => {
  const before = project(), after = project();
  const args = { clip: 12, edge: 'out', deltaFrames: -12, mode: 'regular' };
  assert.equal(verifyEdit('filmcraft_clip_trim', args, before, after)?.passed, false);
  after.sequence.video[0]!.items[0]!.durationFrames = 88;
  after.sequence.audio[0]!.items[0]!.durationFrames = 88;
  assert.equal(verifyEdit('filmcraft_clip_trim', args, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_clip_trim', { ...args, mode: 'ripple' }, before, after), undefined);
});

test('gain verification distinguishes relative adjustment from absolute gain', () => {
  const before = project(), after = project();
  after.sequence.audio[0]!.items[0]!.gainDb = -5;
  assert.equal(verifyEdit('filmcraft_audio_gain', { clips: [13], db: -2, mode: 'adjust' }, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_audio_gain', { clips: [13], db: -2, mode: 'set' }, before, after)?.passed, false);
  assert.equal(verifyEdit('filmcraft_audio_gain', { clips: [99], db: -2, mode: 'set' }, before, after)?.passed, false);
});

test('marker verification requires a new marker at the requested position', () => {
  const before = project(), after = project();
  after.sequence.markers.push({ id: 20, name: 'Point', start: 508032000000 });
  assert.equal(verifyEdit('filmcraft_marker_add', { seconds: 2, name: 'Point' }, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_marker_add', { seconds: 3, name: 'Point' }, before, after)?.passed, false);
  assert.equal(verifyEdit('filmcraft_marker_add', { seconds: 2, name: 'Point' }, after, after)?.passed, false);
});

test('title verification checks actual text, duration, start and track', () => {
  const before = project(), after = project();
  const args = { text: 'A title', newClip: true, track: 1, time: 0, seconds: 2 };
  after.sequence.video[1]!.items.push({ clip: 21, start: 0, durationFrames: 60, effects: [{ effect: 'graphic_text', params: { text: { value: 'Text("A title")' } } }] });
  assert.equal(verifyEdit('filmcraft_title_create', args, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_title_create', { ...args, text: 'Different' }, before, after)?.passed, false);
  assert.equal(verifyEdit('filmcraft_title_create', { ...args, track: 0 }, before, after)?.passed, false);
});

test('transition verification distinguishes clip edge, effect, and frame length', () => {
  const before = project() as any, after = project() as any;
  after.sequence.video[0].transitions = [{ to: 12, from: null, align: 'start', effect: 'cross_dissolve', duration: 101606400000, reverse: false }];
  const args = { clip: 12, edge: 'in', effect: 'cross_dissolve', frames: 12, reverse: false };
  assert.equal(verifyEdit('filmcraft_transition_video', args, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_transition_video', { ...args, frames: 20 }, before, after)?.passed, false);
  assert.equal(verifyEdit('filmcraft_transition_video', { ...args, edge: 'out' }, before, after)?.passed, false);
  assert.equal(verifyEdit('filmcraft_transition_video', { ...args, effect: 'different' }, before, after)?.passed, false);
});

test('split verification requires both pieces at the requested boundary', () => {
  const before = project() as any, after = project() as any;
  before.sequence.video[0].items[0].item = 1;
  after.sequence.video[0].items = [{ ...before.sequence.video[0].items[0], durationFrames: 60 }, { ...before.sequence.video[0].items[0], clip: 20, startFrame: 60, durationFrames: 40 }];
  assert.equal(verifyEdit('filmcraft_clip_split', { clip: 12, seconds: 2 }, before, after)?.passed, true);
  after.sequence.video[0].items.pop();
  assert.equal(verifyEdit('filmcraft_clip_split', { clip: 12, seconds: 2 }, before, after)?.passed, false);
});

test('move and delete checks include linked partners and preserve unrelated clips', () => {
  const before = project() as any, after = project() as any;
  after.sequence.video[0].items[0].start = 508032000000;
  const move = { moves: [{ clip: 12, track: 'V1', time: 508032000000 }] };
  assert.equal(verifyEdit('filmcraft_clip_move', move, before, after)?.passed, false, 'Linked audio did not move');
  after.sequence.audio[0].items[0].start = 508032000000;
  assert.equal(verifyEdit('filmcraft_clip_move', move, before, after)?.passed, true);
  after.sequence.video[0].items = [];
  assert.equal(verifyEdit('filmcraft_selection_delete', { clips: [12] }, before, after)?.passed, false);
  after.sequence.audio[0].items = [];
  assert.equal(verifyEdit('filmcraft_selection_delete', { clips: [12] }, before, after)?.passed, true);
  assert.equal(verifyEdit('filmcraft_clip_move', { ...move, copy: true }, before, after), undefined);
});
