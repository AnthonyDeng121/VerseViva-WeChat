import { useEffect, useState } from 'react';
import { Button, Slider, Text, View } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import { useAuth } from '../auth';
import { friendlyError } from '../network';
import { recorder, player, interruptRecording, useRecording, usePlayer } from './runtime';
import { RecordingPrivacy } from './privacy';
import { practiceApi, submission, useSubmission, useMemoryRevision } from './submission';
import type { Memory } from '../network/api';
import { formatTime } from '../ui/practiceLayout';
import { estimatePracticeAnalysisSeconds, estimateAnalysisProgress } from '../../../shared/audioTimeline';
import type { RecordingSelection } from './controller';
import type { SongProfile } from '../../../shared/songTypes';
import { Feedback } from '../lyrics/Feedback';

export function RecordingPanel({ selection, language, profile, freeOverdub = false }: { selection: RecordingSelection | null; language?: string | null; profile?: SongProfile; freeOverdub?: boolean }) {
  const owner = useAuth().ownerId;
  const recording = useRecording(); const work = useSubmission();
  const playback = usePlayer(); const revision = useMemoryRevision();
  const [memory, setMemory] = useState<Memory | null>(null);
  useEffect(() => { setMemory(null); if (!owner) return; let live = true;
    const operation = practiceApi.memory(); void operation.promise.then((value) => { if (live) setMemory(value); }).catch(() => {});
    return () => { live = false; operation.abort(); };
  }, [owner, revision]);
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
  const saveOnly = chinese || (recording.clip ? recording.clip.selection.purpose === 'free_overdub' : freeOverdub);
  async function preview() {
    const clip = recording.clip; if (!clip || clip.ownerId !== owner) return;
    try { await player.load({ path: clip.filePath, release() {}, onRelease() { return () => {}; } }); player.play(); }
    catch (reason) { setError(friendlyError(reason)); }
  }
  const estimate = estimatePracticeAnalysisSeconds((selection?.selectionEndSeconds ?? 0) - (selection?.selectionStartSeconds ?? 0), selection?.trackSlotId.startsWith('secondary:') ? 'secondary' : 'primary');
  return <View className='recording-controls'>
    {(recording.error || error) && <Text className='muted'>{recording.error || error}</Text>}
    {!owner && <Text className='muted'>请回首页微信登录后录音。</Text>}
    <View className='recording-actions'>
    {!recordingBusy && !recording.clip && <Button className='primary-button' disabled={!owner || !selection || working} onClick={() => {
      if (!selection) return; setError(''); void recorder.start(selection).catch((reason) => setError(friendlyError(reason)));
    }}>开始录音</Button>}
    {recording.phase === 'recording' && <Button className='record-stop-button' onClick={() => recorder.stop()}>停止录音</Button>}
    {recordingBusy && recording.phase !== 'recording' && <Button onClick={() => interruptRecording('已取消录音准备。')}>取消</Button>}
    {(recording.phase === 'error' || recording.phase === 'interrupted') && <Button onClick={() => void Taro.openSetting({})}>麦克风权限设置</Button>}
    {recording.clip && <>
      {!saveOnly && <Button className='secondary-button' disabled={working} onClick={() => void submission.submit(recording.clip!, 'analyze_only').catch((reason) => setError(friendlyError(reason)))}>{working && work.mode === 'analyze_only' ? '正在分析…' : '仅分析'}</Button>}
      <Button className='primary-button' disabled={working} onClick={() => void submission.submit(recording.clip!, saveOnly ? 'save_only' : 'save_and_analyze').catch((reason) => setError(friendlyError(reason)))}>{working ? '正在处理…' : saveOnly ? '保存清唱叠录' : '分析并保存'}</Button>
      <Button className='secondary-button' disabled={working} onClick={() => { if (selection) void recorder.start(selection).catch((reason) => setError(friendlyError(reason))); }}>重录</Button>
      <Button className='secondary-button cancel-recording-button' disabled={working} onClick={() => { player.reset(); recorder.discard(); }}>取消</Button>
    </>}
    </View>
    {recording.clip && !working && <View className='recording-preview preview-editor'>
      <View className='native-player-row'><Button className='player-toggle' onClick={() => { if (playback.phase === 'playing') player.pause(); else void preview(); }}>▶</Button>
        <Slider className='player-progress' min={0} max={Math.max(recording.clip.durationSeconds, 1)} step={0.1} value={Math.min(playback.timeSeconds, recording.clip.durationSeconds)} disabled={playback.songTimeSeconds !== null || playback.phase === 'idle'} onChange={(event) => void player.seek(event.detail.value).catch(() => {})} />
        <Text>{formatTime(Math.min(playback.timeSeconds, recording.clip.durationSeconds))} / {formatTime(recording.clip.durationSeconds)}</Text></View>
    </View>}
    {recordingBusy && <Text className='recording-live'>{labels[recording.phase]}</Text>}
    {working && <View className='recording-analysis-progress'>
      <Text className='card-title'>{work.mode === 'analyze_only' ? '正在分析练唱录音' : work.mode === 'save_only' ? '正在保存叠录' : '正在分析并保存录音'}</Text>
      <View className='analysis-progress-track'><View style={{ width: `${estimateAnalysisProgress(elapsed, estimate)}%` }} /></View>
      <Text>已等待 {elapsed} 秒 · 预计约 {estimate} 秒（粗略估计）</Text>
    </View>}
    {work.error && <Text className='muted'>{work.error}</Text>}
    {work.phase === 'error' && work.takeId && <Button onClick={() => void submission.retry(true)}>重试处理</Button>}
    {work.phase === 'done' && <Text className='card-title'>{work.attempt?.status === 'failed' ? '本次分析未完成，请重新练习。'
      : work.attempt?.status === 'insufficient_data' ? '这次录音证据不足，请重新录制。' : work.mode === 'save_only' ? '录音已保存' : '处理完成，可在练习记忆中查看记录。'}</Text>}
    {work.attempt && <Feedback attempt={work.attempt} profile={profile} memory={memory} />}
    <Text className='recording-purpose-note'>提交分析或保存会上传录音。AI 分析涉及 Gemini 音频处理及可选 GLM 文字建议。仅分析完成后清理临时音频并保留反馈，中断时可能需重试清理；保存录音可删除。AI 反馈仅供练习参考。</Text>
    <RecordingPrivacy />
  </View>;
}
