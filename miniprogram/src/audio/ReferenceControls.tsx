import { useEffect, useRef, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import { useDidHide } from '@tarojs/taro';
import type { RecordingSelection } from '../recording/controller';
import { player, usePlayer, useRecording } from '../recording/runtime';
import { audioResources } from './resources';
import type { AudioLease } from './downloads';
import type { Operation } from '../network/client';
import { friendlyError } from '../network';

export function ReferenceControls({ songId, selection }: { songId: string; selection: RecordingSelection | null }) {
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
  useEffect(() => {
    if (!locked) { cancel(); player.reset(); }
  }, [songId, selection?.selectionStartSeconds, selection?.selectionEndSeconds]);
  async function play() {
    cancel(); const current = generation.current; setBusy(true); setError('');
    try {
      operation.current = audioResources.acquire({ kind: 'reference', songId, asset });
      const lease = await operation.current.promise;
      if (current !== generation.current) { lease.release(); return; }
      await player.load(lease, selection?.selectionStartSeconds ?? 0);
      if (current !== generation.current) return;
      loadedVersion.current = player.getVersion();
      await player.seek(selection?.selectionStartSeconds ?? 0);
      if (current !== generation.current) return;
      player.setRate(rate);
      player.setRange(selection ? { start: selection.selectionStartSeconds, end: selection.selectionEndSeconds, loop } : null);
      player.play();
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) { setBusy(false); operation.current = null; } }
  }
  return <View className='card'><Text className='card-title'>参考播放</Text>
    {([['source', '原曲'], ['vocals', '人声'], ['accompaniment', '伴奏']] as const).map(([value, label]) =>
      <Button key={value} disabled={locked || busy} onClick={() => { player.reset(); setAsset(value); }}>{asset === value ? '✓ ' : ''}{label}</Button>)}
    <Button disabled={locked || busy} onClick={() => { const next = rate === 1 ? 0.75 : 1; setRate(next);
      if (ownsPlayback && state.phase !== 'idle') { try { player.setRate(next); } catch (reason) { setError(friendlyError(reason)); setRate(1); } } }}>{rate}× · 点击切换</Button>
    <Button disabled={locked || busy || !selection} onClick={() => { const next = !loop; setLoop(next);
      if (ownsPlayback && state.phase !== 'idle' && selection) player.setRange({ start: selection.selectionStartSeconds, end: selection.selectionEndSeconds, loop: next }); }}>句范围循环：{loop ? '开' : '关'}</Button>
    <Button disabled={locked || busy} onClick={() => void play()}>{busy ? '正在准备…' : '从选句起点播放'}</Button>
    <Button disabled={locked || !ownsPlayback || state.phase !== 'playing'} onClick={() => player.pause()}>暂停</Button>
    <Button disabled={locked || !ownsPlayback || state.phase !== 'paused'} onClick={() => player.play()}>继续</Button>
    <Text className='muted'>当前位置 {state.timeSeconds.toFixed(1)} 秒。句循环使用微信播放事件与计时控制，精度以真机为准。</Text>
    {(error || state.error) && <Text className='muted'>{error || state.error}</Text>}
  </View>;
}
