import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecorderController, type RecorderDriver, type RecordingSelection, type RecordingClip } from '../src/recording/controller.ts';
import { PracticeWorkflow, type Checkpoint } from '../src/recording/workflow.ts';
import { ApiError } from '../src/network/client.ts';
import type { Attempt } from '../src/network/api.ts';
import { syncEvidence } from '../src/recording/sync.ts';
import { RecordingReferences } from '../src/recording/referenceCache.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const selection: RecordingSelection = { songId: 'song_' + 'a'.repeat(32), sentenceIds: ['sentence_1'],
  trackSlotId: 'primary:range:s:s:1', selectionType: 'sentence', selectionStartSeconds: 1,
  selectionEndSeconds: 3, timelineStartSeconds: 1, latencyCompensationMs: 0, manualOffsetMs: 0 };
function setup(options: { authorize?: () => Promise<void>; prepare?: () => Promise<void>; referenceStarts?: boolean; startThrowsOnce?: boolean } = {}) {
  let start!: () => void; let stop!: Parameters<RecorderDriver['onStop']>[0];
  let interrupt!: () => void; let error!: () => void;
  let starts = 0; let plays = 0; let referenceStops = 0; let owner = 'alice';
  const removed: string[] = []; const timers = new Map<number, () => void>(); let serial = 0;
  const controller = new RecorderController({
    driver: () => ({ start() { starts += 1; if (options.startThrowsOnce && starts === 1) throw new Error('native start failed'); }, stop() {}, onStart: (fn) => { start = fn; },
      onStop: (fn) => { stop = fn; }, onError: (fn) => { error = fn; }, onInterruption: (fn) => { interrupt = fn; } }),
    owner: () => owner, authorize: options.authorize ?? (async () => {}),
    prepare: options.prepare ?? (async () => {}), playReference() { plays += 1;
      if (options.referenceStarts !== false) controller.referenceStarted(selection.selectionStartSeconds); }, stopReference() { referenceStops++; },
    async remove(path) { removed.push(path); },
    delay(_, fn) { timers.set(++serial, fn); return serial as unknown as ReturnType<typeof setTimeout>; },
    cancel(handle) { timers.delete(handle as unknown as number); },
  });
  const tick = async () => { const first = [...timers.entries()][0]; assert.ok(first); timers.delete(first[0]); first[1](); await flush(); };
  return { controller, tick, timers, removed, starts: () => starts, plays: () => plays,
    referenceStops: () => referenceStops,
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

test('cancelled slow preparation cannot stop a newer recording attempt', async () => {
  let finish!: () => void; let calls = 0;
  const h = setup({ prepare: () => ++calls === 1 ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve() });
  const old = h.controller.start(selection); await flush();
  assert.equal(h.controller.getSnapshot().phase, 'preloading');
  h.controller.interrupt();
  const next = h.controller.start(selection); await flush();
  assert.equal(h.controller.getSnapshot().phase, 'countdown');
  const stops = h.referenceStops(); finish(); await old;
  assert.equal(h.referenceStops(), stops);
  await h.tick(); await h.tick(); await h.tick(); await next;
  h.start(); assert.equal(h.controller.getSnapshot().phase, 'recording');
  h.controller.stop(); h.stop(); h.controller.discard();
});

test('recording prefetch shares pending download and reuses local audio across rerecordings', async () => {
  let downloads = 0; let deleted = 0; let revoked = () => {};
  let finish!: (lease: import('../src/audio/downloads.ts').AudioLease) => void;
  const refs = new RecordingReferences(() => { downloads++; return {
    promise: new Promise((resolve) => { finish = resolve; }), abort() {},
  }; });
  const warm = refs.warm(selection.songId, 'accompaniment');
  const first = refs.acquire(selection.songId, 'accompaniment');
  finish({ path: 'wxfile://backing', release() { deleted++; revoked(); }, onRelease(fn) { revoked = fn; return () => {}; } });
  await warm; const lease = await first; lease.release();
  const again = await refs.acquire(selection.songId, 'accompaniment');
  assert.equal(again.path, 'wxfile://backing'); assert.equal(downloads, 1); assert.equal(deleted, 0);
  refs.reset(); assert.equal(deleted, 1); assert.throws(() => again.path);
});

test('recording prefetch failure is retryable and reset rejects late files', async () => {
  let attempts = 0; let deleted = 0; let finish!: (lease: import('../src/audio/downloads.ts').AudioLease) => void;
  const refs = new RecordingReferences(() => ({ promise: ++attempts === 1 ? Promise.reject(new Error('offline'))
    : new Promise((resolve) => { finish = resolve; }), abort() {} }));
  await assert.rejects(refs.warm(selection.songId, 'source'));
  const later = refs.acquire(selection.songId, 'source'); refs.reset();
  finish({ path: 'wxfile://late', release() { deleted++; }, onRelease() { return () => {}; } });
  await assert.rejects(later); assert.equal(deleted, 1); assert.equal(attempts, 2);
});
test('synchronous native start failure clears provisional recording and permits a new attempt', async () => {
  const h = setup({ startThrowsOnce: true }); await requestStart(h);
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(h.controller.getSnapshot().clip, null); assert.equal(h.timers.size, 0);
  await requestStart(h); assert.equal(h.controller.getSnapshot().phase, 'starting');
  h.start(); h.controller.stop(); h.stop();
  assert.equal(h.controller.getSnapshot().phase, 'preview');
  assert.equal(h.starts(), 2); h.controller.discard();
});
test('actual reference start is required; missing playback times out and discards output', async () => {
  const h = setup({ referenceStarts: false }); await requestStart(h); h.start();
  await h.tick(); h.stop();
  assert.equal(h.controller.getSnapshot().phase, 'interrupted');
  assert.equal(h.controller.getSnapshot().clip, null);
});
test('sync evidence preserves callback observations separately from unverified device latency', async () => {
  const h = setup(); await requestStart(h); h.start(); h.controller.stop(); h.stop();
  const evidence = syncEvidence(h.controller.getSnapshot().clip!);
  assert.equal(evidence.calibrationStatus, 'unverified');
  assert.equal(evidence.calibratedDeviceLatencyMs, 0);
  assert.equal(evidence.events[3].positionSeconds, selection.selectionStartSeconds);
  assert.deepEqual(evidence.events.map((event) => event.kind), ['recorder_start_requested',
    'recorder_started', 'reference_play_requested', 'reference_playing', 'recorder_stop_requested', 'recorder_stopped']);
  h.controller.discard();
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
