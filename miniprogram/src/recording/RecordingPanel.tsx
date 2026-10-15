import { useEffect, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import { useAuth } from '../auth';
import { friendlyError } from '../network';
import { recorder, player, interruptRecording, useRecording } from './runtime';
import { RecordingPrivacy } from './privacy';
import { submission, useSubmission } from './submission';
import type { RecordingSelection } from './controller';
import type { SongProfile } from '../../../shared/songTypes';
import { Feedback } from '../lyrics/Feedback';

export function RecordingPanel({ selection, language, profile }: { selection: RecordingSelection | null; language?: string | null; profile?: SongProfile }) {
  const owner = useAuth().ownerId;
  const recording = useRecording(); const work = useSubmission();
  const [error, setError] = useState(''); const [elapsed, setElapsed] = useState(0);
  const working = ['uploading', 'analyzing', 'cleaning'].includes(work.phase);
  const recordingBusy = ['authorizing', 'preloading', 'countdown', 'starting', 'recording', 'stopping'].includes(recording.phase);
  useDidShow(() => player.setForeground(true));
  useDidHide(() => { interruptRecording('离开页面后录音已中断，请重新录制。'); player.setForeground(false); });
  useEffect(() => () => { interruptRecording('录音页面已关闭，请重新录制。'); player.unlock('recording'); player.reset(); }, []);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - work.startedAtMs) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [working, work.startedAtMs]);
  const labels: Record<string, string> = { idle: '准备录音', authorizing: '等待授权', preloading: '准备伴奏',
    countdown: `${recording.countdown}`, starting: '正在启动录音', recording: '正在录音', stopping: '正在结束录音',
    preview: '录音已就绪', interrupted: '录音已中断', error: '请重试录音' };
  const chinese = language === 'zh' || language === 'zh-CN' || language === 'zh-TW';
  async function preview() {
    const clip = recording.clip; if (!clip || clip.ownerId !== owner) return;
    try { await player.load({ path: clip.filePath, release() {}, onRelease() { return () => {}; } }); player.play(); }
    catch (reason) { setError(friendlyError(reason)); }
  }
  return <View className='card'>
    <Text className='card-title'>{labels[recording.phase]}</Text>
    <Text className='muted'>录音先保存在本机。点击分析后上传至后端 Gemini 服务；仅分析不保留云端录音，保存的录音可删除。录音使用原速伴奏，请佩戴耳机。</Text>
    {(recording.error || error) && <Text className='muted'>{recording.error || error}</Text>}
    {!owner && <Text className='muted'>请回首页微信登录后录音。</Text>}
    {!recordingBusy && <Button disabled={!owner || !selection || working} onClick={() => {
      if (!selection) return; setError(''); void recorder.start(selection).catch((reason) => setError(friendlyError(reason)));
    }}>{recording.clip ? '重新录制' : '准备并录音'}</Button>}
    {recording.phase === 'recording' && <Button onClick={() => recorder.stop()}>结束录音</Button>}
    {recordingBusy && recording.phase !== 'recording' && <Button onClick={() => interruptRecording('已取消录音准备。')}>取消</Button>}
    {(recording.phase === 'error' || recording.phase === 'interrupted') && <Button onClick={() => void Taro.openSetting({})}>麦克风权限设置</Button>}
    {recording.clip && !working && <View>
      <Button onClick={() => void preview()}>试听录音</Button>
      {!chinese && <Button onClick={() => void submission.submit(recording.clip!, 'analyze_only').catch((reason) => setError(friendlyError(reason)))}>仅分析</Button>}
      <Button onClick={() => void submission.submit(recording.clip!, chinese ? 'save_only' : 'save_and_analyze').catch((reason) => setError(friendlyError(reason)))}>{chinese ? '保存录音' : '分析并保存'}</Button>
      <Button onClick={() => { player.reset(); recorder.discard(); }}>丢弃本机录音</Button>
    </View>}
    {working && <Text className='muted'>{work.phase === 'uploading' ? '正在上传录音' : work.phase === 'cleaning' ? '正在清理临时录音' : '正在分析录音'} · 已等待 {elapsed} 秒</Text>}
    {work.error && <Text className='muted'>{work.error}</Text>}
    {work.phase === 'error' && work.takeId && <Button onClick={() => void submission.retry(true)}>重试处理</Button>}
    {work.phase === 'done' && <Text className='card-title'>{work.attempt?.status === 'failed' ? '本次分析未完成，请重新练习。'
      : work.attempt?.status === 'insufficient_data' ? '这次录音证据不足，请重新录制。' : work.mode === 'save_only' ? '录音已保存' : '处理完成，可在练习记忆中查看记录。'}</Text>}
    {work.attempt && <Feedback attempt={work.attempt} profile={profile} />}
    <RecordingPrivacy />
  </View>;
}
