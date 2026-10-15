import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioDownloads, resourceRequest, PUBLIC_HERO_IDS } from '../src/audio/downloads.ts';

const song = 'song_' + 'a'.repeat(32);
const take = 'take_' + 'b'.repeat(32);
test('reference, take and mix downloads derive only authorized same-origin paths, never token URLs', () => {
  assert.equal(resourceRequest({ kind: 'reference', songId: [...PUBLIC_HERO_IDS][0], asset: 'vocals' }).access, 'public');
  assert.equal(resourceRequest({ kind: 'reference', songId: song, asset: 'vocals' }).access, 'private');
  assert.equal(resourceRequest({ kind: 'take', takeId: take }).access, 'private');
  assert.equal(resourceRequest({ kind: 'mix', songId: song }).access, 'private');
  assert.throws(() => resourceRequest({ kind: 'take', takeId: '../token' }));
  assert.throws(() => resourceRequest({ kind: 'mix', songId: song, voiceVolume: NaN }));
});
test('lease is usable only for its owner and release deletes the file once', async () => {
  let owner = 'alice';
  const removed: string[] = [];
  const downloads = new AudioDownloads({
    download: () => ({ promise: Promise.resolve('wxfile://private'), abort() {} }),
    async remove(path) { removed.push(path); },
    credentials: () => ({ ownerId: owner, expiresAtMs: Date.now() + 60000 }),
  });
  const lease = await downloads.acquire({ kind: 'take', takeId: take }).promise;
  assert.equal(lease.path, 'wxfile://private');
  let revoked = 0;
  lease.onRelease(() => { revoked += 1; });
  owner = 'bob';
  assert.throws(() => lease.path);
  lease.release();
  assert.deepEqual(removed, ['wxfile://private']);
  assert.equal(revoked, 1);
});
test('reset cancels pending downloads and deletes late files without returning a stale path', async () => {
  let finish!: (path: string) => void;
  let aborts = 0;
  const removed: string[] = [];
  const downloads = new AudioDownloads({
    download: () => ({ promise: new Promise<string>((resolve) => { finish = resolve; }), abort() { aborts += 1; } }),
    async remove(path) { removed.push(path); },
    credentials: () => ({ ownerId: 'alice', expiresAtMs: Date.now() + 60000 }),
  });
  const operation = downloads.acquire({ kind: 'take', takeId: take });
  downloads.reset();
  finish('wxfile://late');
  await assert.rejects(operation.promise);
  assert.equal(aborts, 1);
  assert.deepEqual(removed, ['wxfile://late']);
});
test('unauthenticated private audio is blocked, Hero remains public, reset revokes active leases', async () => {
  let calls = 0;
  const downloads = new AudioDownloads({
    download: () => { calls += 1; return { promise: Promise.resolve('wxfile://hero'), abort() {} }; },
    async remove() {}, credentials: () => null,
  });
  await assert.rejects(downloads.acquire({ kind: 'take', takeId: take }).promise);
  assert.equal(calls, 0);
  const lease = await downloads.acquire({ kind: 'reference', songId: [...PUBLIC_HERO_IDS][0], asset: 'source' }).promise;
  downloads.reset();
  assert.throws(() => lease.path);
});
