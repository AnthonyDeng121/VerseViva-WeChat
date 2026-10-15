import { useEffect, useRef, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
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
  const generation = useRef(0); const downloading = useRef<Operation<AudioLease> | null>(null);
  const cancel = () => { generation.current += 1; downloading.current?.abort(); downloading.current = null; setBusy(false); };
  useDidHide(cancel);
  useEffect(() => { cancel(); return cancel; }, [songId, owner]);
  const locked = !['idle', 'preview', 'error', 'interrupted'].includes(recording.phase);
  useEffect(() => {
    setTakes([]); setError(''); if (!owner) return;
    let live = true; const operation = practiceApi.takes(songId);
    void operation.promise.then((value) => { if (live) setTakes(value); })
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
        player.reset(); await practiceApi.deleteTake(take.takeId).promise; invalidateMemory();
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
  if (!owner) return null;
  return <View className='card'><Text className='card-title'>已保存录音</Text>
    {error && <Text className='muted'>{error}</Text>}
    {takes.filter((take) => !(work.mode === 'analyze_only' && take.takeId === work.takeId)).map((take, index) => <View key={take.takeId}>
      <Text>{take.displayName || `录音 ${index + 1}`}</Text>
      <Button disabled={busy || locked} onClick={() => void act(take)}>试听</Button>
      <Button disabled={busy || locked} onClick={() => void act(take, true)}>删除录音及反馈</Button>
    </View>)}
    {!takes.length && <Text className='muted'>还没有保存的录音。</Text>}
  </View>;
}
