import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient, ApiError, friendlyError, type AuthProvider, type Credentials,
  type Operation, type Transport, type WireRequest, type WireResponse } from '../src/network/client.ts';
import { SerialPoller, type Scheduler } from '../src/network/poller.ts';
import { PendingTasks } from '../src/network/taskStorage.ts';
import { VerseVivaApi } from '../src/network/api.ts';
import { registerForegroundTask, setAppForeground } from '../src/network/lifecycle.ts';

const origin = 'https://wechat-backend.example.com';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(reply: (input: WireRequest) => Promise<WireResponse> = async () => ({ status: 200, data: {} })) {
  const sent: WireRequest[] = [];
  const removed: string[] = [];
  let aborted = 0;
  const transport: Transport = {
    send(input) {
      sent.push(input);
      return { promise: reply(input), abort() { aborted += 1; } };
    },
    async removeTempFile(path) { removed.push(path); },
  };
  const client = new ApiClient(origin, transport);
  return { client, transport, sent, removed, aborted: () => aborted };
}
function credentials(token = 'old', expired = false): Credentials {
  return { ownerId: 'owner_a', accessToken: token, expiresAtMs: Date.now() + (expired ? -1 : 3600_000) };
}
function login(client: ApiClient, initial = credentials(), refresh?: () => Promise<Credentials>) {
  let current = initial;
  let refreshes = 0;
  const provider: AuthProvider = {
    current: () => current,
    async refresh() { refreshes += 1; current = refresh ? await refresh() : credentials('new'); return current; },
  };
  client.configureAuth(provider);
  return { provider, set: (value: Credentials) => { current = value; }, refreshes: () => refreshes };
}

test('missing origin, HTTP, cross-origin URLs and private unauthenticated operations never send', async () => {
  const h = harness();
  for (const bad of ['', 'http://localhost:8000', 'https://good.example/path', 'https://user:pass@example.com']) {
    const client = new ApiClient(bad, h.transport);
    await assert.rejects(client.request('GET', '/api/v1/health', { access: 'public' }).promise,
      (e: ApiError) => e.code === 'configuration');
  }
  for (const bad of ['https://other.example/api/v1/takes', '/api/v1/../secret', '/api/v1/%2e%2e/secret']) {
    await assert.rejects(h.client.request('GET', bad, { access: 'public' }).promise);
  }
  await assert.rejects(h.client.request('GET', '/api/v1/takes/x').promise,
    (e: ApiError) => e.code === 'authentication');
  assert.equal(h.sent.length, 0);
});

test('public calls omit tokens even when logged in; upload parses JSON and leaves multipart boundary to WeChat', async () => {
  const h = harness(async () => ({ status: 201, data: '{"takeId":"take_a"}' }));
  login(h.client);
  await h.client.request('GET', '/api/v1/health', { access: 'public' }).promise;
  assert.equal(h.sent[0].headers.Authorization, undefined);
  const api = new VerseVivaApi(h.client);
  const result = await api.uploadTake('song_a', { filePath: 'wxfile://recording.tmp', trackSlotId: 'primary',
    selectionType: 'sentence', sentenceIds: ['sentence_a'], selectionStartSeconds: 1,
    selectionEndSeconds: 3, timelineStartSeconds: 1, saveMode: 'overdub_append' }).promise;
  assert.equal(result.takeId, 'take_a');
  const input = h.sent[1];
  assert.equal(input.filePath, 'wxfile://recording.tmp');
  assert.equal(input.headers['Content-Type'], undefined);
  assert.equal(input.formData?.sentence_ids, '["sentence_a"]');
  assert.equal(input.formData?.latency_compensation_ms, '0');
  assert.equal(input.timeoutMs, 60000);
});

test('concurrent 401s share one renewal and retry each request only once', async () => {
  const renewed = deferred<Credentials>();
  const h = harness(async (input) => ({ status: input.headers.Authorization === 'Bearer old' ? 401 : 200, data: {} }));
  const auth = login(h.client, credentials(), () => renewed.promise);
  const a = h.client.request('GET', '/api/v1/takes/a').promise;
  const b = h.client.request('GET', '/api/v1/takes/b').promise;
  await flush();
  assert.equal(auth.refreshes(), 1);
  renewed.resolve(credentials('new'));
  await Promise.all([a, b]);
  assert.equal(h.sent.length, 4);
  assert.equal(auth.refreshes(), 1);
});

