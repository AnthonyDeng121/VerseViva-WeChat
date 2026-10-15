import { ApiError, friendlyError, type Operation } from '../network/client.ts';
import { SerialPoller } from '../network/poller.ts';
import type { Attempt, Take } from '../network/api.ts';
import type { RecordingClip } from './controller.ts';

export type AnalysisMode = 'analyze_only' | 'save_and_analyze' | 'save_only';
export type Checkpoint = { takeId: string; songId: string; mode: AnalysisMode; stage?: 'analysis' | 'cleanup' };
export type WorkflowSnapshot = { phase: 'idle' | 'uploading' | 'analyzing' | 'cleaning' | 'done' | 'error';
  error: string; takeId: string | null; attempt: Attempt | null; mode: AnalysisMode | null; startedAtMs: number };
export class PracticeWorkflow {
  private state: WorkflowSnapshot = { phase: 'idle', error: '', takeId: null, attempt: null, mode: null, startedAtMs: 0 };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active?: Operation<unknown>;
  private releasePoller?: () => void;
  private checkpoint: Checkpoint | null = null;
  private owner: string | null = null;
  constructor(private dependencies: {
    currentOwner(): string | null;
    upload(clip: RecordingClip): Operation<Take>;
    start(takeId: string, force?: boolean): Operation<unknown>;
    attempt(takeId: string): Operation<Attempt>;
    remove(takeId: string, preserveAttempt: boolean): Operation<void>;
    remember(owner: string, value: Checkpoint | null): void;
    read(owner: string): unknown;
    watch(poller: SerialPoller<Attempt>): () => void;
    refreshMemory(): Promise<void>; releaseClip(): void;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(value: Partial<WorkflowSnapshot>) { this.state = { ...this.state, ...value }; this.listeners.forEach((fn) => fn()); }
  reset() {
    this.generation += 1; this.active?.abort(); this.active = undefined;
    this.releasePoller?.(); this.releasePoller = undefined;
    this.checkpoint = null; this.owner = null;
    this.update({ phase: 'idle', error: '', takeId: null, attempt: null, mode: null, startedAtMs: 0 });
  }
  private valid(generation: number) { return generation === this.generation && this.owner === this.dependencies.currentOwner(); }
  async submit(clip: RecordingClip, mode: AnalysisMode) {
    if (['uploading', 'analyzing', 'cleaning'].includes(this.state.phase)) return;
    if (clip.ownerId !== this.dependencies.currentOwner()) throw new ApiError('authentication', '录音归属已变化，请重新录制。');
    this.reset(); this.owner = clip.ownerId; const generation = this.generation;
    this.update({ phase: 'uploading', mode, error: '', startedAtMs: Date.now() });
    try {
      const operation = this.dependencies.upload(clip); this.active = operation;
      const take = await operation.promise;
      if (!this.valid(generation)) return;
      this.checkpoint = { takeId: take.takeId, songId: clip.selection.songId, mode };
      this.update({ takeId: take.takeId });
      this.dependencies.remember(this.owner!, this.checkpoint);
      await this.continue(generation);
    } catch (error) { if (this.valid(generation)) this.update({ phase: 'error', error: friendlyError(error) }); }
  }
  async restore() {
    if (this.state.phase !== 'idle') return;
    const owner = this.dependencies.currentOwner(); if (!owner) return;
    const value = this.dependencies.read(owner) as Checkpoint | null;
    if (!value || !/^take_[a-f0-9]{32}$/.test(value.takeId) || !/^song_[a-f0-9]{32}$/.test(value.songId)
      || !['analyze_only', 'save_and_analyze', 'save_only'].includes(value.mode)) return;
    this.owner = owner; this.checkpoint = value;
    this.update({ takeId: value.takeId, mode: value.mode, startedAtMs: Date.now() });
    await this.retry();
  }
  async retry(force = false) {
    if (!this.checkpoint || this.owner !== this.dependencies.currentOwner()) return;
    const generation = this.generation; this.update({ error: '' });
    try { await this.continue(generation, force); }
    catch (error) { if (this.valid(generation)) this.update({ phase: 'error', error: friendlyError(error) }); }
  }
  private async continue(generation: number, force = false) {
    const checkpoint = this.checkpoint!;
    if (checkpoint.stage === 'cleanup') { await this.finish(generation, this.state.attempt); return; }
    if (checkpoint.mode === 'save_only') { await this.finish(generation, null); return; }
    if (this.state.attempt && !force) { await this.finish(generation, this.state.attempt); return; }
    this.update({ phase: 'analyzing' });
    const operation = this.dependencies.start(checkpoint.takeId, force); this.active = operation;
    await operation.promise; if (!this.valid(generation)) return;
    this.releasePoller?.();
    const poller = new SerialPoller<Attempt>({ load: () => this.dependencies.attempt(checkpoint.takeId),
      isDone: (value) => value.status !== 'processing', onValue: (value) => {
        if (this.valid(generation) && value.status !== 'processing') {
          this.update({ attempt: value }); void this.finish(generation, value).catch((error) => {
            if (this.valid(generation)) this.update({ phase: 'error', error: friendlyError(error) });
          });
        }
      }, onError: (error, willRetry) => {
        if (this.valid(generation)) this.update({ ...(willRetry ? {} : { phase: 'error' as const }),
          error: error instanceof ApiError && error.status === 404 ? '分析已中断，请重试分析。' : friendlyError(error) });
      } });
    const unwatch = this.dependencies.watch(poller);
    this.releasePoller = () => { unwatch(); poller.dispose(); };
  }
  private async finish(generation: number, attempt: Attempt | null) {
    if (!this.valid(generation)) return;
    const checkpoint = this.checkpoint!;
    if (checkpoint.mode === 'analyze_only') {
      this.update({ phase: 'cleaning' });
      checkpoint.stage = 'cleanup'; this.dependencies.remember(this.owner!, checkpoint);
      const operation = this.dependencies.remove(checkpoint.takeId, true); this.active = operation;
      try { await operation.promise; }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    }
    if (!this.valid(generation)) return;
    let warning = '';
    try { await this.dependencies.refreshMemory(); } catch { warning = '反馈已完成，练习记忆暂未刷新，请稍后重试。'; }
    if (!this.valid(generation)) return;
    try { this.dependencies.remember(this.owner!, null); } catch { warning = '处理已完成，但本地恢复记录暂未清理。'; }
    this.dependencies.releaseClip();
    this.update({ phase: 'done', attempt, error: warning,
      takeId: checkpoint.mode === 'analyze_only' ? null : checkpoint.takeId });
    this.releasePoller?.(); this.releasePoller = undefined; this.active = undefined;
  }
}
