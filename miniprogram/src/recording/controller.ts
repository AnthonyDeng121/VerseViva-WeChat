import { ApiError, friendlyError } from '../network/client.ts';

export type RecordingSelection = {
  songId: string; trackSlotId: string; sentenceIds: string[]; vocalPartId?: string;
  selectionType: 'sentence' | 'segment'; selectionStartSeconds: number; selectionEndSeconds: number;
  timelineStartSeconds: number; latencyCompensationMs: number; manualOffsetMs: number;
};
export type RecordingEvent = { kind: string; atMs: number; positionSeconds?: number };
export type RecordingClip = { filePath: string; durationSeconds: number; ownerId: string;
  selection: RecordingSelection; events: RecordingEvent[] };
export type RecordingSnapshot = {
  phase: 'idle' | 'authorizing' | 'preloading' | 'countdown' | 'starting' | 'recording' | 'stopping' | 'preview' | 'interrupted' | 'error';
  countdown: number; error: string; clip: RecordingClip | null;
};
export type RecorderDriver = {
  start(durationMs: number): void; stop(): void;
  onStart(callback: () => void): void;
  onStop(callback: (result: { tempFilePath: string; duration: number; fileSize: number }) => void): void;
  onError(callback: () => void): void; onInterruption(callback: () => void): void;
};
export class RecorderController {
  private driver?: RecorderDriver;
  private generation = 0;
  private active: { ownerId: string; selection: RecordingSelection; started: boolean; discard: boolean;
    expectedStop: boolean; originMs: number; events: RecordingEvent[] } | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private countdownResolve?: () => void;
  private state: RecordingSnapshot = { phase: 'idle', countdown: 0, error: '', clip: null };
  private listeners = new Set<() => void>();
  constructor(private dependencies: {
    driver(): RecorderDriver; owner(): string | null; authorize(): Promise<void>;
    prepare(selection: RecordingSelection): Promise<void>; playReference(): void;
    stopReference(): void; remove(path: string): Promise<void>; now?(): number;
    delay?(ms: number, callback: () => void): ReturnType<typeof setTimeout>;
    cancel?(handle: ReturnType<typeof setTimeout>): void;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private now() { return this.dependencies.now?.() ?? Date.now(); }
  private clearTimer() {
    if (this.timer !== undefined) (this.dependencies.cancel ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }
  private update(value: Partial<RecordingSnapshot>) {
    this.state = { ...this.state, ...value }; this.listeners.forEach((fn) => fn());
  }
  private event(kind: string, positionSeconds?: number) {
    if (this.active && this.active.events.length < 96) this.active.events.push({ kind,
      atMs: Math.max(0, this.now() - this.active.originMs), ...(positionSeconds !== undefined ? { positionSeconds } : {}) });
  }
  evidence(kind: string, positionSeconds: number) { this.event(kind, positionSeconds); }
  private attachDriver() {
    if (this.driver) return;
    this.driver = this.dependencies.driver();
    this.driver.onStart(() => {
      const active = this.active;
      if (!active || active.discard || this.state.phase !== 'starting') { this.driver?.stop(); return; }
      active.started = true; this.event('recorder_started');
      this.update({ phase: 'recording' });
      try { this.event('reference_play_requested'); this.dependencies.playReference(); }
      catch { this.interrupt('参考播放未能开始，请重新录制。'); return; }
      if (this.active !== active || active.discard) return;
      this.clearTimer();
      this.timer = this.delay((active.selection.selectionEndSeconds - active.selection.selectionStartSeconds) * 1000,
        () => this.stop());
    });
    this.driver.onStop((result) => {
      this.clearTimer();
      const active = this.active; this.active = null;
      this.dependencies.stopReference();
      if (!active || active.discard || !active.started || !active.expectedStop
        || active.ownerId !== this.dependencies.owner() || result.duration < 250 || !result.tempFilePath
        || result.fileSize <= 0 || result.fileSize > 100 * 1024 * 1024) {
        if (result.tempFilePath) void this.dependencies.remove(result.tempFilePath);
        if (active && !active.discard) this.update({ phase: 'interrupted', error: '录音未完整结束，请重新录制。' });
        return;
      }
      active.events.push({ kind: 'recorder_stopped', atMs: Math.max(0, this.now() - active.originMs) });
      this.update({ phase: 'preview', clip: { filePath: result.tempFilePath,
        durationSeconds: result.duration / 1000, ownerId: active.ownerId,
        selection: active.selection, events: active.events }, error: '' });
    });
    this.driver.onError(() => {
      if (!this.active) return;
      if (this.active) this.active.discard = true;
      this.active = null; this.clearTimer(); this.dependencies.stopReference();
      this.update({ phase: 'error', error: '录音失败，请检查麦克风权限和微信版本后重试。' });
    });
    this.driver.onInterruption(() => this.interrupt('录音被系统中断，请重新录制。'));
  }
  private delay(ms: number, callback: () => void) {
    return this.dependencies.delay?.(ms, callback) ?? setTimeout(callback, ms);
  }
  async start(selection: RecordingSelection): Promise<void> {
    if (this.active || ['authorizing', 'preloading', 'countdown'].includes(this.state.phase)) {
      throw new ApiError('configuration', '录音器尚未结束，请稍后重试。');
    }
    const ownerId = this.dependencies.owner();
    if (!ownerId) throw new ApiError('authentication', '请先微信登录后录音。');
    const seconds = selection.selectionEndSeconds - selection.selectionStartSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new ApiError('configuration', '请选择 10 分钟以内的有效录音范围。');
    this.discard(); const generation = ++this.generation;
    const valid = () => generation === this.generation && ownerId === this.dependencies.owner();
    this.update({ phase: 'authorizing', error: '' });
    try {
      await this.dependencies.authorize(); if (!valid()) return;
      this.update({ phase: 'preloading' }); await this.dependencies.prepare(selection);
      if (!valid()) { this.dependencies.stopReference(); return; }
      for (let count = 3; count > 0; count -= 1) {
        this.update({ phase: 'countdown', countdown: count });
        await new Promise<void>((resolve) => { this.countdownResolve = resolve; this.timer = this.delay(1000, resolve); });
        this.countdownResolve = undefined;
        if (!valid()) return;
      }
      this.attachDriver();
      this.active = { ownerId, selection: { ...selection, sentenceIds: [...selection.sentenceIds] }, started: false, discard: false,
        expectedStop: false, originMs: this.now(), events: [] };
      this.event('recorder_start_requested'); this.update({ phase: 'starting', countdown: 0 });
      this.timer = this.delay(5000, () => this.interrupt('录音启动超时，请重新尝试。'));
      this.driver!.start(Math.min(600000, Math.ceil(seconds * 1000) + 1000));
    } catch (error) {
      if (valid()) { this.dependencies.stopReference(); this.update({ phase: 'error', error: friendlyError(error) }); }
    }
  }
  stop() {
    if (!this.active?.started || this.state.phase !== 'recording') return;
    this.clearTimer(); this.active.expectedStop = true; this.event('recorder_stop_requested');
    this.update({ phase: 'stopping' }); this.dependencies.stopReference(); this.driver?.stop();
  }
  interrupt(message = '录音已中断，请重新录制。') {
    if (!['authorizing', 'preloading', 'countdown', 'starting', 'recording', 'stopping'].includes(this.state.phase)) return;
    this.generation += 1; this.clearTimer(); this.countdownResolve?.(); this.countdownResolve = undefined;
    this.event('interrupted'); if (this.active) this.active.discard = true;
    this.dependencies.stopReference();
    this.update({ phase: 'interrupted', countdown: 0, error: message });
    if (this.active) this.driver?.stop();
  }
  discard() {
    this.interrupt();
    if (this.state.clip) this.dependencies.stopReference();
    if (this.state.clip) void this.dependencies.remove(this.state.clip.filePath);
    this.update({ clip: null });
    if (!this.active) this.update({ phase: 'idle', error: '', countdown: 0 });
  }
}
