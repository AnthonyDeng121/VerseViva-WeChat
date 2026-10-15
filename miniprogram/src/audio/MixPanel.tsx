import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, ScrollView, Slider, Text, View } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import type { MixOptions, Take } from '../network/api';
import { registerForegroundTask } from '../network/lifecycle';
import { practiceApi } from '../recording/submission';
import { player, usePlayer } from '../recording/runtime';
import { audioResources } from './resources';
import { MixController } from './mixController';
import { calculateTimelinePlacement, offsetFromDrag } from '../../../shared/audioTimeline';
import { formatTime, touchClientX } from '../ui/practiceLayout';
import type { AudioLease } from './downloads';
import type { Operation } from '../network/client';

export function MixPanel({ songId, owner, takes, disabled, onClose, onPatch }: {
  songId: string; owner: string; takes: Take[]; disabled: boolean; onClose(): void;
  onPatch(id: string, changes: { manualOffsetMs?: number; muted?: boolean }, commit: boolean): void;
}) {
  const storageKey = `verseviva:mix:v1:${encodeURIComponent(VERSEVIVA_API_ORIGIN)}:${owner}:${songId}`;
  const [draft] = useState(() => readOptions(storageKey));
  const playback = usePlayer(); const loadedVersion = useRef<number | null>(null);
  const ownsPlayback = loadedVersion.current === player.getVersion();
  const [bed, setBed] = useState((draft?.accompanimentVolume ?? .55) * 100);
  const [voice, setVoice] = useState((draft?.voiceVolume ?? 1) * 100);
  const [master, setMaster] = useState((draft?.masterGain ?? 1) * 100);
  const [progress, setProgress] = useState(0); const progressRef = useRef(progress); progressRef.current = progress;
  const [exportError, setExportError] = useState('');
  const drag = useRef<{ id: string; x: number; offset: number; latest: number; width: number } | null>(null);
  const gesture = useRef(0);
  const exportOperation = useRef<Operation<AudioLease> | null>(null);
  const rangeStart = Math.min(...takes.map((take) => take.selectionStartSeconds ?? take.timelineStartSeconds ?? 0));
  const rangeEnd = Math.max(...takes.map((take) => take.selectionEndSeconds ?? (take.timelineStartSeconds ?? 0) + 1));
  const duration = Math.max(.05, rangeEnd - rangeStart);
  const selected = takes;
  const options = { takeIds: selected.map((take) => take.takeId).sort(), accompanimentVolume: bed / 100,
    voiceVolume: voice / 100, masterGain: master / 100 };
  const signature = JSON.stringify({ options, takes: selected.map((take) => [take.takeId, take.isCurrent,
    take.timelineStartSeconds, take.selectionStartSeconds, take.selectionEndSeconds,
    take.latencyCompensationMs, take.manualOffsetMs, take.gain, take.muted]) });
  const signatureRef = useRef(signature); signatureRef.current = signature;
  const optionsRef = useRef(options); optionsRef.current = options;
  const controller = useMemo(() => new MixController({
    start: (value) => practiceApi.startMix(songId, value), status: (id) => practiceApi.mixJob(id),
    acquire: (jobId) => audioResources.acquire({ kind: 'mix-job', jobId }),
    async play(lease, job) { const start = Math.min(progressRef.current, Math.max(0, job.rangeEndSeconds - job.rangeStartSeconds - .05));
      await player.load(lease, start, undefined, job.rangeStartSeconds);
      loadedVersion.current = player.getVersion(); await player.seek(start); player.setRate(1); player.play(); },
    remember(jobId) {
      if (jobId) Taro.setStorageSync(storageKey, { jobId, signature: signatureRef.current, options: optionsRef.current });
      else Taro.removeStorageSync(storageKey);
    },
    read() { try { const saved = Taro.getStorageSync(storageKey);
      return saved?.signature === signatureRef.current ? saved.jobId : null; } catch { return null; } },
    watch: (poller) => registerForegroundTask(poller),
  }), [songId, owner, storageKey]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const previous = useRef(signature);
  useEffect(() => { void controller.restore(); return () => { exportOperation.current?.abort(); exportOperation.current = null; controller.dispose(); }; }, [controller]);
  useEffect(() => { if (previous.current !== signature) { exportOperation.current?.abort(); exportOperation.current = null; controller.invalidate(); setProgress(0); } previous.current = signature; }, [controller, signature]);
  useEffect(() => { if (disabled) controller.invalidate(); }, [controller, disabled]);
  useDidHide(() => controller.hide()); useDidShow(() => controller.show());
  const busy = ['starting', 'waiting', 'loading'].includes(state.phase);
  function beginDrag(take: Take, x: number) {
    if (disabled) return;
    const token = ++gesture.current;
    const version = signatureRef.current;
    Taro.createSelectorQuery().select('#mix-bed-' + take.takeId).boundingClientRect((rect) => {
      const value = Array.isArray(rect) ? rect[0] : rect;
      if (!value?.width || signatureRef.current !== version || token !== gesture.current) return;
      drag.current = { id: take.takeId, x, offset: take.manualOffsetMs ?? 0, latest: take.manualOffsetMs ?? 0, width: value.width };
    }).exec();
  }
  function moveDrag(x: number) {
    const current = drag.current; if (!current || disabled) return;
    current.latest = offsetFromDrag({ originalOffsetMs: current.offset, deltaPixels: x - current.x, laneWidthPixels: current.width, timelineDurationSeconds: duration });
    onPatch(current.id, { manualOffsetMs: current.latest }, false);
  }
  function endDrag() {
    gesture.current++;
    const current = drag.current; drag.current = null;
    if (current && !disabled) onPatch(current.id, { manualOffsetMs: current.latest }, true);
  }
  async function exportMix() {
    if (!state.job || state.phase !== 'ready' || disabled) return;
    setExportError('');
    const version = signatureRef.current;
    const operation = audioResources.acquire({ kind: 'mix-job', jobId: state.job.jobId });
    exportOperation.current?.abort(); exportOperation.current = operation;
    try { const lease = await operation.promise;
      try { if (version !== signatureRef.current || exportOperation.current !== operation) return;
        await Taro.shareFileMessage({ filePath: lease.path, fileName: 'VerseViva-混音.mp3' });
      } finally { lease.release(); }
    } catch { if (exportOperation.current === operation) setExportError('导出未完成，请稍后重试。'); }
    finally { if (exportOperation.current === operation) exportOperation.current = null; }
  }
  const shownProgress = ownsPlayback && playback.songTimeSeconds !== null ? Math.max(0, playback.songTimeSeconds - rangeStart) : progress;
  return <View className='mix-modal-backdrop' onClick={onClose}>
    <View className='mix-modal' onClick={(event) => event.stopPropagation()}>
      <View className='mix-modal-header'>
        <View><Text className='eyebrow'>多轨混音</Text><Text className='mix-title'>对齐伴奏与人声</Text></View>
        <Button className='icon-button' onClick={onClose}>×</Button>
      </View>
      <Text className='mix-modal-note'>伴奏是固定时间轴；拖动下方人声片段来对齐。中间没有录音的区间仍会完整播放伴奏。</Text>
      <ScrollView className='mix-timeline-scroll' scrollX>
        <View className='mix-ruler'><Text>{formatTime(rangeStart)}</Text><Text>{formatTime(rangeStart + duration / 2)}</Text><Text>{formatTime(rangeEnd)}</Text></View>
        <View className='mix-lanes'>
          <View className='mix-lane accompaniment-lane'>
            <View className='mix-lane-label'><Text className='mix-track-title'>伴奏</Text><Text>基准 · 不可拖动</Text></View>
            <View className='mix-lane-bed'><View className='wave-pattern accompaniment-wave' /></View>
          </View>
          {takes.map((take, index) => {
            const placement = calculateTimelinePlacement({ timelineStartSeconds: take.timelineStartSeconds ?? 0, latencyCompensationMs: take.latencyCompensationMs ?? 0,
              manualOffsetMs: take.manualOffsetMs ?? 0, rangeStartSeconds: rangeStart, rangeDurationSeconds: duration, bufferDurationSeconds: Infinity });
            const left = ((placement.clipStartSeconds - rangeStart) / duration) * 100;
            const width = Math.max(2, ((take.selectionEndSeconds ?? rangeEnd) - (take.selectionStartSeconds ?? rangeStart)) / duration * 100);
            return <View className={`mix-lane ${take.muted ? 'muted' : ''}`} key={take.takeId}>
              <View className='mix-lane-label'><Text className='mix-track-title'>{take.displayName || `录音 ${index + 1}`}</Text>
                <Text>{take.manualOffsetMs ?? 0} ms</Text>
                <Button className={`mute-button ${take.muted ? 'active' : ''}`} disabled={disabled} onClick={() => onPatch(take.takeId, { muted: !take.muted }, true)}>{take.muted ? '🔇' : '🔊'}</Button>
              </View>
              <View className='mix-lane-bed' id={`mix-bed-${take.takeId}`}>
                <View className='mix-clip' style={{ left: `${left}%`, width: `${width}%` }}
                  catchMove
                  onTouchStart={(event) => { const x = touchClientX(event); if (x !== null) beginDrag(take, x); }}
                  onTouchMove={(event) => { event.stopPropagation(); const x = touchClientX(event); if (x !== null) moveDrag(x); }}
                  onTouchEnd={endDrag} onTouchCancel={endDrag}>
                  <Text>{take.displayName}</Text><View className='wave-pattern' />
                </View>
              </View>
            </View>;
          })}
          <View className='mix-playhead' style={{ left: `${Math.min(1, shownProgress / duration) * 1240}rpx` }} />
        </View>
      </ScrollView>
      <View className='mix-master-controls'>
        <View><Text>整体伴奏音量</Text><Slider min={0} max={100} value={bed} disabled={disabled} onChange={(event) => setBed(event.detail.value)} /></View>
        <View><Text>整体人声音量</Text><Slider min={0} max={100} value={voice} disabled={disabled} onChange={(event) => setVoice(event.detail.value)} /></View>
        <View><Text>整体增益 {master}%</Text><Slider min={0} max={200} value={master} disabled={disabled} onChange={(event) => setMaster(event.detail.value)} /></View>
      </View>
      <View className='mix-modal-footer'>
        <View className='mix-progress-control'><Text>{formatTime(shownProgress)} / {formatTime(duration)}</Text>
          <Slider min={0} max={duration} step={.05} value={Math.min(duration, shownProgress)} disabled={disabled || (ownsPlayback && playback.phase === 'playing')}
            onChange={(event) => { setProgress(event.detail.value); if (ownsPlayback && playback.phase !== 'idle') void player.seek(event.detail.value).catch(() => {}); }} />
        </View>
        <Button className='primary-button' disabled={disabled || busy || !takes.length} onClick={() => {
          if (ownsPlayback && playback.phase === 'playing') { player.reset(); loadedVersion.current = null; setProgress(0); }
          else if (state.phase === 'ready') void controller.play();
          else void controller.generate(options);
        }}>{busy ? state.phase === 'loading' ? '正在准备音频…' : '正在生成…' : ownsPlayback && playback.phase === 'playing' ? '停止整体试听' : state.phase === 'ready' ? '播放整体混音' : '生成整体混音'}</Button>
        <Button className='secondary-button' disabled={disabled || state.phase !== 'ready'} onClick={() => void exportMix()}>下载整体混音</Button>
      </View>
      <Text className='mix-modal-note'>小程序生成单个成品后试听，修改参数后需重新生成。导出使用微信文件转存界面。</Text>
      {state.error && <Text className='recording-error'>{state.error}</Text>}
      {exportError && <Text className='recording-error'>{exportError}</Text>}
    </View>
  </View>;
}

function readOptions(key: string): MixOptions | null {
  try {
    const value = Taro.getStorageSync(key)?.options as MixOptions | undefined;
    if (!value || !Array.isArray(value.takeIds) || !value.takeIds.length || value.takeIds.length > 32
      || !value.takeIds.every((id) => typeof id === 'string' && /^take_[a-f0-9]{32}$/.test(id))
      || ![value.accompanimentVolume, value.voiceVolume].every((gain) => Number.isFinite(gain) && gain >= 0 && gain <= 1)
      || !Number.isFinite(value.masterGain) || value.masterGain < 0 || value.masterGain > 2) return null;
    return value;
  } catch { return null; }
}
