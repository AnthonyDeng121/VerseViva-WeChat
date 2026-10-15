import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Slider, Text, View } from '@tarojs/components';
import { MixPanel } from '../audio/MixPanel';
import Taro, { useDidHide } from '@tarojs/taro';
import type { Operation } from '../network/client';
import type { AudioLease } from '../audio/downloads';
import { useAuth } from '../auth';
import { audioResources } from '../audio/resources';
import { friendlyError } from '../network';
import type { Take } from '../network/api';
import type { SongProfile } from '../../../shared/songTypes';
import { lyricsForLane } from '../../../shared/audioTimeline';
import { invalidateMemory, practiceApi, useMemoryRevision, useSubmission } from './submission';
import { player, usePlayer, useRecording } from './runtime';
import { pendingTasks, useTask } from '../network/useTask';
import { Feedback } from '../lyrics/Feedback';
import { formatTime } from '../ui/practiceLayout';

type Patch = { gain?: number; muted?: boolean; manualOffsetMs?: number; displayName?: string };
export function SavedTakes({ songId, profile, children }: { songId: string; profile: SongProfile; children?: ReactNode }) {
  const owner = useAuth().ownerId; const revision = useMemoryRevision(); const work = useSubmission();
  const recording = useRecording(); const playback = usePlayer();
  const [takes, setTakes] = useState<Take[]>([]); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [editing, setEditing] = useState<string | null>(null);
  const [mixOpen, setMixOpen] = useState(false);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const analysis = useTask(analysisId ? { kind: 'practice', id: analysisId } : null);
  const [loadedFor, setLoadedFor] = useState('');
  const generation = useRef(0); const downloading = useRef<Operation<AudioLease> | null>(null);
  const loadedVersion = useRef<number | null>(null);
  const cancel = () => { generation.current += 1; downloading.current?.abort(); downloading.current = null; setBusy(false); };
  useDidHide(() => { cancel(); setMixOpen(false); });
  useEffect(() => { cancel(); setTakes([]); setLoadedFor(''); setEditing(null); setMixOpen(false); setAnalysisId(null); return cancel; }, [songId, owner]);
  const locked = !['idle', 'preview', 'error', 'interrupted'].includes(recording.phase);
  useEffect(() => {
    setError(''); if (!owner) return;
    let live = true; const operation = practiceApi.takes(songId);
    void operation.promise.then((value) => { if (live) { setTakes(value); setLoadedFor(`${songId}:${owner}`); } })
      .catch((reason) => { if (live) setError(friendlyError(reason)); });
    return () => { live = false; operation.abort(); };
  }, [songId, owner, revision]);
  async function act(take: Take, remove = false) {
    cancel(); const current = generation.current; setBusy(true); setError('');
    try {
      if (remove) {
        const answer = await Taro.showModal({ title: '删除录音', content: '将删除这条录音和对应分析反馈，是否继续？' });
        if (!answer.confirm || current !== generation.current) return;
        player.reset(); await practiceApi.deleteTake(take.takeId).promise;
        if (current === generation.current) { setTakes((value) => value.filter((item) => item.takeId !== take.takeId)); invalidateMemory(); }
      } else {
        setEditing(take.takeId); setMixOpen(false);
        downloading.current = audioResources.acquire({ kind: 'take', takeId: take.takeId });
        const lease = await downloading.current.promise;
        if (current !== generation.current) { lease.release(); return; }
        try { await player.load(lease); if (current === generation.current) { loadedVersion.current = player.getVersion(); player.play(); } }
        catch (reason) { lease.release(); throw reason; }
      }
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) { setBusy(false); downloading.current = null; } }
  }
  async function update(take: Take, changes: Patch) {
    cancel(); const current = generation.current; setBusy(true); setError('');
    try { player.reset(); const updated = await practiceApi.updateTake(take.takeId, changes).promise;
      if (current === generation.current) { setTakes((value) => value.map((item) => item.takeId === updated.takeId ? updated : item)); invalidateMemory(); }
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function patch(id: string, changes: Patch, commit: boolean) {
    const take = takes.find((item) => item.takeId === id); if (!take || locked || busy) return;
    if (commit) void update(take, changes);
    else setTakes((items) => items.map((item) => item.takeId === id ? { ...item, ...changes } : item));
  }
  async function analyze(take: Take) {
    cancel(); const current = generation.current; setBusy(true); setError('');
    try { await practiceApi.startPractice(take.takeId, true).promise;
      if (current === generation.current && owner) { pendingTasks.add(owner, { kind: 'practice', id: take.takeId }); setAnalysisId(take.takeId); analysis.retry(); }
    } catch (reason) { if (current === generation.current) setError(friendlyError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  if (!owner) return <View className='recording-takes'>{children}</View>;
  const currentTakes = loadedFor === `${songId}:${owner}` ? takes.filter((take) => take.isCurrent !== false
    && !(work.mode === 'analyze_only' && take.takeId === work.takeId)) : [];
  const take = currentTakes.find((item) => item.takeId === editing);
  const ownsPlayback = loadedVersion.current === player.getVersion();
  function summary(item: Take) {
    return profile.sentences.filter((sentence) => item.sentenceIds?.includes(sentence.id))
      .map((sentence) => lyricsForLane(sentence.lyrics, item.trackSlotId?.startsWith('secondary:') ? 'secondary' : 'primary')).filter(Boolean).join(' / ');
  }
  return <View className='recording-takes'>
    {take && <View className='current-track-editor'>
      <Text className='card-title'>{take.displayName}</Text>
      <View className='native-player-row'><Button className='player-toggle' disabled={busy || locked} onClick={() => {
        if (ownsPlayback && playback.phase === 'playing') player.pause(); else void act(take);
      }}>{ownsPlayback && playback.phase === 'playing' ? 'Ⅱ' : '▶'}</Button>
        <Slider className='player-progress' min={0} max={Math.max(playback.durationSeconds, 1)} value={ownsPlayback ? playback.timeSeconds : 0} step={0.1}
          disabled={locked || busy || !ownsPlayback} onChange={(event) => void player.seek(event.detail.value).catch(() => {})} />
        <Text>{formatTime(ownsPlayback ? playback.timeSeconds : 0)} / {formatTime(ownsPlayback ? playback.durationSeconds : 0)}</Text></View>
      <View className='current-track-mix'>
        <View><Text>人声音量</Text><Slider min={0} max={200} value={Math.round((take.gain ?? 1) * 100)} disabled={busy || locked} onChange={(event) => void update(take, { gain: event.detail.value / 100 })} /></View>
        <View><Text>人声时间 {take.manualOffsetMs ?? 0} ms</Text><Slider min={-2000} max={2000} step={10} value={take.manualOffsetMs ?? 0} disabled={busy || locked} onChange={(event) => void update(take, { manualOffsetMs: event.detail.value })} /></View>
        <Button className={`mute-button ${take.muted ? 'active' : ''}`} disabled={busy || locked} onClick={() => void update(take, { muted: !take.muted })}>{take.muted ? '🔇 取消静音' : '🔊 静音该轨'}</Button>
      </View>
    </View>}
    {children}
    {currentTakes.length > 0 && <View className='take-history-heading'>
      <Text className='section-title'>已保存音轨</Text>
      <View className='take-history-actions'>
        <Button className='primary-button' disabled={busy || locked} onClick={() => { player.reset(); setEditing(null); setMixOpen(true); }}>打开多轨对齐与混音</Button>
        <Button className='secondary-button' disabled={busy || locked} onClick={() => { player.reset(); setMixOpen(true); }}>下载整体混音</Button>
      </View>
    </View>}
    {error && <Text className='recording-error'>{error}</Text>}
    {[...currentTakes].reverse().map((item) => <View className='take-row current' key={item.takeId}>
      <View className='take-details'>
        <Input className='track-name-input' value={item.displayName} maxlength={40} disabled={busy || locked}
          onInput={(event) => setTakes((items) => items.map((t) => t.takeId === item.takeId ? { ...t, displayName: event.detail.value } : t))}
          onBlur={(event) => { const name = event.detail.value.trim(); if (name) void update(item, { displayName: name }); }} />
        <Text className='take-summary'>{formatTime(item.selectionStartSeconds ?? 0)}–{formatTime(item.selectionEndSeconds ?? 0)} · {summary(item)}</Text>
        {item.purpose === 'free_overdub' && <Text className='take-purpose'>清唱叠录 · 不参与分析与记忆</Text>}
      </View>
      <View className='take-inline-controls'>
        <Button className='secondary-button' disabled={busy || locked} onClick={() => void act(item)}>编辑</Button>
        <Button className={`mute-button ${item.muted ? 'active' : ''}`} disabled={busy || locked} onClick={() => void update(item, { muted: !item.muted })}>{item.muted ? '🔇' : '🔊'}</Button>
        {!['zh', 'zh-CN', 'zh-TW'].includes(profile.language ?? '') && item.purpose !== 'free_overdub' && <Button className='secondary-button' disabled={busy || locked || (analysisId === item.takeId && analysis.value?.status === 'processing')} onClick={() => void analyze(item)}>重分析</Button>}
        <Button className='secondary-button' disabled={busy || locked} onClick={() => void act(item, true)}>删除</Button>
      </View>
    </View>)}
    {analysis.error && <Text className='recording-error'>{analysis.error}</Text>}
    {analysis.value && 'takeId' in analysis.value && <Feedback attempt={analysis.value} profile={profile} />}
    {mixOpen && loadedFor === `${songId}:${owner}` && <MixPanel key={`${songId}:${owner}`} songId={songId} owner={owner}
      takes={currentTakes} disabled={busy || locked} onClose={() => { player.reset(); setMixOpen(false); }} onPatch={patch} />}
  </View>;
}
