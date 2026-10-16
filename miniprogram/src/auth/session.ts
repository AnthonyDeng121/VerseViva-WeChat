import { ApiError, friendlyError, type AuthProvider, type Credentials } from '../network/client.ts';

export type AuthSnapshot = {
  status: 'guest' | 'restoring' | 'authenticating' | 'authenticated';
  ownerId: string | null; error: string;
};
type Dependencies = {
  loginCode(): Promise<string>;
  exchange(code: string): Promise<unknown>;
  exchangeReview?(username: string, password: string): Promise<unknown>;
  revoke(credentials: Credentials): Promise<void>;
  readHint(): unknown;
  writeHint(ownerId: string): void;
  removeHint(): void;
  invalidateRequests(): void;
};

function ownerId(value: unknown): value is string {
  return typeof value === 'string' && /^wxuser_[a-f0-9]{32}$/.test(value);
}
function parseLogin(value: unknown): Credentials {
  if (!value || typeof value !== 'object') throw new ApiError('invalid_response', '登录返回异常，请重新尝试。');
  const data = value as Record<string, unknown>;
  if (!ownerId(data.ownerId) || typeof data.accessToken !== 'string'
    || !/^vwx1\.[A-Za-z0-9_-]{43}$/.test(data.accessToken)
    || data.tokenType !== 'Bearer' || typeof data.expiresAtMs !== 'number'
    || !Number.isFinite(data.expiresAtMs) || data.expiresAtMs <= Date.now() + 30_000) {
    throw new ApiError('invalid_response', '登录返回异常，请重新尝试。');
  }
  return { ownerId: data.ownerId, accessToken: data.accessToken, expiresAtMs: data.expiresAtMs };
}

export class SessionManager implements AuthProvider {
  private credentials: Credentials | null = null;
  private snapshot: AuthSnapshot = { status: 'guest', ownerId: null, error: '' };
  private listeners = new Set<() => void>();
  private pending: Promise<Credentials> | null = null;
  private generation = 0;
  private restored = false;
  private reviewSession = false;

  constructor(private dependencies: Dependencies) {}
  current = () => this.credentials;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(status: AuthSnapshot['status'], error = '') {
    this.snapshot = { status, ownerId: status === 'authenticated' ? this.credentials?.ownerId ?? null : null, error };
    this.listeners.forEach((listener) => listener());
  }
  private removeHint() { try { this.dependencies.removeHint(); } catch { /* No token is persisted. */ } }

  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    let hint: unknown;
    try { hint = this.dependencies.readHint(); } catch { return; }
    if (!ownerId(hint)) return;
    this.publish('restoring');
    try { await this.beginLogin(hint); } catch { /* Snapshot contains a safe retry message. */ }
  }

  signIn(): Promise<Credentials> {
    if (this.pending) return this.pending;
    this.restored = true;
    this.reviewSession = false;
    this.generation += 1;
    this.credentials = null;
    this.dependencies.invalidateRequests();
    this.publish('authenticating');
    return this.beginLogin(null);
  }

  refresh(): Promise<Credentials> {
    if (this.reviewSession) return Promise.reject(new ApiError('authentication', '测试登录已到期，请重新输入测试账号密码。'));
    const expectedOwner = this.credentials?.ownerId;
    if (!expectedOwner) return Promise.reject(new ApiError('authentication', '请重新微信登录。'));
    return this.beginLogin(expectedOwner);
  }

  async signInReview(username: string, password: string): Promise<Credentials> {
    if (!this.dependencies.exchangeReview) throw new ApiError('configuration', '测试账号登录不可用。');
    const generation = ++this.generation;
    this.restored = true; this.reviewSession = true;
    this.credentials = null; this.pending = null; this.removeHint();
    this.dependencies.invalidateRequests(); this.publish('authenticating');
    try {
      const value = parseLogin(await this.dependencies.exchangeReview(username, password));
      if (generation !== this.generation) throw new ApiError('cancelled', '登录已取消。');
      this.credentials = value; this.publish('authenticated');
      // Neither the password nor reviewer credentials/hint are persisted.
      return value;
    } catch (error) {
      if (generation === this.generation) {
        this.credentials = null; this.dependencies.invalidateRequests();
        this.publish('guest', friendlyError(error));
      }
      throw error;
    }
  }

  private beginLogin(expectedOwner: string | null): Promise<Credentials> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      const code = await this.dependencies.loginCode();
      if (generation !== this.generation) throw new ApiError('cancelled', '登录已取消。');
      if (!code) throw new ApiError('authentication', '微信登录未完成，请重新尝试。');
      // A fresh wx.login code for every exchange. Never cache/replay a consumed code.
      const credentials = parseLogin(await this.dependencies.exchange(code));
      if (generation !== this.generation) throw new ApiError('cancelled', '登录已取消。');
      if (expectedOwner && credentials.ownerId !== expectedOwner) {
        // Never silently replay an old owner's task using a new WeChat identity.
        throw new ApiError('authentication', '微信账号已变化，请重新点击登录。');
      }
      this.credentials = credentials;
      try { this.dependencies.writeHint(credentials.ownerId); } catch { /* Login can remain in memory. */ }
      this.publish('authenticated');
      return credentials;
    })().catch((error: unknown) => {
      if (generation === this.generation) {
        this.credentials = null;
        this.removeHint();
        this.dependencies.invalidateRequests();
        this.publish('guest', friendlyError(error));
      }
      throw error instanceof ApiError ? error : new ApiError('authentication', '微信登录暂时不可用，请重试。');
    });
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = null; }).catch(() => {});
    return pending;
  }

  async signOut(): Promise<void> {
    const credentials = this.credentials;
    this.restored = true;
    const generation = ++this.generation;
    this.credentials = null;
    this.pending = null;
    this.removeHint();
    this.dependencies.invalidateRequests();
    this.publish('guest');
    if (!credentials || credentials.expiresAtMs <= Date.now()) return;
    try { await this.dependencies.revoke(credentials); }
    catch {
      if (generation === this.generation) {
        this.publish('guest', '已在本机退出，服务器会话暂未能撤销，将在到期后失效。');
      }
    }
  }
}
