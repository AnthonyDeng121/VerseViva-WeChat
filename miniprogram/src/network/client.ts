export type ErrorCode = 'configuration' | 'authentication' | 'network' | 'timeout'
  | 'cancelled' | 'http' | 'invalid_response';

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
  ) { super(message); this.name = 'ApiError'; }
}

export function friendlyError(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作未完成，请稍后重试。';
}

export type Operation<T> = { promise: Promise<T>; abort(): void };
export type Credentials = { ownerId: string; accessToken: string; expiresAtMs: number };
export type AuthProvider = {
  current(): Credentials | null;
  // The wx.login session manager supplies this; no AppSecret belongs here.
  refresh(): Promise<Credentials>;
};
export type WireResponse = { status: number; data?: unknown; tempFilePath?: string };
export type WireRequest = {
  kind: 'request' | 'upload' | 'download'; url: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; headers: Record<string, string>;
  timeoutMs: number; data?: unknown; filePath?: string; formData?: Record<string, string>;
  onProgress?: (percent: number) => void;
};
export type Transport = {
  send(input: WireRequest): Operation<WireResponse>;
  removeTempFile(path: string): Promise<void>;
};
export type CallOptions = {
  access?: 'public' | 'private'; data?: unknown;
  filePath?: string; formData?: Record<string, string>;
  onProgress?: (percent: number) => void;
};

export function validateOrigin(value: string): string {
  const origin = value.trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(origin)) {
    throw new ApiError('configuration', '服务地址尚未配置为有效的 HTTPS 域名。');
  }
  return origin;
}

export class ApiClient {
  private auth: AuthProvider | null = null;
  private epoch = 0;
  private refreshing: Promise<Credentials> | null = null;

  constructor(private origin: string, private transport: Transport) {}

  configureAuth(provider: AuthProvider | null) {
    this.auth = provider;
    this.epoch += 1;
    this.refreshing = null;
  }

  currentOwner(): string | null { return this.auth?.current()?.ownerId ?? null; }

  request<T>(method: WireRequest['method'], path: string, options: CallOptions = {}) {
    return this.call<T>('request', method, path, options);
  }
  upload<T>(path: string, options: CallOptions & { filePath: string; formData: Record<string, string> }) {
    return this.call<T>('upload', 'POST', path, options);
  }
  download(path: string, options: CallOptions = {}) {
    return this.call<string>('download', 'GET', path, options);
  }

  private renew(provider: AuthProvider, epoch: number, ownerId: string) {
    if (!this.refreshing) {
      const pending = Promise.resolve().then(() => provider.refresh()).then((value) => {
        if (epoch !== this.epoch || value.ownerId !== ownerId
          || provider.current()?.ownerId !== ownerId || !value.accessToken
          || value.expiresAtMs <= Date.now()) {
          throw new ApiError('authentication', '登录状态已变化，请重新登录。');
        }
        return value;
      }).catch(() => { throw new ApiError('authentication', '登录已过期，请重新登录。'); });
      this.refreshing = pending;
      // Only the matching refresh can clear this slot after an account change.
      void pending.finally(() => { if (this.refreshing === pending) this.refreshing = null; })
        .catch(() => {});
    }
    return this.refreshing;
  }

  private call<T>(kind: WireRequest['kind'], method: WireRequest['method'], path: string,
    options: CallOptions): Operation<T> {
    let stopped = false;
    let active: Operation<WireResponse> | undefined;
    const epoch = this.epoch;
    const provider = this.auth;
    const isPrivate = options.access !== 'public';
    const check = () => {
      if (stopped) throw new ApiError('cancelled', '操作已取消。');
      if (isPrivate && epoch !== this.epoch) {
        throw new ApiError('authentication', '登录状态已变化，请重新登录。');
      }
    };
    const promise = (async () => {
      const origin = validateOrigin(this.origin);
      if (!path.startsWith('/api/v1/') || /[\\#]|\.\.|%2e|%2f|%5c/i.test(path)) {
        throw new ApiError('configuration', '服务请求地址无效。');
      }
      check();
      let credentials = isPrivate ? provider?.current() : null;
      const ownerId = credentials?.ownerId;
      if (isPrivate && (!provider || !credentials || !ownerId || !credentials.accessToken)) {
        throw new ApiError('authentication', '请先登录后再使用此功能。');
      }
      if (credentials && credentials.expiresAtMs <= Date.now() + 30_000) {
        credentials = await this.renew(provider!, epoch, ownerId!);
      }
      // No generic retry: a lost POST/upload response may already have created data.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        check();
        if (isPrivate && provider?.current()?.ownerId !== ownerId) {
          throw new ApiError('authentication', '登录状态已变化，请重新登录。');
        }
        const headers: Record<string, string> = {};
        if (credentials) headers.Authorization = `Bearer ${credentials.accessToken}`;
        if (kind === 'request') headers['Content-Type'] = 'application/json';
        active = this.transport.send({ kind, method, url: origin + path, headers,
          timeoutMs: kind === 'request' ? 20_000 : 60_000,
          data: options.data, filePath: options.filePath, formData: options.formData,
          onProgress: options.onProgress ? (value) => {
            if (!stopped) options.onProgress!(Math.min(99, Math.max(0, value)));
          } : undefined,
        });
        const result = await active.promise;
        try {
          check();
          if (isPrivate && provider?.current()?.ownerId !== ownerId) {
            throw new ApiError('authentication', '登录状态已变化，请重新登录。');
          }
          if (result.status === 401 && isPrivate && attempt === 0) {
            if (result.tempFilePath) await this.transport.removeTempFile(result.tempFilePath);
            // Another concurrent request may already have renewed this token.
            const latest = provider!.current();
            credentials = latest?.accessToken !== credentials?.accessToken && latest
              && latest.expiresAtMs > Date.now() ? latest : await this.renew(provider!, epoch, ownerId!);
            continue;
          }
          if (result.status < 200 || result.status >= 300) {
            const message = result.status === 401 ? '登录已过期，请重新登录。'
              : result.status === 404 ? '内容不存在或已不可访问。'
              : result.status === 413 ? '文件过大，请缩短录音后重试。'
              : result.status === 415 ? '录音格式不受支持，请重新录制。'
              : result.status === 429 ? '操作过于频繁，请稍后重试。'
              : '服务暂时无法完成操作，请稍后重试。';
            throw new ApiError(result.status === 401 ? 'authentication' : 'http', message, result.status);
          }
          if (kind === 'download') {
            if (!result.tempFilePath) throw new ApiError('invalid_response', '文件下载未完成，请重试。');
            return result.tempFilePath as T;
          }
          if (result.status === 204) return undefined as T;
          try {
            const parsed = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
            if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON payload');
            return parsed as T;
          } catch { throw new ApiError('invalid_response', '服务返回异常，请稍后重试。'); }
        } catch (error) {
          if (result.tempFilePath) await this.transport.removeTempFile(result.tempFilePath);
          throw error;
        }
      }
      throw new ApiError('authentication', '登录已过期，请重新登录。');
    })().catch((error: unknown) => {
      if (stopped) throw new ApiError('cancelled', '操作已取消。');
      if (error instanceof ApiError) throw error;
      // Raw platform/server errors may include URLs or tokens: never expose them.
      throw new ApiError('network', '网络连接失败，请检查网络后重试。');
    });
    return { promise, abort: () => { stopped = true; active?.abort(); } };
  }
}
