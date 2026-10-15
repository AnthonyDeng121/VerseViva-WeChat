import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Picker, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useAuth } from '../../auth';
import { songApi } from '../../network/useTask';
import { friendlyError } from '../../network';
import type { SongProfile } from '../../../../shared/songTypes';
import { buildTrackSlotId } from '../../../../shared/audioTimeline';
import type { RecordingSelection } from '../../recording/controller';
import { RecordingPanel } from '../../recording/RecordingPanel';
import { usePlayer, useRecording } from '../../recording/runtime';
import { SavedTakes } from '../../recording/SavedTakes';
import { ReferenceControls, type ReferenceHandle } from '../../audio/ReferenceControls';
import { Lyrics } from '../../lyrics/Lyrics';
import { Shell, type PageMode } from '../../ui/Shell';
import { Disclosure } from '../../ui/Disclosure';
import { rememberSong } from '../../ui/songLibrary';
import { practiceOptions, recordingMode, formatTime } from '../../ui/practiceLayout';

export function SongPractice({ songId, initialMode = 'technique' }: { songId: string; initialMode?: 'technique' | 'sing' }) {
  const owner = useAuth().ownerId; const recording = useRecording(); const playback = usePlayer();
  const [mode, setMode] = useState<PageMode>(initialMode);
  const [latency, setLatency] = useState(0); const [calibrated, setCalibrated] = useState(false);
  const [profile, setProfile] = useState<SongProfile | null>(null);
  const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const [start, setStart] = useState(0); const [end, setEnd] = useState(0);
  const [lane, setLane] = useState<'primary' | 'secondary'>('primary');
  const [purpose, setPurpose] = useState<'guided_practice' | 'free_overdub'>('guided_practice');
  const [reference, setReference] = useState<'source' | 'accompaniment'>('accompaniment');
  const referenceHandle = useRef<ReferenceHandle>(null);
  useEffect(() => {
    let live = true; setProfile(null); setError(''); const operation = songApi.profile(songId);
    void operation.promise.then((value) => { if (live) { setProfile(value); setStart(0); setEnd(0);
      rememberSong(owner, { songId, title: value.title }); } })
      .catch((reason) => { if (live) setError(friendlyError(reason)); });
    return () => { live = false; operation.abort(); };
  }, [songId, owner, revision]);
  useEffect(() => { const next = recordingMode(recording.phase); if (next) setMode(next); }, [recording.phase]);
  const options = useMemo(() => profile ? practiceOptions(profile, lane) : [], [profile, lane]);
  const safeStart = Math.min(start, Math.max(options.length - 1, 0));
  const safeEnd = Math.max(safeStart, Math.min(end, Math.max(options.length - 1, 0)));
  const selection = useMemo<RecordingSelection | null>(() => {
    const selected = options.slice(safeStart, safeEnd + 1); if (!selected.length) return null;
    const ids = [...new Set(selected.flatMap((option) => option.sentenceIds))]; if (!ids.length) return null;
    return { songId, trackSlotId: buildTrackSlotId(lane, ids), sentenceIds: ids,
      selectionType: selected.length === 1 ? 'sentence' : 'segment',
      ...(selected.length === 1 && selected[0].vocalPartId ? { vocalPartId: selected[0].vocalPartId } : {}),
      selectionStartSeconds: selected[0].startSeconds, selectionEndSeconds: selected[selected.length - 1].endSeconds,
      timelineStartSeconds: selected[0].startSeconds, latencyCompensationMs: latency, manualOffsetMs: 0,
      calibrationStatus: calibrated ? 'user_calibrated' : 'unverified', recordingReference: reference, purpose };
  }, [songId, options, safeStart, safeEnd, lane, latency, calibrated, reference, purpose]);
  const busy = !['idle', 'preview', 'error', 'interrupted'].includes(recording.phase);
  function changeMode(next: PageMode) {
    if (next === 'upload') { if (!busy) void Taro.redirectTo({ url: '/pages/index/index' }); }
    else setMode(next);
  }
  const shell = <Shell mode={mode} onModeChange={changeMode} disabled={busy} />;
  if (!profile) return <View>{shell}<View className='status-card'><Text>{error || '正在读取歌曲…'}</Text>
    {error && <Button className='secondary-button' onClick={() => setRevision((value) => value + 1)}>重新加载</Button>}</View></View>;
  const chinese = ['zh', 'zh-CN', 'zh-TW'].includes(profile.language ?? '');
  const activeSentence = profile.sentences.find((sentence) => playback.songTimeSeconds !== null && playback.songTimeSeconds >= sentence.startSeconds && playback.songTimeSeconds < sentence.endSeconds);
  const activeParts = profile.vocalParts.filter((part) => playback.songTimeSeconds !== null && playback.songTimeSeconds >= part.startSeconds && playback.songTimeSeconds < part.endSeconds);
  return <View>
    {shell}
    <View className='profile-card'>
      <ReferenceControls ref={referenceHandle} songId={songId} title={profile.title} selection={selection} technique={mode === 'technique'} />
      <View style={{ display: mode === 'technique' ? 'block' : 'none' }}>
        {recording.phase === 'countdown' && <View className='technique-countdown'><Text className='countdown-number'>{recording.countdown}</Text><Text>准备演唱</Text></View>}
        <Lyrics profile={profile} time={playback.songTimeSeconds} onSeek={(seconds) => { if (!busy) void referenceHandle.current?.seek(seconds); }} />
      </View>
      <View className={mode === 'sing' ? 'recording-page' : 'recording-page hidden'}>
        <View className='singing-focus'>
          <Text className='singing-primary'>{activeParts.find((part) => part.lane === 'primary')?.lyrics.replace(/\s*[（(][^）)]*[）)]/g, '') ?? activeSentence?.lyrics ?? '选择一条音轨开始编辑'}</Text>
          {activeParts.find((part) => part.lane === 'secondary') && <Text className='singing-secondary'>{activeParts.find((part) => part.lane === 'secondary')!.lyrics}</Text>}
        </View>
        <View className='recording-studio'>
          <View className='recording-heading'><Text className='section-title'>选择轨道与演唱范围</Text></View>
          <View className='recording-switch-row'>
            <View className='recording-mode-switch'>{(['primary', 'secondary'] as const).map((value) => <Button key={value} disabled={busy} className={lane === value ? 'active' : ''} onClick={() => { setLane(value); setStart(0); setEnd(0); }}>{value === 'primary' ? '主轨' : '次轨'}</Button>)}</View>
            {!chinese && <View className='recording-mode-switch'>{(['guided_practice', 'free_overdub'] as const).map((value) => <Button key={value} disabled={busy} className={purpose === value ? 'active' : ''} onClick={() => setPurpose(value)}>{value === 'guided_practice' ? '分析' : '纯唱'}</Button>)}</View>}
            <View className='recording-mode-switch'>{(['accompaniment', 'source'] as const).map((value) => <Button key={value} disabled={busy} className={reference === value ? 'active' : ''} onClick={() => setReference(value)}>{value === 'accompaniment' ? '伴奏' : '原唱'}</Button>)}</View>
          </View>
          <Text className='recording-purpose-note'>{chinese ? '中文歌曲无需语言与练唱分析；录音仍可保存为叠录音轨，并参与多轨回放和整体混音。' : purpose === 'guided_practice' ? '两种方式都会保存分析记忆；“仅分析”不会把录音保留为正式音轨。' : '自由选择句子并保存为叠录音轨，不分析，也不计入个人练唱记忆。'}</Text>
          <SavedTakes songId={songId} profile={profile}>
          <View className='recording-selectors'>
            <View><Text>起始句</Text><Picker mode='selector' range={options.map((option, index) => `${index + 1}. ${option.label}`)} value={safeStart} disabled={busy} onChange={(event) => { const value = Number(event.detail.value); setStart(value); if (value > end) setEnd(value); }}><View className='selector-value'>{safeStart + 1}. {options[safeStart]?.label || '无可选歌词'} ▾</View></Picker></View>
            <View><Text>结束句</Text><Picker mode='selector' range={options.slice(safeStart).map((option, index) => `${safeStart + index + 1}. ${option.label}`)} value={safeEnd - safeStart} disabled={busy} onChange={(event) => setEnd(safeStart + Number(event.detail.value))}><View className='selector-value'>{safeEnd + 1}. {options[safeEnd]?.label || '无可选歌词'} ▾</View></Picker></View>
          </View>
          <Text className='recording-selection-summary'>{lane === 'primary' ? '主轨' : '次轨'} · {formatTime(selection?.selectionStartSeconds ?? 0)} – {formatTime(selection?.selectionEndSeconds ?? 0)} · {safeEnd - safeStart + 1} 句</Text>
          {!selection && <Text className='recording-warning'>这首歌没有可练习的当前声部歌词。</Text>}
          <Text className='headphone-note'>建议佩戴耳机，避免伴奏被收录。</Text>
          <RecordingPanel selection={selection} language={profile.language} profile={profile} freeOverdub={purpose === 'free_overdub'} />
          </SavedTakes>
          <Disclosure title='设备延迟校准'><Text className='muted'>设备延迟补偿（毫秒，正值提前）：默认 0，尚未经真机校准。</Text>
            <Input type='number' value={String(latency)} disabled={busy} onInput={(event) => { const value = Number(event.detail.value); if (Number.isFinite(value)) { setLatency(Math.max(-2000, Math.min(2000, value))); setCalibrated(true); } }} />
          </Disclosure>
        </View>
      </View>
    </View>
  </View>;
}