test('a second 401 terminates; timeout or network failure never replays a POST', async () => {
  const h = harness(async () => ({ status: 401, data: { detail: 'secret-token' } }));
  const auth = login(h.client);
  await assert.rejects(h.client.request('POST', '/api/v1/takes/a/analysis-jobs').promise,
    (e: ApiError) => e.code === 'authentication' && !e.message.includes('secret'));
  assert.equal(auth.refreshes(), 1);
  assert.equal(h.sent.length, 2);
  const failed = harness(async () => { throw new ApiError('timeout', '连接超时，请重试。'); });
  login(failed.client);
  await assert.rejects(failed.client.request('POST', '/api/v1/takes/a/analysis-jobs').promise);
  assert.equal(failed.sent.length, 1);
});

test('a delayed stale 401 reuses an already refreshed token without a second renewal', async () => {
  const late = deferred<WireResponse>();
  const h = harness(async (input) => {
    if (input.headers.Authorization !== 'Bearer old') return { status: 200, data: {} };
    return input.url.endsWith('/b') ? late.promise : { status: 401 };
  });
  const auth = login(h.client);
  const a = h.client.request('GET', '/api/v1/takes/a').promise;
  const b = h.client.request('GET', '/api/v1/takes/b').promise;
  await a;
  late.resolve({ status: 401 });
  await b;
  assert.equal(auth.refreshes(), 1);
});

test('malformed or mismatched task responses are never reported as a finished analysis', async () => {
  for (const payload of [{}, { takeId: 'other', status: 'processing' }, { takeId: 'take_a', status: 'analyzed' }]) {
    const h = harness(async () => ({ status: 200, data: payload }));
    login(h.client);
    const api = new VerseVivaApi(h.client);
    await assert.rejects(api.attempt('take_a').promise,
      (e: ApiError) => e.code === 'invalid_response');
  }
});

test('cancelling while renewing prevents any later upload', async () => {
  const renewed = deferred<Credentials>();
  const h = harness();
  login(h.client, credentials('old', true), () => renewed.promise);
  const operation = h.client.upload('/api/v1/songs/a/takes', { filePath: 'wxfile://a', formData: {} });
  await flush();
  operation.abort();
  renewed.resolve(credentials('new'));
  await assert.rejects(operation.promise, (e: ApiError) => e.code === 'cancelled');
  assert.equal(h.sent.length, 0);
});

test('changing account discards a pending private download and removes its temp file', async () => {
  const response = deferred<WireResponse>();
  const h = harness(() => response.promise);
  const auth = login(h.client);
  const operation = h.client.download('/api/v1/takes/a/audio');
  auth.set({ ...credentials(), ownerId: 'owner_b' });
  response.resolve({ status: 200, tempFilePath: 'wxfile://private-a' });
  await assert.rejects(operation.promise, (e: ApiError) => e.code === 'authentication');
  assert.deepEqual(h.removed, ['wxfile://private-a']);
});

test('HTTP errors are sanitized and invalid downloaded files are deleted', async () => {
  const h = harness(async () => ({ status: 503, tempFilePath: 'wxfile://error-body', data: { detail: 'Bearer secret' } }));
  login(h.client);
  await assert.rejects(h.client.download('/api/v1/takes/a/audio').promise,
    (e: ApiError) => e.status === 503 && !e.message.includes('secret'));
  assert.deepEqual(h.removed, ['wxfile://error-body']);
  assert.equal(friendlyError(new Error('token=secret')), '操作未完成，请稍后重试。');
});

test('download 401 renews once, removes the error body and returns only the successful local path', async () => {
  const h = harness(async (input) => input.headers.Authorization === 'Bearer old'
    ? { status: 401, tempFilePath: 'wxfile://expired' }
    : { status: 200, tempFilePath: 'wxfile://audio' });
  login(h.client);
  assert.equal(await h.client.download('/api/v1/takes/a/audio').promise, 'wxfile://audio');
  assert.deepEqual(h.removed, ['wxfile://expired']);
});

test('malformed upload JSON is rejected and progress does not prematurely report success', async () => {
  const values: number[] = [];
  const h = harness(async (input) => {
    input.onProgress?.(100);
    return { status: 201, data: 'not-json-secret' };
  });
  login(h.client);
  await assert.rejects(h.client.upload('/api/v1/songs/a/takes', { filePath: 'wxfile://a',
    formData: {}, onProgress: (n) => values.push(n) }).promise,
  (e: ApiError) => e.code === 'invalid_response' && !e.message.includes('secret'));
  assert.deepEqual(values, [99]);
});

