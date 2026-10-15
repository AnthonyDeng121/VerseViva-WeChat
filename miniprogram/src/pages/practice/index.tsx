import { useEffect, useMemo, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import { useDidShow, useRouter } from '@tarojs/taro';
import { apiClient, friendlyError } from '../../network';
import type { TaskRef } from '../../network/api';
import { pendingTasks, songApi, useTask } from '../../network/useTask';
import { useAuth } from '../../auth';
import { SongPractice } from './SongPractice';
import { Feedback } from '../../lyrics/Feedback';
import { Shell } from '../../ui/Shell';
import Taro from '@tarojs/taro';
import { formatTime } from '../../ui/practiceLayout';
const stageLabels: Record<string, string> = {
  analyzing_vocal_parts: 'Gemini 正在核查主唱与次 Vocal', queued: '等待开始', probing_audio: '正在读取音频信息',
  separating_vocals: 'Demucs 正在分离人声', fetching_lyrics: '正在从 LRCLIB 匹配歌词', aligning_lyrics: 'WhisperX 正在对齐歌词',
  analyzing_language: 'Gemini 正在核查语言技巧', building_profile: '正在生成教学标记', completed: '分析完成', failed: '分析失败',
};

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
    if (params.songId) return null;
    if (params.jobId && /^[a-zA-Z0-9_-]+$/.test(params.jobId)) return { kind: 'song', id: params.jobId };
    if (params.takeId && /^[a-zA-Z0-9_-]+$/.test(params.takeId)) return { kind: 'practice', id: params.takeId };
    return restored;
  }, [params.songId, params.jobId, params.takeId, restored]);
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
  if (params.songId && /^song_[a-f0-9]{32}$/.test(params.songId)) return <View className='page'><SongPractice songId={params.songId} initialMode={params.mode === 'sing' ? 'sing' : 'technique'} /></View>;
  return (
    <View className='page'>
      <Shell mode={params.mode === 'sing' ? 'sing' : 'technique'} />
      {!task && <View className='empty-mode-card'>
        <Text className='card-title'>还没有选择歌曲</Text>
        <Text className='muted'>选择歌曲后，在这里查看歌词、区分声部并练习演唱。</Text>
        <Button className='primary-button' onClick={() => Taro.redirectTo({ url: '/pages/index/index' })}>去选择歌曲</Button>
      </View>}
      {task && <View className='status-card'>
        <Text className='card-title'>{cancelled ? '分析已取消' : value ? labels[value.status] : '查看分析进度'}</Text>
        {value && 'queue_position' in value && value.queue_position != null
          && <Text className='muted'>当前排队位次：{value.queue_position}</Text>}
        {value && 'job_id' in value && <>
          <View className='status-line'><Text>{stageLabels[value.stage] ?? '正在处理歌曲'}</Text><Text>{value.progress}%</Text></View>
          <View className='progress-track'><View className='progress-value' style={{ width: `${Math.max(0, Math.min(100, value.progress))}%` }} /></View>
          {!!value.audio_duration_seconds && !!value.estimated_total_seconds && <View className='runtime-summary'>
            <Text>{formatTime(value.audio_duration_seconds)} 音频预计约需 {formatTime(value.estimated_total_seconds)}</Text>
            <Text>已记录外部 API 调用批次 {value.api_call_count ?? 0} 次</Text>
          </View>}
          {value.status === 'failed' && <View className='failure-detail'><Text>分析未完成，请从失败阶段重试。</Text></View>}
          {value.warnings?.map((warning, index) => <View className='warning-detail' key={index}><Text>{stageLabels[warning.stage] ?? '歌曲处理'}阶段存在提示，请复核结果。</Text></View>)}
        </>}
        {value && 'takeId' in value && <Feedback attempt={value} />}
        {value && 'song_id' in value && value.status === 'completed' && <Button className='primary-button'
          onClick={() => Taro.redirectTo({ url: `/pages/practice/index?songId=${value.song_id}&mode=technique` })}>查看技巧分析</Button>}
        {!cancelled && error && <Text className='muted'>{error}</Text>}
        {actionError && <Text className='muted'>{actionError}</Text>}
        {!cancelled && apiClient.currentOwner() && (error || value?.status === 'failed')
          && <Button className='retry-button' disabled={busy} onClick={() => void act('retry')}>从失败处重试</Button>}
        {!cancelled && task.kind === 'song' && apiClient.currentOwner()
          && (!value || value.status === 'processing' || value.status === 'queued')
          && <Button className='text-button' disabled={busy} onClick={() => void act('cancel')}>取消分析</Button>}
      </View>}
    </View>
  );
}
