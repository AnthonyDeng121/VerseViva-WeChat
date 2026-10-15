import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Picker, Text, View } from '@tarojs/components';
import { useAuth } from '../../auth';
import { songApi } from '../../network/useTask';
import { friendlyError } from '../../network';
import type { SongProfile } from '../../../../shared/songTypes';
import { buildTrackSlotId, lyricsForLane } from '../../../../shared/audioTimeline';
import type { RecordingSelection } from '../../recording/controller';
import { RecordingPanel } from '../../recording/RecordingPanel';
import { player, usePlayer, useRecording } from '../../recording/runtime';
import { SavedTakes } from '../../recording/SavedTakes';
import { ReferenceControls } from '../../audio/ReferenceControls';

export function SongPractice({ songId }: { songId: string }) {
  const owner = useAuth().ownerId; const recording = useRecording();
  const playback = usePlayer();
  const [latency, setLatency] = useState(0); const [calibrated, setCalibrated] = useState(false);
  const [profile, setProfile] = useState<SongProfile | null>(null);
  const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const [start, setStart] = useState(0); const [end, setEnd] = useState(0);
  const [lane, setLane] = useState<'primary' | 'secondary'>('primary');
  useEffect(() => {
    let live = true; setProfile(null); setError(''); const operation = songApi.profile(songId);
    void operation.promise.then((value) => { if (live) { setProfile(value); setStart(0); setEnd(0); } })
      .catch((reason) => { if (live) setError(friendlyError(reason)); });
    return () => { live = false; operation.abort(); };
  }, [songId, owner, revision]);
  const selection = useMemo<RecordingSelection | null>(() => {
    if (!profile || start > end) return null;
    const sentences = profile.sentences.slice(start, end + 1); if (!sentences.length) return null;
    const ids = sentences.map((sentence) => sentence.id);
    const parts = profile.vocalParts.filter((part) => part.lane === 'secondary' && part.sentenceIds.some((id) => ids.includes(id)));
    if (lane === 'secondary' && !parts.length) return null;
    return { songId, trackSlotId: buildTrackSlotId(lane, ids), sentenceIds: ids,
      selectionType: ids.length === 1 ? 'sentence' : 'segment',
      ...(lane === 'secondary' && parts.length === 1 ? { vocalPartId: parts[0].id } : {}),
      selectionStartSeconds: sentences[0].startSeconds,
      selectionEndSeconds: Math.max(sentences[sentences.length - 1].endSeconds,
        ...(lane === 'secondary' ? parts.map((part) => part.endSeconds) : [])),
      timelineStartSeconds: sentences[0].startSeconds, latencyCompensationMs: latency, manualOffsetMs: 0,
      calibrationStatus: calibrated ? 'user_calibrated' : 'unverified' };
  }, [profile, songId, start, end, lane, latency, calibrated]);
  const busy = !['idle', 'preview', 'error', 'interrupted'].includes(recording.phase);
  if (!profile) return <View className='card'><Text>{error || '正在读取歌曲…'}</Text>
    {error && <Button onClick={() => setRevision((value) => value + 1)}>重新加载</Button>}</View>;
  const labels = profile.sentences.map((sentence, index) => `${index + 1}. ${sentence.lyrics}`);
  return <View>
    <Text className='title'>{profile.title}</Text>
    {profile.analysis.lyricsSource === 'asr' && <Text className='muted'>歌词来自自动识别，可能存在较大误差。</Text>}
    <View className='card'>
      <Picker mode='selector' range={labels} value={start} disabled={busy} onChange={(event) => { const value = Number(event.detail.value); setStart(value); if (value > end) setEnd(value); }}><Text>起始句：{start + 1}（点击选择）</Text></Picker>
      <Picker mode='selector' range={labels} value={end} disabled={busy} onChange={(event) => { const value = Number(event.detail.value); setEnd(value); if (value < start) setStart(value); }}><Text>结束句：{end + 1}（点击选择）</Text></Picker>
      <Button disabled={busy} onClick={() => setLane(lane === 'primary' ? 'secondary' : 'primary')}>{lane === 'primary' ? '主唱 · 点击切换次声部' : '次声部 · 点击切换主唱'}</Button>
      {!selection && <Text className='muted'>当前范围没有对应次声部，请选择其他句子或主唱。</Text>}
      <Text className='muted'>设备延迟补偿（毫秒，正值使录音提前）：默认 0，尚未经真机校准。</Text>
      <Input type='number' value={String(latency)} disabled={busy} onInput={(event) => {
        const value = Number(event.detail.value); if (Number.isFinite(value)) { setLatency(Math.max(-2000, Math.min(2000, value))); setCalibrated(true); }
      }} />
      {profile.sentences.slice(start, end + 1).map((sentence) => <View key={sentence.id}
        className={playback.phase === 'playing' && playback.timeSeconds >= sentence.startSeconds && playback.timeSeconds < sentence.endSeconds ? 'lyric-active' : ''}
        onClick={() => { if (!busy && playback.phase !== 'idle') void player.seek(sentence.startSeconds).catch(() => {}); }}>
        <Text className='description'>{lane === 'primary' ? lyricsForLane(sentence.lyrics, lane)
          : profile.vocalParts.filter((part) => part.lane === 'secondary' && part.sentenceIds.includes(sentence.id)).map((part) => part.lyrics).join(' / ') || '本句无次声部'}</Text>
        {lane === 'primary' && sentence.pronunciation && <Text className='muted'>{sentence.pronunciation.text}</Text>}
      </View>)}
    </View>
    <ReferenceControls songId={songId} selection={selection} />
    <RecordingPanel selection={selection} language={profile.language} />
    <SavedTakes songId={songId} />
  </View>;
}
