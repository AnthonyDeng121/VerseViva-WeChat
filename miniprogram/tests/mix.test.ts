import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MixController } from '../src/audio/mixController.ts';
import { resourceRequest, type AudioLease } from '../src/audio/downloads.ts';
import type { MixJob, MixOptions } from '../src/network/api.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const job: MixJob = { jobId: 'mix_' + 'a'.repeat(32), songId: 'song_' + 'b'.repeat(32), status: 'ready',
  rangeStartSeconds: 10, rangeEndSeconds: 20, error: '', createdAt: 1 };
const options: MixOptions = { takeIds: ['take_' + 'c'.repeat(32)], accompanimentVolume: .55, voiceVolume: 1, masterGain: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function setup(start?: Promise<MixJob>, download?: Promise<AudioLease>) {
  let stored: string | null = null; let plays = 0; let releases = 0; let statuses = 0;
  let answer = job;
  const lease: AudioLease = { path: 'wxfile://mix', release() { releases++; }, onRelease() { return () => {}; } };
  const controller = new MixController({
    start: () => ({ promise: start ?? Promise.resolve(answer), abort() {} }),
    status: () => { statuses++; return { promise: Promise.resolve(answer), abort() {} }; },
    acquire: () => ({ promise: download ?? Promise.resolve(lease), abort() {} }),
    async play(_, value) { assert.equal(value.rangeStartSeconds, 10); plays++; },
    remember(value) { stored = value; }, read: () => stored,
    watch(poller) { poller.resume(); return () => poller.pause(); },
  });
  return { controller, lease, stored: () => stored, plays: () => plays, releases: () => releases,
    statuses: () => statuses, answer: (value: MixJob) => { answer = value; } };
}

test('finished mix is downloaded only after explicit playback and released on parameter edit', async () => {
  const h = setup(); await h.controller.generate(options);
  assert.equal(h.controller.getSnapshot().phase, 'ready'); assert.equal(h.plays(), 0);
  assert.equal(h.stored(), job.jobId); await h.controller.play();
  assert.equal(h.plays(), 1); assert.equal(h.statuses(), 1);
  h.controller.invalidate(); assert.equal(h.releases(), 1); assert.equal(h.stored(), null);
});
test('late job after edits cannot replace current selection or persist its ID', async () => {
  const pending = deferred<MixJob>(); const h = setup(pending.promise);
  const operation = h.controller.generate(options); h.controller.invalidate(); pending.resolve(job); await operation;
  assert.equal(h.controller.getSnapshot().phase, 'idle'); assert.equal(h.stored(), null); h.controller.dispose();
});
test('hide during download discards late file and never starts background audio', async () => {
  const download = deferred<AudioLease>(); const h = setup(undefined, download.promise);
  await h.controller.generate(options); const playing = h.controller.play(); await flush();
  h.controller.hide(); download.resolve(h.lease); await playing;
  assert.equal(h.plays(), 0); assert.equal(h.releases(), 1); h.controller.dispose();
});
test('server-side stale result cannot be played after another device edited input', async () => {
  const h = setup(); await h.controller.generate(options); h.answer({ ...job, status: 'stale' });
  await h.controller.play(); assert.equal(h.plays(), 0); assert.equal(h.controller.getSnapshot().phase, 'error');
  h.controller.dispose();
});
test('queued job polling pauses while hidden, resumes without automatically playing', async () => {
  const h = setup(); h.answer({ ...job, status: 'queued' }); h.controller.hide();
  await h.controller.generate(options); assert.equal(h.statuses(), 0);
  h.answer(job); h.controller.show(); await flush();
  assert.equal(h.controller.getSnapshot().phase, 'ready'); assert.equal(h.plays(), 0); h.controller.dispose();
});
test('task restoration rechecks owner-scoped saved ID and reports failures without success', async () => {
  const h = setup(); await h.controller.generate(options); h.controller.dispose();
  h.answer({ ...job, status: 'failed' }); await h.controller.restore(); await flush();
  assert.equal(h.controller.getSnapshot().phase, 'error'); assert.equal(h.plays(), 0); h.controller.dispose();
});
test('mix audio derives a private ID-only API route without client token or paths', () => {
  assert.deepEqual(resourceRequest({ kind: 'mix-job', jobId: job.jobId }), {
    path: `/api/v1/mix-jobs/${job.jobId}/audio`, access: 'private' });
  assert.throws(() => resourceRequest({ kind: 'mix-job', jobId: '../private' }));
});
