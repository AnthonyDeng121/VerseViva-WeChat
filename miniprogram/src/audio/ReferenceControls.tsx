import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button, Slider, Text, View } from '@tarojs/components';
import { useDidHide } from '@tarojs/taro';
import type { RecordingSelection } from '../recording/controller';
import { player, usePlayer, useRecording } from '../recording/runtime';
import { audioResources } from './resources';
import type { AudioLease } from './downloads';
import type { Operation } from '../network/client';
import { friendlyError } from '../network';
import { formatTime } from '../ui/practiceLayout';

export type ReferenceHandle = { seek(seconds: number): Promise<void> };
export const ReferenceControls = forwardRef<ReferenceHandle, {
  songId: string; title: string; selection: RecordingSelection | null; technique: boolean;
}>(function ReferenceControls({ songId, title, selection, technique }, ref) {
  const state = usePlayer(); const recording = useRecording();
  const [asset, setAsset] = useState<'source' | 'vocals' | 'accompaniment'>('source');
  const [rate, setRate] = useState<1 | 0.75>(1); const [loop, setLoop] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const operation = useRef<Operation<AudioLease> | null>(null); const generation = useRef(0);
  const loadedVersion = useRef<number | null>(null);
  const ownsPlayback = loadedVersion.current === player.getVersion();
  const locked = !['idle', 'preview', 'interrupted', 'error'].includes(recording.phase);
  const cancel = () => { generation.current += 1; operation.current?.abort(); operation.current = null; setBusy(false); };
  useDidHide(cancel); useEffect(() => cancel, []);
  useEffect(() => { if (!locked) { cancel(); player.reset(); loadedVersion.current = null; } }, [songId]);
  async function load(seconds: number, autoplay: boolean) {
    if (locked) return;
    cancel(); const current = generation.current; setBusy(true); setError('');
    try {
      if (loadedVersion.current !== player.getVersion() || player.getSnapshot().phase === 'idle') {
        operation.current = audioResources.acquire({ kind: 'reference', songId, asset });
        const lease = await operation.current.promise;
        if (current !== generation.current) { lease.release(); return; }
        await player.load(lease, seconds, undefined, 0);
        if (current !== generation.current) return;
        loadedVersion.current = player.getVersion();
      }
      await player.seek(seconds);
      if (current !== generation.current) return;
      player.setRate(rate);
      player.setRange(loop && selection ? { start: selection.selectionStartSeconds, end: selection.selectionEndSeconds, loop: true } : null);
      if (autoplay) player.play();
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) { setBusy(false); operation.current = null; } }
  }
  useImperativeHandle(ref, () => ({ seek: (seconds) => load(seconds, false) }));
  function selectAsset(next: typeof asset) { cancel(); player.reset(); loadedVersion.current = null; setAsset(next); }
  return <View>
    <View className='profile-heading'>
      <Text className='profile-title'>{title.replace(/\s*[—-]\s*Language\s*&\s*Vocal\s*Layers\s*$/i, '').trim()}</Text>
      <View className='audio-mode-switch'>
        {([['source', '原曲'], ['vocals', '人声'], ['accompaniment', '伴奏']] as const).map(([value, label]) =>
          <Button key={value} disabled={locked || busy} className={asset === value ? 'active' : ''} onClick={() => selectAsset(value)}>{label}</Button>)}
      </View>
    </View>
    <View className='players'><View className='native-player-row'>
      <Text>{asset === 'source' ? '原曲' : asset === 'vocals' ? '人声' : '伴奏'}</Text>
      <Button className='player-toggle' disabled={locked || busy} onClick={() => {
        if (ownsPlayback && state.phase === 'playing') player.pause();
        else if (ownsPlayback && state.phase === 'paused') player.play();
        else void load(ownsPlayback ? state.timeSeconds : 0, true);
      }}>{busy ? '…' : ownsPlayback && state.phase === 'playing' ? 'Ⅱ' : '▶'}</Button>
      <Text>{formatTime(ownsPlayback ? state.timeSeconds : 0)}</Text>
      <Slider className='player-progress' min={0} max={Math.max(state.durationSeconds, 1)} step={0.1}
        value={ownsPlayback ? state.timeSeconds : 0} disabled={locked || busy || !ownsPlayback}
        onChange={(event) => void load(event.detail.value, ownsPlayback && state.phase === 'playing')} />
      <Text>{formatTime(ownsPlayback ? state.durationSeconds : 0)}</Text>
    </View></View>
    <View className={technique ? 'learning-playback-controls' : 'hidden'}>
      <View className='speed-switch'>{([1, .75] as const).map((value) => <Button key={value} disabled={locked || busy} className={rate === value ? 'active' : ''} onClick={() => {
        setRate(value); if (ownsPlayback && state.phase !== 'idle') { try { player.setRate(value); } catch (reason) { setError(friendlyError(reason)); setRate(1); } }
      }}>{value === 1 ? '原速' : '0.75×'}</Button>)}</View>
      <Button className={`sentence-loop-button ${loop ? 'active' : ''}`} disabled={locked || busy || !selection} onClick={() => {
        const next = !loop; setLoop(next);
        if (ownsPlayback && selection) player.setRange(next ? { start: selection.selectionStartSeconds, end: selection.selectionEndSeconds, loop: true } : null);
      }}>{loop ? '停止循环' : '循环当前句'}</Button>
      <Text>点击歌词跳转</Text>
    </View>
    {(error || (ownsPlayback && state.error)) && <Text className='recording-error'>{error || state.error}</Text>}
  </View>;
});