function fakeClock() {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let serial = 0;
  const scheduler: Scheduler = {
    set(run, ms) { timers.set(++serial, { run, ms }); return serial; },
    clear(handle) { timers.delete(handle as number); },
  };
  return { scheduler, timers, fire() {
    const [key, value] = [...timers][0]; timers.delete(key); value.run();
  } };
}

test('polling pauses in background, resumes immediately and ignores late pre-hide responses', async () => {
  const clock = fakeClock();
  const requests: ReturnType<typeof deferred<number>>[] = [];
  const values: number[] = [];
  let aborts = 0;
  const poller = new SerialPoller({ scheduler: clock.scheduler,
    load(): Operation<number> { const d = deferred<number>(); requests.push(d);
      return { promise: d.promise, abort() { aborts += 1; } }; },
    onValue: (n) => values.push(n), onError: () => {}, isDone: () => false,
  });
  poller.resume(); poller.resume();
  assert.equal(requests.length, 1);
  poller.pause(); poller.resume();
  assert.equal(aborts, 1);
  requests[0].resolve(1); requests[1].resolve(2);
  await flush();
  assert.deepEqual(values, [2]);
  assert.equal(clock.timers.size, 1);
  poller.dispose();
  assert.equal(clock.timers.size, 0);
});

test('polling network retries are bounded and terminal analysis failure stops polling', async () => {
  const clock = fakeClock();
  const retryFlags: boolean[] = [];
  const poller = new SerialPoller({ scheduler: clock.scheduler,
    load: () => ({ promise: Promise.reject(new ApiError('network', 'offline')), abort() {} }),
    onValue() {}, onError: (_, retry) => retryFlags.push(retry), isDone: () => false });
  poller.resume(); await flush();
  for (let i = 0; i < 3; i += 1) { clock.fire(); await flush(); }
  assert.deepEqual(retryFlags, [true, true, true, false]);
  assert.equal(clock.timers.size, 0);
  poller.dispose();
  const completed = new SerialPoller({ scheduler: clock.scheduler,
    load: () => ({ promise: Promise.resolve('failed'), abort() {} }),
    onValue() {}, onError() {}, isDone: (value) => value === 'failed' });
  completed.resume(); await flush();
  assert.equal(clock.timers.size, 0);
  completed.dispose();
});

test('missing task is not a false success or an infinite retry; explicit retry can resume it', async () => {
  const clock = fakeClock();
  let calls = 0;
  const errors: boolean[] = [];
  const poller = new SerialPoller({ scheduler: clock.scheduler,
    load: () => { calls += 1; return { promise: Promise.reject(new ApiError('http', 'missing', 404)), abort() {} }; },
    onValue() {}, onError: (_, retry) => errors.push(retry), isDone: () => false });
  poller.resume(); await flush(); poller.pause(); poller.resume(); await flush();
  assert.equal(calls, 1);
  assert.deepEqual(errors, [false]);
  poller.retry(); await flush();
  assert.equal(calls, 2);
  poller.dispose();
});

test('pending tasks are isolated by owner and deployment and tolerate corrupt storage', () => {
  const values = new Map<string, unknown>();
  const storage = { read: (k: string) => values.get(k),
    write: (k: string, v: unknown) => { values.set(k, v); }, remove: (k: string) => { values.delete(k); } };
  const a = new PendingTasks(storage, origin);
  const b = new PendingTasks(storage, 'https://other.example.com');
  a.add('owner_a', { kind: 'practice', id: 'take_a' });
  a.add('owner_a', { kind: 'practice', id: 'take_a' });
  assert.equal(a.read('owner_a').length, 1);
  assert.deepEqual(a.read('owner_b'), []);
  assert.deepEqual(b.read('owner_a'), []);
  a.remove('owner_a', { kind: 'practice', id: 'take_a' });
  assert.equal(values.size, 0);
});

test('app visibility pauses registered tasks without resuming unregistered pages', () => {
  const events: string[] = [];
  setAppForeground(true);
  const release = registerForegroundTask({ resume: () => events.push('show'), pause: () => events.push('hide') });
  setAppForeground(false); setAppForeground(true); release(); setAppForeground(true);
  assert.deepEqual(events, ['show', 'hide', 'show', 'hide']);
});
