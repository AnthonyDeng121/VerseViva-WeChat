import { ApiError } from '../network/client.ts';
import type { AudioLease } from './downloads.ts';

export type NativeAudio = {
  src: string; startTime: number; autoplay: boolean; loop: boolean; playbackRate: number;
  currentTime: number; duration: number;
  play(): void; pause(): void; stop(): void; seek(seconds: number): void; destroy(): void;
  onCanplay(fn: () => void): void; onPlay(fn: () => void): void; onPause(fn: () => void): void;
  onStop(fn: () => void): void; onEnded(fn: () => void): void; onError(fn: () => void): void;
  onTimeUpdate(fn: () => void): void; onWaiting(fn: () => void): void; onSeeked(fn: () => void): void;
};
export type PlayerSnapshot = { phase: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';
  timeSeconds: number; songTimeSeconds: number | null; durationSeconds: number; rate: 1 | 0.75; error: string };
export type PlaybackEvent = { kind: 'playing' | 'pause' | 'stop' | 'ended' | 'waiting' | 'seek' | 'error';
  atMs: number; positionSeconds: number };

// Exactly one native context for reference, recording backing and preview.
export class LocalPlayer {
  private audio?: NativeAudio;
  private lease?: AudioLease;
  private releaseListener?: () => void;
  private generation = 0;
  private lockOwner: string | null = null;
  private loadReject?: (error: Error) => void;
  private pendingSeek?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private range: { start: number; end: number; loop: boolean } | null = null;
  private boundaryTimer?: ReturnType<typeof setTimeout>;
  private foreground = true;
  private songTimeOffset: number | null = null;
  private state: PlayerSnapshot = { phase: 'idle', timeSeconds: 0, songTimeSeconds: null, durationSeconds: 0, rate: 1, error: '' };
  private listeners = new Set<() => void>();
  private events = new Set<(event: PlaybackEvent) => void>();
  constructor(private create: () => NativeAudio, private now = () => Date.now()) {}
  getSnapshot = () => this.state;
  getVersion = () => this.generation;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  onEvent(callback: (event: PlaybackEvent) => void) { this.events.add(callback); return () => { this.events.delete(callback); }; }
  private update(value: Partial<PlayerSnapshot>) {
    if (value.timeSeconds !== undefined) value.songTimeSeconds = this.songTimeOffset === null ? null : value.timeSeconds + this.songTimeOffset;
    this.state = { ...this.state, ...value }; this.listeners.forEach((fn) => fn());
  }
  private emit(kind: PlaybackEvent['kind']) {
    const positionSeconds = this.audio?.currentTime ?? this.state.timeSeconds;
    this.events.forEach((fn) => fn({ kind, atMs: this.now(), positionSeconds }));
  }
  lock(owner: string) {
    if (this.lockOwner && this.lockOwner !== owner) throw new ApiError('configuration', '录音期间不能切换播放。');
    this.lockOwner = owner;
  }
  unlock(owner: string) { if (this.lockOwner === owner) this.lockOwner = null; }
  private check(owner?: string) {
    if (this.lockOwner && this.lockOwner !== owner) throw new ApiError('configuration', '请先结束录音再操作播放。');
  }
  async load(lease: AudioLease, startSeconds = 0, owner?: string, songTimeOffset: number | null = null): Promise<void> {
    if (!this.foreground) { lease.release(); throw new ApiError('cancelled', '页面已隐藏，播放已取消。'); }
    this.check(owner); this.reset(owner);
    this.songTimeOffset = songTimeOffset;
    const generation = this.generation;
    this.lease = lease;
    let audio: NativeAudio;
    try { audio = this.create(); } catch { lease.release(); throw new ApiError('configuration', '当前微信音频能力不可用。'); }
    this.audio = audio;
    audio.autoplay = false; audio.loop = false; audio.playbackRate = 1; audio.startTime = startSeconds;
    this.update({ phase: 'loading', timeSeconds: startSeconds, rate: 1, error: '' });
    this.releaseListener = lease.onRelease(() => { if (this.audio === audio) this.reset(owner); });
    const current = () => generation === this.generation && this.audio === audio;
    audio.onPlay(() => { if (current()) { this.update({ phase: 'playing' }); this.emit('playing'); this.scheduleBoundary(); } });
    audio.onPause(() => { if (current()) { clearTimeout(this.boundaryTimer); this.update({ phase: 'paused' }); this.emit('pause'); } });
    audio.onStop(() => { if (current()) { clearTimeout(this.boundaryTimer); this.update({ phase: 'ready' }); this.emit('stop'); } });
    audio.onEnded(() => { if (current()) {
      clearTimeout(this.boundaryTimer);
      if (this.range?.loop) { this.update({ phase: 'playing' }); this.boundary(); }
      else { this.update({ phase: 'ready' }); this.emit('ended'); }
    } });
    audio.onWaiting(() => { if (current()) this.emit('waiting'); });
    audio.onTimeUpdate(() => {
      if (current()) this.update({ timeSeconds: audio.currentTime,
        durationSeconds: audio.duration > 0 ? audio.duration : this.state.durationSeconds });
      if (current()) this.scheduleBoundary();
    });
    audio.onSeeked(() => {
      if (!current()) return;
      this.update({ timeSeconds: audio.currentTime }); this.emit('seek');
      const pending = this.pendingSeek; this.pendingSeek = undefined;
      if (pending) { clearTimeout(pending.timer); pending.resolve(); }
      this.scheduleBoundary();
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); this.loadReject = undefined;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        if (current()) this.update({ phase: 'error', error: '音频准备超时，请重新加载。' });
        finish(new ApiError('timeout', '音频准备超时，请重新加载。'));
      }, 15000);
      this.loadReject = (error) => finish(error);
      audio.onCanplay(() => { if (current() && !settled) { this.update({ phase: 'ready' }); finish(); } });
      audio.onError(() => {
        if (!current()) return;
        this.update({ phase: 'error', error: '音频播放失败，请重新加载。' }); this.emit('error');
        finish(new ApiError('invalid_response', '音频播放失败，请重新加载。'));
      });
      try { audio.src = lease.path; } catch { finish(new ApiError('authentication', '音频已失效，请重新加载。')); }
    });
  }
  play(owner?: string) {
    if (!this.foreground) throw new ApiError('cancelled', '页面已隐藏，播放已取消。');
    this.check(owner);
    if (!this.audio || !['ready', 'paused', 'playing'].includes(this.state.phase)) {
      throw new ApiError('configuration', '请先准备音频。');
    }
    void this.lease?.path; this.audio.play();
  }
  pause(owner?: string) { this.check(owner); this.audio?.pause(); }
  seek(seconds: number, owner?: string): Promise<void> {
    this.check(owner);
    if (!this.audio || !Number.isFinite(seconds) || seconds < 0 || this.state.phase === 'loading') {
      return Promise.reject(new ApiError('configuration', '当前无法跳转，请先加载音频。'));
    }
    if (this.pendingSeek) return Promise.reject(new ApiError('configuration', '音频正在跳转，请稍候。'));
    const audio = this.audio;
    if (Math.abs(audio.currentTime - seconds) < 0.01) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSeek = undefined; reject(new ApiError('timeout', '音频跳转未确认，请重试。'));
      }, 5000);
      this.pendingSeek = { resolve, reject, timer };
      try { audio.seek(seconds); }
      catch { clearTimeout(timer); this.pendingSeek = undefined; reject(new ApiError('invalid_response', '音频跳转失败。')); }
    });
  }
  setRate(rate: 1 | 0.75, owner?: string) {
    this.check(owner);
    if (!this.audio) throw new ApiError('configuration', '请先加载音频。');
    try {
      this.audio.playbackRate = rate;
      if (this.audio.playbackRate !== rate) throw new Error('unsupported rate');
    } catch { throw new ApiError('configuration', '当前微信不支持该播放速度，请使用原速。'); }
    this.update({ rate }); this.scheduleBoundary();
  }
  setRange(range: { start: number; end: number; loop: boolean } | null, owner?: string) {
    this.check(owner);
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end)
      || range.start < 0 || range.end <= range.start)) throw new ApiError('configuration', '循环范围无效。');
    this.range = range; this.scheduleBoundary();
  }
  private scheduleBoundary() {
    clearTimeout(this.boundaryTimer);
    if (!this.range || this.state.phase !== 'playing' || !this.audio || this.pendingSeek) return;
    const remaining = this.range.end - this.audio.currentTime;
    if (remaining <= 0) { this.boundary(); return; }
    this.boundaryTimer = setTimeout(() => this.boundary(), remaining / this.state.rate * 1000);
  }
  private boundary() {
    if (!this.range || !this.audio || this.state.phase !== 'playing' || this.pendingSeek) return;
    if (this.audio.currentTime < this.range.end - 0.03) { this.scheduleBoundary(); return; }
    const range = this.range;
    if (!range.loop) { this.audio.pause(); return; }
    const generation = this.generation;
    void this.seek(range.start).then(() => {
      if (generation === this.generation && this.audio && this.range?.loop) this.audio.play();
    }).catch((error) => { if (generation === this.generation) {
      this.audio?.pause(); this.update({ phase: 'error', error: error.message });
    } });
  }
  setForeground(visible: boolean) {
    this.foreground = visible;
    if (!visible) { this.lockOwner = null; this.reset(); }
  }
  reset(owner?: string) {
    this.check(owner); this.generation += 1;
    this.songTimeOffset = null;
    clearTimeout(this.boundaryTimer); this.range = null;
    if (this.pendingSeek) { clearTimeout(this.pendingSeek.timer); this.pendingSeek.reject(new ApiError('cancelled', '音频跳转已取消。')); this.pendingSeek = undefined; }
    this.loadReject?.(new ApiError('cancelled', '音频加载已取消。')); this.loadReject = undefined;
    this.releaseListener?.(); this.releaseListener = undefined;
    const audio = this.audio; this.audio = undefined;
    if (audio) { try { audio.stop(); audio.destroy(); } catch { /* Native context may already be gone. */ } }
    this.lease?.release(); this.lease = undefined;
    this.update({ phase: 'idle', timeSeconds: 0, durationSeconds: 0, error: '' });
  }
}
