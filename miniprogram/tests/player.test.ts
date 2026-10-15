import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalPlayer, type NativeAudio } from '../src/audio/player.ts';
import type { AudioLease } from '../src/audio/downloads.ts';

function setup() {
  const events: Record<string, () => void> = {}; let released = false; let destroyed = 0;
  let releaseCallback = () => {}; let seeks = 0; let plays = 0;
  const audio: NativeAudio = { src: '', startTime: 0, autoplay: false, loop: false, playbackRate: 1,
    currentTime: 0, duration: 10, play() { plays++; events.play?.(); }, pause() { events.pause?.(); },
    stop() { events.stop?.(); }, seek(seconds) { seeks++; audio.currentTime = seconds; }, destroy() { destroyed++; },
    onCanplay(fn) { events.canplay = fn; }, onPlay(fn) { events.play = fn; }, onPause(fn) { events.pause = fn; },
    onStop(fn) { events.stop = fn; }, onEnded(fn) { events.ended = fn; }, onError(fn) { events.error = fn; },
    onTimeUpdate(fn) { events.time = fn; }, onWaiting(fn) { events.waiting = fn; }, onSeeked(fn) { events.seeked = fn; } };
  const lease: AudioLease = { get path() { if (released) throw new Error('expired'); return 'wxfile://audio'; },
    release() { if (!released) { released = true; releaseCallback(); } },
    onRelease(fn) { releaseCallback = fn; return () => { releaseCallback = () => {}; }; } };
  const player = new LocalPlayer(() => audio);
  return { audio, lease, player, events, seeks: () => seeks, plays: () => plays,
    released: () => released, destroyed: () => destroyed,
    async load() { const ready = player.load(lease); assert.equal(player.getSnapshot().phase, 'loading');
      events.canplay(); await ready; } };
}

test('load waits for canplay, seek waits for native confirmation, rate changes are checked', async () => {
  const h = setup(); await h.load();
  let confirmed = false; const seek = h.player.seek(2).then(() => { confirmed = true; });
  await Promise.resolve(); assert.equal(confirmed, false); h.events.seeked(); await seek;
  h.player.setRate(0.75); assert.equal(h.audio.playbackRate, 0.75);
  h.player.play(); assert.equal(h.player.getSnapshot().phase, 'playing');
  h.events.canplay(); assert.equal(h.player.getSnapshot().phase, 'playing');
  h.player.reset(); assert.equal(h.released(), true); assert.equal(h.destroyed(), 1);
});
test('range loops on native position and handles file ended; non-loop pauses', async () => {
  const h = setup(); await h.load(); h.player.setRange({ start: 1, end: 2, loop: true }); h.player.play();
  h.audio.currentTime = 2; h.events.time(); assert.equal(h.seeks(), 1);
  h.events.seeked(); await Promise.resolve(); assert.equal(h.plays(), 2);
  h.audio.currentTime = 2; h.events.ended(); h.events.seeked(); await Promise.resolve();
  assert.equal(h.plays(), 3);
  h.player.setRange({ start: 1, end: 2, loop: false }); h.audio.currentTime = 2; h.events.time();
  assert.equal(h.player.getSnapshot().phase, 'paused'); h.player.reset();
});
test('recording lock excludes preview, hidden pages cancel playback and late loads', async () => {
  const h = setup(); await h.load(); h.player.lock('recording');
  assert.throws(() => h.player.play()); h.player.play('recording');
  h.player.setForeground(false); assert.equal(h.player.getSnapshot().phase, 'idle');
  assert.throws(() => h.player.play('recording'));
  const other = setup(); other.player.setForeground(false);
  await assert.rejects(other.player.load(other.lease)); assert.equal(other.released(), true);
});
test('private lease expiry cancels pending seek and cannot revive an old context', async () => {
  const h = setup(); await h.load(); const seek = h.player.seek(3);
  h.lease.release(); await assert.rejects(seek); h.events.play(); h.events.seeked();
  assert.equal(h.player.getSnapshot().phase, 'idle');
});
