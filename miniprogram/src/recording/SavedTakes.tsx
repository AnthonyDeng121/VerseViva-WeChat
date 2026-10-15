import { useEffect, useRef, useState } from 'react';
import { Button, Slider, Switch, Text, View } from '@tarojs/components';
import { MixPanel } from '../audio/MixPanel';
import Taro from '@tarojs/taro';
import { useDidHide } from '@tarojs/taro';
import type { Operation } from '../network/client';
import type { AudioLease } from '../audio/downloads';
import { useAuth } from '../auth';
import { audioResources } from '../audio/resources';
import { friendlyError } from '../network';
import type { Take } from '../network/api';
import { invalidateMemory, practiceApi, useMemoryRevision, useSubmission } from './submission';
import { player, useRecording } from './runtime';

export function SavedTakes({ songId }: { songId: string }) {
  const owner = useAuth().ownerId; const revision = useMemoryRevision(); const work = useSubmission();
  const recording = useRecording();
  const [takes, setTakes] = useState<Take[]>([]); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState('');
  const generation = useRef(0); const downloading = useRef<Operation<AudioLease> | null>(null);
  const cancel = () => { generation.current += 1; downloading.current?.abort(); downloading.current = null; setBusy(false); };
  useDidHide(cancel);
  useEffect(() => { cancel(); setTakes([]); setLoadedFor(''); return cancel; }, [songId, owner]);
  const locked = !['idle', 'preview', 'error', 'interrupted'].includes(recording.phase);
  useEffect(() => {
    setError(''); if (!owner) return;
    let live = true; const operation = practiceApi.takes(songId);
    void operation.promise.then((value) => { if (live) { setTakes(value); setLoadedFor(`${songId}:${owner}`); } })
      .catch((reason) => { if (live) setError(friendlyError(reason)); });
    return () => { live = false; operation.abort(); };
  }, [songId, owner, revision]);
  async function act(take: Take, remove = false) {
    cancel(); const current = generation.current;
    setBusy(true); setError('');
    try {
      if (remove) {
        const answer = await Taro.showModal({ title: '删除录音', content: '将删除这条录音和对应分析反馈，是否继续？' });
        if (!answer.confirm || current !== generation.current) return;
        player.reset(); await practiceApi.deleteTake(take.takeId).promise;
        if (current === generation.current) { setTakes((value) => value.filter((item) => item.takeId !== take.takeId)); invalidateMemory(); }
      } else {
        downloading.current = audioResources.acquire({ kind: 'take', takeId: take.takeId });
        const lease = await downloading.current.promise;
        if (current !== generation.current) { lease.release(); return; }
        try { await player.load(lease); if (current === generation.current) player.play(); }
        catch (reason) { lease.release(); throw reason; }
      }
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) { setBusy(false); downloading.current = null; } }
  }
  async function update(take: Take, changes: { gain?: number; muted?: boolean; manualOffsetMs?: number }) {
    cancel(); const current = generation.current; setBusy(true); setError('');
    try { player.reset(); const updated = await practiceApi.updateTake(take.takeId, changes).promise;
      if (current === generation.current) { setTakes((value) => value.map((item) => item.takeId === updated.takeId ? updated : item)); invalidateMemory(); }
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  if (!owner) return null;
  const currentTakes = loadedFor === `${songId}:${owner}` ? takes.filter((take) => take.isCurrent !== false
    && !(work.mode === 'analyze_only' && take.takeId === work.takeId)) : [];
  return <View><View className='card'><Text className='card-title'>已保存录音</Text>
    {error && <Text className='muted'>{error}</Text>}
    {currentTakes.map((take, index) => <View key={take.takeId}>
      <Text>{take.displayName || `录音 ${index + 1}`}</Text>
      <Button disabled={busy || locked} onClick={() => void act(take)}>试听</Button>
      <Button disabled={busy || locked} onClick={() => void act(take, true)}>删除录音及反馈</Button>
      <Text className='muted'>时间轴起点 {(take.timelineStartSeconds ?? 0).toFixed(2)} 秒；设备补偿 {take.latencyCompensationMs ?? 0} ms</Text>
      <Text>音轨音量 {Math.round((take.gain ?? 1) * 100)}%</Text>
      <Slider min={0} max={200} value={Math.round((take.gain ?? 1) * 100)} disabled={busy || locked}
        onChange={(event) => void update(take, { gain: event.detail.value / 100 })} />
      <Text>手动偏移 {take.manualOffsetMs ?? 0} ms（正值提前，负值延后）</Text>
      <Slider min={-2000} max={2000} step={10} value={take.manualOffsetMs ?? 0} disabled={busy || locked}
        onChange={(event) => void update(take, { manualOffsetMs: event.detail.value })} />
      <Switch checked={take.muted ?? false} disabled={busy || locked}
        onChange={(event) => void update(take, { muted: event.detail.value })} /><Text>静音</Text>
    </View>)}
    {!currentTakes.length && <Text className='muted'>还没有保存的录音。</Text>}
  </View>{loadedFor === `${songId}:${owner}` && <MixPanel key={`${songId}:${owner}`} songId={songId} owner={owner}
    takes={currentTakes} disabled={busy || locked} />}</View>;
}
