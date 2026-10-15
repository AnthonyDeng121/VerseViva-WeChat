import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecorderController, type RecorderDriver, type RecordingSelection, type RecordingClip } from '../src/recording/controller.ts';
import { PracticeWorkflow, type Checkpoint } from '../src/recording/workflow.ts';
import { ApiError } from '../src/network/client.ts';
import type { Attempt } from '../src/network/api.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const selection: RecordingSelection = { songId: 'song_' + 'a'.repeat(32), sentenceIds: ['sentence_1'],
  trackSlotId: 'primary:range:s:s:1', selectionType: 'sentence', selectionStartSeconds: 1,
  selectionEndSeconds: 3, timelineStartSeconds: 1, latencyCompensationMs: 0, manualOffsetMs: 0 };
function setup(options: { authorize?: () => Promise<void>; prepare?: () => Promise<void> } = {}) {
  let start!: () => void; let stop!: Parameters<RecorderDriver['onStop']>[0];
  let interrupt!: () => void; let error!: () => void;
  let starts = 0; let plays = 0; let owner = 'alice';
  const removed: string[] = []; const timers = new Map<number, () => void>(); let serial = 0;
  const controller = new RecorderController({
    driver: () => ({ start() { starts += 1; }, stop() {}, onStart: (fn) => { start = fn; },
      onStop: (fn) => { stop = fn; }, onError: (fn) => { error = fn; }, onInterruption: (fn) => { interrupt = fn; } }),
    owner: () => owner, authorize: options.authorize ?? (async () => {}),
    prepare: options.prepare ?? (async () => {}), playReference() { plays += 1; }, stopReference() {},
    async remove(path) { removed.push(path); },
    delay(_, fn) { timers.set(++serial, fn); return serial as unknown as ReturnType<typeof setTimeout>; },
    cancel(handle) { timers.delete(handle as unknown as number); },
  });
  const tick = async () => { const first = [...timers.entries()][0]; assert.ok(first); timers.delete(first[0]); first[1](); await flush(); };
  return { controller, tick, timers, removed, starts: () => starts, plays: () => plays,
    start: () => start(), stop: (valid = true) => stop({ tempFilePath: 'wxfile://recording.mp3', duration: valid ? 2000 : 0, fileSize: valid ? 128 : 0 }),
    interrupt: () => interrupt(), error: () => error(), setOwner: (value: string) => { owner = value; } };
}
async function requestStart(h: ReturnType<typeof setup>) {
  const pending = h.controller.start(selection); await flush();
  assert.equal(h.controller.getSnapshot().phase, 'countdown');
  await h.tick(); await h.tick(); await h.tick(); await pending;
}
test('countdown follows authorization/preload and reference starts only after real recorder onStart', async () => {
  const h = setup(); await requestStart(h);
  assert.equal(h.controller.getSnapshot().phase, 'starting'); assert.equal(h.plays(), 0);
  h.start(); assert.equal(h.controller.getSnapshot().phase, 'recording'); assert.equal(h.plays(), 1);
  h.controller.stop(); assert.equal(h.controller.getSnapshot().phase, 'stopping');
  h.stop(); assert.equal(h.controller.getSnapshot().phase, 'preview');
  assert.equal(h.controller.getSnapshot().clip?.durationSeconds, 2);
  h.controller.discard(); assert.deepEqual(h.removed, ['wxfile://recording.mp3']);
});
test('permission refusal and preload failure never call native start', async () => {
  for (const field of ['authorize', 'prepare'] as const) {
    const h = setup({ [field]: async () => { throw new ApiError('configuration', 'denied'); } });
    await h.controller.start(selection); assert.equal(h.starts(), 0);
    assert.equal(h.controller.getSnapshot().phase, 'error');
  }
});
test('hide during countdown prevents start; system interruption discards late partial onStop', async () => {
  const h = setup(); const start = h.controller.start(selection); await flush();
  h.controller.interrupt(); await start; assert.equal(h.starts(), 0);
  await requestStart(h); h.start(); h.interrupt(); h.stop();
  assert.equal(h.controller.getSnapshot().phase, 'interrupted');
  assert.equal(h.controller.getSnapshot().clip, null); assert.deepEqual(h.removed, ['wxfile://recording.mp3']);
});
test('invalid output and owner changes cannot publish a successful clip', async () => {
  for (const changed of [false, true]) {
    const h = setup(); await requestStart(h); h.start(); h.controller.stop();
    if (changed) h.setOwner('bob'); h.stop(changed);
    assert.equal(h.controller.getSnapshot().clip, null);
    assert.equal(h.controller.getSnapshot().phase, 'interrupted');
  }
});

const clip: RecordingClip = { filePath: 'wxfile://clip', durationSeconds: 2, ownerId: 'alice', selection, events: [] };
function workflow(mode: 'analyze_only' | 'save_and_analyze', failDelete = false) {
  let checkpoint: Checkpoint | null = null; let cleanups = 0; let memories = 0; let releases = 0;
  let deleted = failDelete;
  const attempt: Attempt = { takeId: 'take_' + 'b'.repeat(32), attemptId: 'attempt_a', status: 'analyzed' };
  const service = new PracticeWorkflow({ currentOwner: () => 'alice',
    upload: () => ({ promise: Promise.resolve({ takeId: attempt.takeId, songId: selection.songId, audioUrl: '', mimeType: 'audio/mpeg' }), abort() {} }),
    start: () => ({ promise: Promise.resolve({}), abort() {} }),
    attempt: () => ({ promise: Promise.resolve(attempt), abort() {} }),
    remove: (_, preserve) => { assert.equal(preserve, true); cleanups += 1;
      return { promise: deleted ? Promise.reject(new ApiError('network', 'offline')) : Promise.resolve(), abort() {} }; },
    remember: (_, value) => { checkpoint = value; }, read: () => checkpoint,
    watch: (poller) => { poller.resume(); return () => poller.dispose(); },
    async refreshMemory() { memories += 1; }, releaseClip() { releases += 1; },
  });
  return { service, mode, cleanups: () => cleanups, memories: () => memories, releases: () => releases,
    checkpoint: () => checkpoint, allowDelete: () => { deleted = false; } };
}
test('analyze only cleans Take but preserves Attempt, saved analysis keeps Take; both refresh Memory', async () => {
  for (const mode of ['analyze_only', 'save_and_analyze'] as const) {
    const h = workflow(mode); await h.service.submit(clip, mode); await flush();
    assert.equal(h.service.getSnapshot().phase, 'done'); assert.equal(h.memories(), 1);
    assert.equal(h.cleanups(), mode === 'analyze_only' ? 1 : 0);
    assert.equal(h.service.getSnapshot().takeId === null, mode === 'analyze_only');
    assert.equal(h.releases(), 1); assert.equal(h.checkpoint(), null);
  }
});
test('cleanup failure is retained and retry does not lose the Attempt or falsely finish', async () => {
  const h = workflow('analyze_only', true); await h.service.submit(clip, h.mode); await flush();
  assert.equal(h.service.getSnapshot().phase, 'error'); assert.equal(h.checkpoint()?.stage, 'cleanup');
  assert.equal(h.memories(), 0); h.allowDelete(); await h.service.retry();
  assert.equal(h.service.getSnapshot().phase, 'done'); assert.equal(h.memories(), 1);
});
