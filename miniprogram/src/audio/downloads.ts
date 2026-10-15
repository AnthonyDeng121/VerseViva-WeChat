import { ApiError, type Operation } from '../network/client.ts';

export type AudioResource =
  | { kind: 'reference'; songId: string; asset: 'source' | 'vocals' | 'accompaniment' }
  | { kind: 'take'; takeId: string }
  | { kind: 'mix'; songId: string; accompanimentVolume?: number; voiceVolume?: number };
export type AudioLease = { readonly path: string; release(): void; onRelease(callback: () => void): () => void };
type Access = { ownerId: string; expiresAtMs: number };
export const PUBLIC_HERO_IDS = new Set(['song_00000000000000000000000000000003',
  'song_00000000000000000000000000000004', 'song_00000000000000000000000000000005']);

function identifier(value: string, prefix: string) {
  if (!new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)) {
    throw new ApiError('configuration', '音频内容标识无效。');
  }
  return value;
}
export function resourceRequest(resource: AudioResource) {
  if (resource.kind === 'reference') {
    const songId = identifier(resource.songId, 'song');
    if (!['source', 'vocals', 'accompaniment'].includes(resource.asset)) {
      throw new ApiError('configuration', '音频类型无效。');
    }
    return { path: `/api/v1/songs/${songId}/audio/${resource.asset}`,
      access: PUBLIC_HERO_IDS.has(songId) ? 'public' as const : 'private' as const };
  }
  if (resource.kind === 'take') return {
    path: `/api/v1/takes/${identifier(resource.takeId, 'take')}/audio`, access: 'private' as const };
  const accompaniment = resource.accompanimentVolume ?? 0.55;
  const voice = resource.voiceVolume ?? 1;
  if (![accompaniment, voice].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new ApiError('configuration', '混音音量应在 0 到 1 之间。');
  }
  return { path: `/api/v1/songs/${identifier(resource.songId, 'song')}/mixdown`
    + `?session_id=miniprogram&accompaniment_volume=${accompaniment}&voice_volume=${voice}`,
  access: 'private' as const };
}

// No shared/public disk directory, signed URL or persistent private-audio cache.
export class AudioDownloads {
  private generation = 0;
  private pending = new Set<Operation<string>>();
  private releases = new Set<() => void>();
  private listeners = new Set<() => void>();
  constructor(private dependencies: {
    download(path: string, access: 'public' | 'private'): Operation<string>;
    remove(path: string): Promise<void>;
    credentials(): Access | null;
  }) {}
  onReset(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  reset() {
    this.generation += 1;
    this.listeners.forEach((listener) => { try { listener(); } catch { /* Cleanup must continue. */ } });
    this.pending.forEach((operation) => operation.abort());
    this.pending.clear();
    [...this.releases].forEach((release) => release());
  }
  acquire(resource: AudioResource): Operation<AudioLease> {
    const generation = this.generation;
    const request = resourceRequest(resource);
    const owner = request.access === 'private' ? this.dependencies.credentials()?.ownerId : null;
    let cancelled = false;
    let operation: Operation<string> | undefined;
    let lease: AudioLease | undefined;
    const promise = (async () => {
      if (request.access === 'private' && !owner) throw new ApiError('authentication', '请先登录后试听自己的录音。');
      operation = this.dependencies.download(request.path, request.access);
      this.pending.add(operation);
      let path: string;
      try { path = await operation.promise; }
      finally { this.pending.delete(operation); }
      const credentials = this.dependencies.credentials();
      if (cancelled || generation !== this.generation
        || (owner && (credentials?.ownerId !== owner || credentials.expiresAtMs <= Date.now()))) {
        await this.dependencies.remove(path);
        throw new ApiError('cancelled', '音频加载已取消，请重新打开。');
      }
      let released = false;
      const listeners = new Set<() => void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (released) return;
        released = true;
        if (timer) clearTimeout(timer);
        this.releases.delete(release);
        listeners.forEach((listener) => { try { listener(); } catch { /* Still delete private file. */ } });
        listeners.clear();
        void this.dependencies.remove(path).catch(() => {});
      };
      if (owner) timer = setTimeout(release, Math.min(2147483647, credentials!.expiresAtMs - Date.now()));
      this.releases.add(release);
      const authorized = () => {
        const current = this.dependencies.credentials();
        return !owner || (current?.ownerId === owner && current.expiresAtMs > Date.now());
      };
      lease = { get path() {
        if (released || !authorized()) {
          release();
          throw new ApiError('authentication', '音频已释放或登录已过期，请重新加载。');
        }
        return path;
      }, release, onRelease(callback) {
        if (released) callback(); else listeners.add(callback);
        return () => { listeners.delete(callback); };
      } };
      return lease;
    })();
    return { promise, abort: () => { cancelled = true; operation?.abort(); lease?.release(); } };
  }
}
