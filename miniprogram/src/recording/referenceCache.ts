import { ApiError, type Operation } from '../network/client.ts';
import type { AudioLease, AudioResource } from '../audio/downloads.ts';

// Keep downloaded references for this song/page, as the H5 recorder keeps its
// object URLs. Playback borrows a lease; resetting the player does not redownload.
export class RecordingReferences {
  private generation = 0;
  private ready = new Map<string, AudioLease>();
  private pending = new Map<string, { operation: Operation<AudioLease>; promise: Promise<AudioLease> }>();
  constructor(private download: (resource: AudioResource) => Operation<AudioLease>) {}
  reset() {
    this.generation++;
    for (const item of this.pending.values()) item.operation.abort();
    this.pending.clear();
    const leases = [...this.ready.values()]; this.ready.clear();
    leases.forEach((lease) => lease.release());
  }
  private async get(songId: string, asset: 'source' | 'accompaniment') {
    const key = `${songId}:${asset}`;
    const cached = this.ready.get(key);
    if (cached) {
      try { void cached.path; return cached; } catch { this.ready.delete(key); }
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    const generation = this.generation;
    const operation = this.download({ kind: 'reference', songId, asset });
    const promise = operation.promise.then((lease) => {
      if (generation !== this.generation) {
        lease.release(); throw new ApiError('cancelled', '音频准备已取消。');
      }
      this.ready.set(key, lease);
      lease.onRelease(() => { if (this.ready.get(key) === lease) this.ready.delete(key); });
      return lease;
    }).finally(() => {
      if (this.pending.get(key)?.operation === operation) this.pending.delete(key);
    });
    this.pending.set(key, { operation, promise });
    return promise;
  }
  async warm(songId: string, asset: 'source' | 'accompaniment') { await this.get(songId, asset); }
  async acquire(songId: string, asset: 'source' | 'accompaniment'): Promise<AudioLease> {
    const generation = this.generation;
    const master = await this.get(songId, asset);
    if (generation !== this.generation) throw new ApiError('cancelled', '音频准备已取消。');
    let released = false;
    const callbacks = new Set<() => void>();
    let unsubscribe = () => {};
    const release = () => {
      if (released) return;
      released = true; unsubscribe();
      callbacks.forEach((fn) => fn()); callbacks.clear();
    };
    unsubscribe = master.onRelease(release);
    return { get path() {
      if (released) throw new ApiError('cancelled', '音频已释放。');
      return master.path;
    }, release, onRelease(fn) {
      if (released) fn(); else callbacks.add(fn);
      return () => { callbacks.delete(fn); };
    } };
  }
}
