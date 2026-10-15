import { useEffect, useMemo, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import { useDidShow, useRouter } from '@tarojs/taro';
import { apiClient, friendlyError } from '../../network';
import type { TaskRef } from '../../network/api';
import { pendingTasks, songApi, useTask } from '../../network/useTask';
import { useAuth } from '../../auth';
import { SongPractice } from './SongPractice';
import { Feedback } from '../../lyrics/Feedback';

export default function Practice() {
  const { params } = useRouter();
  const owner = useAuth().ownerId;
  const [restored, setRestored] = useState<TaskRef | null>(null);
  const restore = () => {
    const saved = owner ? pendingTasks.read(owner) : [];
    setRestored(saved[saved.length - 1] ?? null);
  };
  useDidShow(restore);
  useEffect(restore, [owner]);
  const task = useMemo<TaskRef | null>(() => {
    if (params.jobId && /^[a-zA-Z0-9_-]+$/.test(params.jobId)) return { kind: 'song', id: params.jobId };
    if (params.takeId && /^[a-zA-Z0-9_-]+$/.test(params.takeId)) return { kind: 'practice', id: params.takeId };
    return restored;
  }, [params.jobId, params.takeId, restored]);
  const [cancelled, setCancelled] = useState(false);
  const { value, error, interrupted, retry, pause } = useTask(cancelled ? null : task);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(kind: 'retry' | 'cancel') {
    if (!task) return;
    setBusy(true); setActionError('');
    try {
      if (kind === 'cancel') {
        await songApi.cancelSong(task.id).promise;
        pause(); setCancelled(true);
        const owner = apiClient.currentOwner();
        if (owner) pendingTasks.remove(owner, task);
      } else {
        if (interrupted || value?.status === 'failed') {
          if (task.kind === 'song') await songApi.retrySong(task.id).promise;
          else await songApi.startPractice(task.id, true).promise;
        }
        retry();
      }
    } catch (reason) { setActionError(friendlyError(reason)); }
    finally { setBusy(false); }
  }
  const labels: Record<string, string> = { queued: '正在排队', processing: '正在分析',
    completed: '歌曲准备完成', analyzed: '练唱分析完成', failed: '分析未完成',
    insufficient_data: '这次录音的可用证据不足' };
  if (params.songId && /^song_[a-f0-9]{32}$/.test(params.songId)) return <View className='page'><SongPractice songId={params.songId} /></View>;
  return (
    <View className='page'>
      <Text className='title'>逐句练习</Text>
      {!task && <View className='card'>
        <Text className='card-title'>还没有选择歌曲</Text>
        <Text className='muted'>选择歌曲后，在这里查看歌词、区分声部并练习演唱。</Text>
      </View>}
      {task && <View className='card'>
        <Text className='card-title'>{cancelled ? '分析已取消' : value ? labels[value.status] : '查看分析进度'}</Text>
        {value && 'queue_position' in value && value.queue_position != null
          && <Text className='muted'>当前排队位次：{value.queue_position}</Text>}
        {value && 'takeId' in value && <Feedback attempt={value} />}
        {!cancelled && error && <Text className='muted'>{error}</Text>}
        {actionError && <Text className='muted'>{actionError}</Text>}
        {!cancelled && apiClient.currentOwner() && (error || value?.status === 'failed')
          && <Button disabled={busy} onClick={() => void act('retry')}>重试</Button>}
        {!cancelled && task.kind === 'song' && apiClient.currentOwner()
          && (!value || value.status === 'processing' || value.status === 'queued')
          && <Button disabled={busy} onClick={() => void act('cancel')}>取消分析</Button>}
      </View>}
    </View>
  );
}
