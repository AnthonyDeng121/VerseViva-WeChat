import type { MixJob, MixOptions } from '../network/api.ts';
import { ApiError, friendlyError, type Operation } from '../network/client.ts';
import { SerialPoller } from '../network/poller.ts';
import type { AudioLease } from './downloads.ts';

export type MixSnapshot = { phase: 'idle' | 'starting' | 'waiting' | 'ready' | 'loading' | 'error';
  job: MixJob | null; error: string };

// Server renders immutable snapshots; every edit invalidates the local ready result.
export class MixController {
  private state: MixSnapshot = { phase: 'idle', job: null, error: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active?: Operation<unknown>;
  private poller?: SerialPoller<MixJob>;
  private unwatch?: () => void;
  private lease?: AudioLease;
  private visible = true;
  constructor(private dependencies: {
    start(options: MixOptions): Operation<MixJob>; status(jobId: string): Operation<MixJob>;
    acquire(jobId: string): Operation<AudioLease>;
    play(lease: AudioLease, job: MixJob): Promise<void>;
    remember(jobId: string | null): void; read(): unknown;
    watch(poller: SerialPoller<MixJob>): () => void;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(value: Partial<MixSnapshot>) { this.state = { ...this.state, ...value }; this.listeners.forEach((fn) => fn()); }
  private cancel() {
    this.generation++; this.active?.abort(); this.active = undefined;
    this.unwatch?.(); this.unwatch = undefined; this.poller?.dispose(); this.poller = undefined;
    this.lease?.release(); this.lease = undefined;
  }
  invalidate() {
    const waiting = ['starting', 'waiting'].includes(this.state.phase);
    this.cancel(); this.remember(null); this.update({ phase: 'idle', job: null,
      error: waiting ? '参数已改变，请重新生成；旧任务可能仍在后台完成，请稍候再提交。' : '' });
  }
  private remember(jobId: string | null) {
    try { this.dependencies.remember(jobId); } catch { /* Optional recovery storage must not break playback. */ }
  }
  dispose() { this.cancel(); }
  hide() {
    this.visible = false; this.unwatch?.(); this.unwatch = undefined; this.poller?.pause();
    if (this.state.phase === 'loading') { this.active?.abort(); this.active = undefined;
      this.generation++; this.lease?.release(); this.lease = undefined; this.update({ phase: 'ready' }); }
  }
  show() { this.visible = true; if (this.poller && !this.unwatch) this.unwatch = this.dependencies.watch(this.poller); }
  async restore() {
    let id: unknown;
    try { id = this.dependencies.read(); } catch { return; }
    if (typeof id === 'string' && /^mix_[a-f0-9]{32}$/.test(id)) {
      this.cancel(); this.update({ phase: 'waiting', error: '' }); this.poll(id, this.generation);
    }
  }
  async generate(options: MixOptions) {
    this.cancel(); const generation = this.generation;
    this.update({ phase: 'starting', job: null, error: '' });
    try {
      const operation = this.dependencies.start(options); this.active = operation;
      const job = await operation.promise; if (generation !== this.generation) return;
      this.remember(job.jobId); this.receive(job);
      if (job.status === 'queued' || job.status === 'processing') this.poll(job.jobId, generation);
    } catch (reason) { if (generation === this.generation) this.update({ phase: 'error', error: friendlyError(reason) }); }
  }
  private receive(job: MixJob) {
    this.update({ job, phase: job.status === 'ready' ? 'ready'
      : job.status === 'queued' || job.status === 'processing' ? 'waiting' : 'error',
    error: ['failed', 'stale'].includes(job.status) ? '合成未完成或参数已改变，请重新生成。' : '' });
  }
  private poll(jobId: string, generation: number) {
    this.poller = new SerialPoller({ load: () => this.dependencies.status(jobId),
      isDone: (job) => !['queued', 'processing'].includes(job.status),
      onValue: (job) => { if (generation === this.generation) this.receive(job); },
      onError: (error, retry) => { if (generation === this.generation && !retry) {
        this.update({ phase: 'error', error: friendlyError(error) });
      } } });
    if (this.visible) this.unwatch = this.dependencies.watch(this.poller);
  }
  async play() {
    if (!this.visible || this.state.phase !== 'ready' || !this.state.job) return;
    const generation = this.generation; const job = this.state.job;
    this.update({ phase: 'loading', error: '' });
    try {
      // Re-check server state after other devices edited/deleted an input.
      const check = this.dependencies.status(job.jobId); this.active = check;
      const latest = await check.promise;
      if (generation !== this.generation || !this.visible) return;
      if (latest.status !== 'ready') { this.receive(latest); return; }
      const operation = this.dependencies.acquire(job.jobId); this.active = operation;
      const lease = await operation.promise;
      if (generation !== this.generation || !this.visible) { lease.release(); return; }
      this.lease = lease; await this.dependencies.play(lease, job);
      if (generation === this.generation) this.update({ phase: 'ready' });
    } catch (reason) {
      if (generation === this.generation) {
        this.lease?.release(); this.lease = undefined;
        this.update({ phase: 'error', error: reason instanceof ApiError ? friendlyError(reason) : '播放未完成，请重新生成或试听。' });
      }
    }
  }
}
