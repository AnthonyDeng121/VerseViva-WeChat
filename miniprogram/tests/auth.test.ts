import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '../src/auth/session.ts';
import { ApiClient, ApiError, type Credentials, type WireRequest } from '../src/network/client.ts';

const alice = 'wxuser_' + 'a'.repeat(32);
const bob = 'wxuser_' + 'b'.repeat(32);
const payload = (owner = alice, token = 'a') => ({ ownerId: owner,
  accessToken: 'vwx1.' + token.repeat(43), tokenType: 'Bearer', expiresAtMs: Date.now() + 3600_000 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('review login keeps password and identity out of persistence and never renews with wx.login', async () => {
  let saved = 0; let loginCodes = 0;
  const session = new SessionManager({
    async loginCode() { loginCodes++; return 'code'; }, async exchange() { return payload(); },
    async exchangeReview(username, password) { assert.equal(username, 'reviewer'); assert.equal(password, 'secret'); return payload(); },
    async revoke() {}, readHint: () => undefined, writeHint() { saved++; }, removeHint() {}, invalidateRequests() {},
  });
  await session.signInReview('reviewer', 'secret');
  assert.equal(session.getSnapshot().status, 'authenticated'); assert.equal(saved, 0);
  await assert.rejects(session.refresh()); assert.equal(loginCodes, 0);
  await session.signOut(); assert.equal(session.current(), null);
});

test('late reviewer login cannot revive an account after logout', async () => {
  let finish!: (value: unknown) => void;
  const session = new SessionManager({
    async loginCode() { return 'code'; }, async exchange() { return payload(); },
    exchangeReview: () => new Promise((resolve) => { finish = resolve; }),
    async revoke() {}, readHint: () => undefined, writeHint() {}, removeHint() {}, invalidateRequests() {},
  });
  const pending = session.signInReview('reviewer', 'secret'); await session.signOut();
  finish(payload()); await assert.rejects(pending); assert.equal(session.current(), null);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options: { hint?: unknown; exchange?: (code: string) => Promise<unknown>;
  revoke?: (credentials: Credentials) => Promise<void> } = {}) {
  let hint: unknown = options.hint;
  let invalidations = 0;
  const codes: string[] = [];
  const persisted: string[] = [];
  const session = new SessionManager({
    async loginCode() { const code = `code-${codes.length}`; codes.push(code); return code; },
    exchange: options.exchange ?? (async () => payload()),
    revoke: options.revoke ?? (async () => {}),
    readHint: () => hint, writeHint: (value) => { hint = value; persisted.push(value); },
    removeHint: () => { hint = undefined; }, invalidateRequests: () => { invalidations += 1; },
  });
  return { session, codes, persisted, invalidations: () => invalidations, hint: () => hint };
}

test('guest startup does not call wx.login; explicit login persists only an owner hint', async () => {
  const h = setup();
  await h.session.restore();
  assert.equal(h.codes.length, 0);
  assert.equal(h.session.getSnapshot().status, 'guest');
  await h.session.signIn();
  assert.equal(h.session.getSnapshot().status, 'authenticated');
  assert.equal(h.session.getSnapshot().ownerId, alice);
  assert.equal(h.hint(), alice);
  assert.deepEqual(h.persisted, [alice]);
  assert.equal('accessToken' in h.session.getSnapshot(), false);
});

test('restoration obtains a fresh code and revalidates actual WeChat owner rather than trusting storage', async () => {
  const h = setup({ hint: alice });
  await h.session.restore();
  assert.equal(h.codes.length, 1);
  assert.equal(h.session.current()?.ownerId, alice);
  const changed = setup({ hint: alice, exchange: async () => payload(bob) });
  await changed.session.restore();
  assert.equal(changed.session.current(), null);
  assert.equal(changed.session.getSnapshot().status, 'guest');
  assert.match(changed.session.getSnapshot().error, /账号已变化/);
  assert.equal(changed.hint(), undefined);
  await changed.session.signIn();
  assert.equal(changed.session.current()?.ownerId, bob);
});

test('concurrent login/renewal requests share one code exchange and later renewal gets a new code', async () => {
  const exchange = deferred<unknown>();
  let first = true;
  const h = setup({ exchange: async () => { if (first) { first = false; return exchange.promise; } return payload(alice, 'b'); } });
  const a = h.session.signIn();
  const b = h.session.signIn();
  exchange.resolve(payload());
  await Promise.all([a, b]);
  assert.equal(h.codes.length, 1);
  const invalidations = h.invalidations();
  await Promise.all([h.session.refresh(), h.session.refresh()]);
  assert.equal(h.codes.length, 2);
  assert.equal(h.invalidations(), invalidations);
});

test('logout during code exchange cannot be undone by a late login response', async () => {
  const exchange = deferred<unknown>();
  const h = setup({ exchange: () => exchange.promise });
  const signingIn = h.session.signIn();
  await flush();
  await h.session.signOut();
  exchange.resolve(payload());
  await assert.rejects(signingIn, (error: ApiError) => error.code === 'cancelled');
  assert.equal(h.session.current(), null);
  assert.equal(h.hint(), undefined);
  assert.equal(h.session.getSnapshot().status, 'guest');
});

test('account change during automatic renewal clears identity and requires explicit login', async () => {
  let owner = alice;
  const h = setup({ exchange: async () => payload(owner) });
  await h.session.signIn();
  owner = bob;
  await assert.rejects(h.session.refresh(), /微信账号已变化/);
  assert.equal(h.session.current(), null);
  await h.session.signIn();
  assert.equal(h.session.current()?.ownerId, bob);
});

test('invalid server login payload or exchange failure cannot establish a session', async () => {
  for (const result of [{}, { ...payload(), ownerId: 'openid-direct' },
    { ...payload(), expiresAtMs: Date.now() - 1 }, { ...payload(), accessToken: 'session_key' }]) {
    const h = setup({ exchange: async () => result });
    await assert.rejects(h.session.signIn());
    assert.equal(h.session.current(), null);
    assert.equal(h.hint(), undefined);
  }
  const failed = setup({ exchange: async () => { throw new Error('secret=must-not-leak'); } });
  await assert.rejects(failed.session.signIn(), (error: ApiError) => !error.message.includes('secret'));
  assert.ok(!failed.session.getSnapshot().error.includes('secret'));
});

test('logout clears local state even offline; late revocation error cannot overwrite a new login', async () => {
  const revocation = deferred<void>();
  const h = setup({ revoke: () => revocation.promise });
  await h.session.signIn();
  const logout = h.session.signOut();
  assert.equal(h.session.current(), null);
  assert.equal(h.hint(), undefined);
  await h.session.signIn();
  revocation.reject(new Error('offline'));
  await logout;
  assert.equal(h.session.getSnapshot().status, 'authenticated');
  assert.equal(h.session.getSnapshot().error, '');
});

test('late private response stays invalid after logout and login to the same owner', async () => {
  const response = deferred<{ status: number; data: unknown }>();
  let request: WireRequest | undefined;
  const client = new ApiClient('https://wechat.example.com', {
    send: (input) => { request = input; return { promise: response.promise, abort() {} }; },
    async removeTempFile() {},
  });
  const session = new SessionManager({
    loginCode: async () => 'code', exchange: async () => payload(), revoke: async () => {},
    readHint: () => undefined, writeHint() {}, removeHint() {},
    invalidateRequests: () => client.configureAuth(session),
  });
  client.configureAuth(session);
  await session.signIn();
  const old = client.request('GET', '/api/v1/takes/old');
  assert.ok(request?.headers.Authorization);
  await session.signOut();
  await session.signIn();
  response.resolve({ status: 200, data: {} });
  await assert.rejects(old.promise, (error: ApiError) => error.code === 'authentication');
});

test('UI subscribers observe login/logout and unsubscribe cleanly', async () => {
  const h = setup();
  let updates = 0;
  const release = h.session.subscribe(() => { updates += 1; });
  await h.session.signIn();
  assert.ok(updates >= 2);
  release();
  const before = updates;
  await h.session.signOut();
  assert.equal(updates, before);
});
