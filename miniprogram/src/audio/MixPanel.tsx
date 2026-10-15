import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Slider, Switch, Text, View } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import type { MixOptions, Take } from '../network/api';
import { registerForegroundTask } from '../network/lifecycle';
import { practiceApi } from '../recording/submission';
import { player, usePlayer } from '../recording/runtime';
import { audioResources } from './resources';
import { MixController } from './mixController';

export function MixPanel({ songId, owner, takes, disabled }: {
  songId: string; owner: string; takes: Take[]; disabled: boolean;
}) {
  const storageKey = `verseviva:mix:v1:${encodeURIComponent(VERSEVIVA_API_ORIGIN)}:${owner}:${songId}`;
  const [draft] = useState(() => readOptions(storageKey));
  const [excluded, setExcluded] = useState<string[]>(() => draft
    ? takes.filter((take) => !draft.takeIds.includes(take.takeId)).map((take) => take.takeId) : []);
  const playback = usePlayer(); const loadedVersion = useRef<number | null>(null);
  const ownsPlayback = loadedVersion.current === player.getVersion();
  const [bed, setBed] = useState((draft?.accompanimentVolume ?? .55) * 100);
  const [voice, setVoice] = useState((draft?.voiceVolume ?? 1) * 100);
  const [master, setMaster] = useState((draft?.masterGain ?? 1) * 100);
  const selected = takes.filter((take) => !excluded.includes(take.takeId));
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
    async play(lease, job) { await player.load(lease, 0, undefined, job.rangeStartSeconds);
      loadedVersion.current = player.getVersion(); player.setRate(1); player.play(); },
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
  useEffect(() => { void controller.restore(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { if (previous.current !== signature) controller.invalidate(); previous.current = signature; }, [controller, signature]);
  useEffect(() => { if (disabled) controller.invalidate(); }, [controller, disabled]);
  useDidHide(() => controller.hide()); useDidShow(() => controller.show());
  const busy = ['starting', 'waiting', 'loading'].includes(state.phase);
  return <View className='card'><Text className='card-title'>多录音合成</Text>
    <Text className='muted'>服务端按同一伴奏时间轴合成 MP3。修改音轨或音量后需要重新生成；原始录音保持不变。</Text>
    {takes.map((take, index) => <View key={take.takeId}>
      <Switch checked={!excluded.includes(take.takeId)} disabled={disabled} onChange={(event) => {
        setExcluded(event.detail.value ? excluded.filter((id) => id !== take.takeId) : [...excluded, take.takeId]);
      }} /><Text>{take.displayName || `录音 ${index + 1}`}{take.muted ? '（静音，保留所选时间范围）' : ''}</Text>
    </View>)}
    <Text>伴奏 {bed}%</Text><Slider min={0} max={100} value={bed} disabled={disabled} onChange={(event) => setBed(event.detail.value)} />
    <Text>人声整体 {voice}%</Text><Slider min={0} max={100} value={voice} disabled={disabled} onChange={(event) => setVoice(event.detail.value)} />
    <Text>输出整体增益 {master}%</Text><Slider min={0} max={200} value={master} disabled={disabled} onChange={(event) => setMaster(event.detail.value)} />
    <Text className='muted'>较高音量可能削波，请降低各轨或整体增益。播放期间修改会停止旧成品，重新生成后才生效。</Text>
    <Button disabled={disabled || busy || !selected.length} onClick={() => void controller.generate(options)}>生成／重新生成合成</Button>
    {state.phase === 'starting' && <Text>正在提交合成任务…</Text>}
    {state.phase === 'waiting' && <Text>{state.job?.status === 'processing' ? '正在合成…' : '等待合成…'} 可切后台，返回后继续检查。</Text>}
    {state.job && <Text className='muted'>伴奏范围 {state.job.rangeStartSeconds.toFixed(2)}–{state.job.rangeEndSeconds.toFixed(2)} 秒，中间保持连续。</Text>}
    <Button disabled={disabled || state.phase !== 'ready'} onClick={() => void controller.play()}>下载并试听合成 MP3</Button>
    <Button disabled={disabled || !ownsPlayback || playback.phase !== 'playing'} onClick={() => player.pause()}>暂停合成</Button>
    <Button disabled={disabled || !ownsPlayback || playback.phase !== 'paused'} onClick={() => player.play()}>继续合成</Button>
    <Button disabled={disabled || !ownsPlayback || playback.phase === 'idle'} onClick={() => player.reset()}>停止合成</Button>
    {state.phase === 'loading' && <Text>正在准备合成音频…</Text>}
    {state.error && <Text className='muted'>{state.error}</Text>}
    {!takes.length && <Text className='muted'>先保存至少一条录音。</Text>}
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
